import json

import pytest
from fastapi.testclient import TestClient

from bagdar.api import schemas as S
from bagdar.api.app import create_app


@pytest.fixture(scope="module")
def client():
    app = create_app(autostart_loop=False, planner_sync=True)
    with TestClient(app) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_world_and_state_match_contract(client):
    world = S.WorldOut.model_validate(client.get("/api/world").json())
    assert len(world.stations) == 20 and len(world.trains) > 50
    state = S.StateOut.model_validate(client.get("/api/state").json())
    assert state.metrics.active_trains > 0
    S.PlanOut.model_validate(client.get("/api/plan").json())
    S.StreamSchema.model_validate(client.get("/api/stream/schema").json())


def test_controls(client):
    t0 = client.get("/api/state").json()["t"]
    r = client.post("/api/sim/control", json={"action": "step", "step_s": 120}).json()
    assert r["t"] == pytest.approx(t0 + 120)
    assert client.post("/api/sim/control", json={"action": "speed", "speed": 100}).json()["speed"] == 100
    assert client.post("/api/sim/control", json={"action": "speed", "speed": 500}).status_code == 422
    assert client.post("/api/sim/control", json={"action": "start"}).json()["running"] is True
    assert client.post("/api/sim/control", json={"action": "pause"}).json()["running"] is False
    reset = client.post("/api/sim/control", json={"action": "reset"}).json()
    assert reset["t"] == pytest.approx(6 * 3600)


def test_load_new_seed_changes_world(client):
    v0 = client.get("/api/world").json()["version"]
    r = client.post("/api/sim/load", json={"seed": 7}).json()
    assert r["seed"] == 7 and r["world_version"] == v0 + 1
    assert client.post("/api/sim/load", json={"scenario_id": "nope"}).status_code == 404
    client.post("/api/sim/load", json={"scenario_id": "normal"})


def test_stream_initial_and_resume(client):
    with client.websocket_connect("/api/stream") as ws:
        msgs = [json.loads(ws.receive_text()) for _ in range(5)]
    assert [m["type"] for m in msgs] == ["hello", "world", "events", "decisions", "state"]
    hello, state = msgs[0], msgs[4]
    S.StateOut.model_validate(state)
    client.post("/api/sim/control", json={"action": "step", "step_s": 600})
    url = f"/api/stream?world_version={hello['world_version']}&run_id={hello['run_id']}&last_seq={state['seq']}"
    with client.websocket_connect(url) as ws:
        msgs = [json.loads(ws.receive_text()) for _ in range(4)]
    assert [m["type"] for m in msgs] == ["hello", "events", "decisions", "state"], "мир не пересылается повторно"
    assert msgs[1]["reset"] is False
    assert all(e["seq"] > state["seq"] for e in msgs[1]["events"])


def test_stage3_endpoints(client):
    client.post("/api/sim/load", json={"scenario_id": "normal"})
    client.post("/api/sim/control", json={"action": "step", "step_s": 900})
    idx = S.IndexHistoryOut.model_validate(client.get("/api/index").json())
    assert idx.current is not None and 0 <= (idx.current.value or 0) <= 100 and idx.history
    tr = S.TracesOut.model_validate(client.get("/api/traces?since=0").json())
    assert tr.traces and all(len(p) == 2 for t in tr.traces for p in t.points)
    occ = S.OccupancyOut.model_validate(client.get("/api/occupancy?which=current").json())
    assert {b.source for b in occ.items} == {"fact", "plan"}
    S.OccupancyOut.model_validate(client.get("/api/occupancy?which=previous").json())
    S.PlanOut.model_validate(client.get("/api/plan?which=projected").json())
    st = S.StateOut.model_validate(client.get("/api/state").json())
    assert st.index is not None and st.planner.recovery is not None
    off = client.post("/api/autonomy", json={"full_auto": False}).json()
    assert off["full_auto"] is False and client.get("/api/state").json()["planner"]["full_auto"] is False
    assert client.post("/api/autonomy", json={"full_auto": True}).json()["full_auto"] is True
    r = client.post("/api/decisions/d-9999-9/action", json={"action": "cancel"})
    assert r.status_code == 409


def test_stage4_incidents_api(client):
    client.post("/api/sim/load", json={"scenario_id": "normal"})
    client.post("/api/sim/control", json={"action": "step", "step_s": 900})
    world = S.WorldOut.model_validate(client.get("/api/world").json())
    single = next(s.id for s in world.sections if s.tracks == 1)
    events = [
        {"type": "train_delay", "train_class": "passenger_any", "minutes": 12},
        {"type": "section_closed", "section_id": single, "minutes": 20},
        {"type": "signal_fault", "section_id": "s05", "minutes": 20},
        {"type": "switch_fault", "station_id": "st12", "minutes": 20},
        {"type": "speed_restriction", "section_id": "s08", "kmh": 30, "minutes": 20},
        {"type": "add_trains", "count": 2, "within_min": 20},
        {"type": "extra_train", "direction": -1, "in_min": 5},
    ]
    for ev in events:
        r = client.post("/api/events", json=ev)
        assert r.status_code == 200, (ev, r.text)
    # то же событие второй раз: перегон уже закрыт — честный отказ, а не молчание
    assert client.post("/api/events", json=events[1]).status_code == 422
    assert client.post("/api/events", json={"type": "section_closed", "section_id": "nope"}).status_code == 422
    inc = S.IncidentsOut.model_validate(client.get("/api/incidents").json())
    assert [i.kind for i in inc.incidents] == [e["type"] for e in events]
    assert any(t["kind"] == "restore" for t in inc.timeline)           # таймеры восстановления
    assert all(i.after is not None for i in inc.incidents)              # отчёт «до / после» у каждого
    st = S.StateOut.model_validate(client.get("/api/state").json())
    assert {i.kind for i in st.incidents} >= {"section_closed", "signal_fault", "switch_fault", "speed_restriction"}
    cards = S.DecisionsOut.model_validate(client.get("/api/decisions").json()).cards
    assert sum(1 for c in cards if c.type == "incident") >= len(events)
    occ = S.OccupancyOut.model_validate(client.get("/api/occupancy?which=current").json())
    assert any(b.kind == "blocked" and b.source == "fault" for b in occ.items)
    closed = next(i for i in inc.incidents if i.kind == "section_closed")
    assert client.post(f"/api/incidents/{closed.id}/restore").status_code == 200
    assert client.post(f"/api/incidents/{closed.id}/restore").status_code == 409
    delay = next(i for i in inc.incidents if i.kind == "train_delay")
    assert client.post(f"/api/incidents/{delay.id}/restore").status_code == 409   # разовое событие
    sat = S.SaturationOut.model_validate(client.get("/api/saturation").json())
    assert sat.options and sat.best in {o.id for o in sat.options}
