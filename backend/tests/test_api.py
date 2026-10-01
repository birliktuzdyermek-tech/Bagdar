import json

import pytest
from fastapi.testclient import TestClient

from bagdar.api import schemas as S
from bagdar.api.app import create_app


@pytest.fixture(scope="module")
def client():
    app = create_app(autostart_loop=False)
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
        msgs = [json.loads(ws.receive_text()) for _ in range(4)]
    assert [m["type"] for m in msgs] == ["hello", "world", "events", "state"]
    hello, state = msgs[0], msgs[3]
    S.StateOut.model_validate(state)
    client.post("/api/sim/control", json={"action": "step", "step_s": 600})
    url = f"/api/stream?world_version={hello['world_version']}&run_id={hello['run_id']}&last_seq={state['seq']}"
    with client.websocket_connect(url) as ws:
        msgs = [json.loads(ws.receive_text()) for _ in range(3)]
    assert [m["type"] for m in msgs] == ["hello", "events", "state"], "мир не пересылается повторно"
    assert msgs[1]["reset"] is False
    assert all(e["seq"] > state["seq"] for e in msgs[1]["events"])
