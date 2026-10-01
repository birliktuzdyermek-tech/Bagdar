"""Этап 5: советчик скорости и настройки индекса на лету."""
import pytest

from bagdar.config import IndexWeights
from bagdar.energy import V_MIN_KMH, run_energy_kwh
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios


@pytest.fixture(scope="module")
def rt(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 0.5
    r = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    r.load("normal", 42)
    r._advance_steps(1200)
    return r


def _check_limits(rt):
    eng = rt.engine
    seen = 0
    for _ in range(20):
        rt._advance_steps(60)
        for t in rt.state_payload()["trains"]:
            a = t["advice"]
            if not a:
                continue
            seen += 1
            ert = eng.rt[t["id"]]
            sec = eng.world.sections[t["section_id"]]
            limit = min(sec.speed_limit_kmh, ert.train.vmax_kmh)
            r = eng.il.sections[sec.id].restriction_kmh
            if r is not None:
                limit = min(limit, r)
            assert a["v_rec_kmh"] <= a["v_limit_kmh"] <= limit + 0.5, (t["id"], a)
            assert a["v_rec_kmh"] >= min(V_MIN_KMH, a["v_limit_kmh"]) - 0.5
            assert a["e_rec_kwh"] <= a["e_full_kwh"] + 1e-6 and a["saving_kwh"] >= 0
    return seen


def test_recommended_speed_never_above_limit(rt):
    assert _check_limits(rt) > 50
    summary = rt.state_payload()["advice"]
    assert summary["trains"] > 0 and summary["saving_kwh"] >= 0


def test_advice_respects_speed_restriction(rt):
    eng = rt.engine
    busy = {}
    for r in eng.active():
        if r.status == "section":
            busy[r.train.sections[r.k]] = busy.get(r.train.sections[r.k], 0) + 1
    sid = max(busy, key=busy.get)
    rt.external_event("speed_restriction", {"section_id": sid, "kmh": 30, "minutes": 30})
    rt._advance_steps(5)
    on = [t for t in rt.state_payload()["trains"] if t["section_id"] == sid and t["advice"]]
    assert all(t["advice"]["v_rec_kmh"] <= 30 and t["advice"]["v_limit_kmh"] <= 30 for t in on)
    assert _check_limits(rt) > 0


def test_energy_model_is_monotonic():
    assert run_energy_kwh(5000, 15, 10_000) < run_energy_kwh(5000, 25, 10_000)
    assert run_energy_kwh(5000, 20, 0) == 0


def test_settings_change_index_on_the_fly(rt):
    from bagdar.api.schemas import SettingsIn
    before = rt.index.current["value"]
    only_punct = IndexWeights(throughput=0, punctuality=1, track_load=0, resource_idle=0, conflicts=0)
    out = rt.apply_settings(SettingsIn(weights=only_punct))
    cur = rt.index.current
    punct = next(f for f in cur["factors"] if f["key"] == "punctuality")
    assert out["weights"].punctuality == 1 and punct["weight_eff"] == pytest.approx(1.0)
    assert cur["value"] == pytest.approx(100 * punct["score"], abs=0.2)
    with pytest.raises(ValueError):
        rt.apply_settings(SettingsIn(thresholds={"normal": 40, "warning": 60}))
    rt.apply_settings(SettingsIn(reset=True))
    assert rt.cfg.index.weights.throughput == pytest.approx(0.30)
    assert rt.index.current["value"] == pytest.approx(before, abs=15)
