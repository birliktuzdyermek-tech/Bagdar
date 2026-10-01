"""Индекс эффективности участка: формулы раздела 10 BAGDAR.md и эндпоинт /api/index."""
import pytest
from fastapi.testclient import TestClient

from bagdar.api import schemas as S
from bagdar.api.app import create_app
from bagdar.config import load_config
from bagdar.efficiency import compute_index, level_for
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios
from bagdar.sim.events import SimEvent


@pytest.fixture(scope="module")
def runtime():
    r = SimulationRuntime(load_config(), load_scenarios())
    r.load("normal", 42)
    return r


def factors(idx):
    return {f["key"]: f for f in idx["factors"]}


def test_fresh_run_is_normal(runtime):
    idx = compute_index(runtime.engine, runtime.cfg, [])
    S.IndexOut.model_validate(idx)
    assert idx["value"] == pytest.approx(100.0)
    assert idx["level"] == "normal" and idx["drag"] == []
    assert sum(f["weight"] for f in idx["factors"]) == pytest.approx(1.0)
    assert sum(f["points"] for f in idx["factors"]) == pytest.approx(idx["value"], abs=0.2)


def test_levels_follow_thresholds():
    cfg = load_config()
    assert level_for(75, cfg) == "normal"
    assert level_for(74.9, cfg) == "warning"
    assert level_for(50, cfg) == "warning"
    assert level_for(49.9, cfg) == "critical"


def test_conflicts_count_only_last_hour(runtime):
    eng, cfg = runtime.engine, runtime.cfg
    held = lambda t: SimEvent(seq=0, t=t, kind="train_held", severity="info", message="")  # noqa: E731
    recent = [held(eng.t - 60)] * 5
    old = [held(eng.t - 7200)] * 50
    f = factors(compute_index(eng, cfg, recent + old))["conflicts"]
    assert f["data"]["count"] == 5
    assert f["score"] == pytest.approx(1 - 5 / cfg.index.conflicts_max)


def test_waiting_trains_lower_resource_idle(runtime):
    eng, cfg = runtime.engine, runtime.cfg
    act = eng.active()
    saved = [rt.wait_reason for rt in act]
    try:
        for rt in act[: len(act) // 2]:
            rt.wait_reason = "тест"
        idx = compute_index(eng, cfg, [])
        f = factors(idx)["resource_idle"]
        assert f["score"] == pytest.approx(1 - (len(act) // 2) / len(act), abs=1e-3)
        assert "resource_idle" in idx["drag"]
    finally:
        for rt, w in zip(act, saved):
            rt.wait_reason = w


def test_weights_from_config_are_normalised(runtime):
    cfg = runtime.cfg.model_copy(deep=True)
    cfg.index.weights.throughput = 3.0   # сумма весов больше 1
    idx = compute_index(runtime.engine, cfg, [])
    assert sum(f["weight"] for f in idx["factors"]) == pytest.approx(1.0)
    assert 0 <= idx["value"] <= 100


def test_api_index_matches_contract():
    with TestClient(create_app(autostart_loop=False)) as c:
        c.post("/api/sim/control", json={"action": "step", "step_s": 1800})
        body = c.get("/api/index").json()
        idx = S.IndexOut.model_validate(body)
        assert {f.key for f in idx.factors} == {"throughput", "punctuality", "track_load",
                                               "resource_idle", "conflicts"}
        assert idx.t == pytest.approx(c.get("/api/state").json()["t"])
