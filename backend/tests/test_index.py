"""Индекс эффективности: диапазон, пороги, отсутствующие данные, живой расчёт."""
import math
import random

import pytest

from bagdar.index import forecast_index, score
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios


def _raw(passed=50, planned=50, avg=0.0, share=0.3, idle=0.05, conf=0):
    return {"throughput": {"passed": passed, "planned": planned, "window_min": 60},
            "punctuality": {"avg_delay_s": avg}, "track_load": {"share": share},
            "resource_idle": {"share": idle, "window_min": 30}, "conflicts": {"count": conf}}


def test_index_always_within_0_100(cfg):
    rnd = random.Random(1)
    for _ in range(3000):
        raw = _raw(passed=rnd.randint(0, 500), planned=rnd.randint(0, 500), avg=rnd.uniform(0, 10 * 3600),
                   share=rnd.uniform(0, 1.5), idle=rnd.uniform(0, 1.2), conf=rnd.randint(0, 100))
        if rnd.random() < 0.2:
            raw[rnd.choice(list(raw))] = {"missing": "нет данных"}
        r = score(cfg.index, raw)
        assert r["value"] is None or 0.0 <= r["value"] <= 100.0
        for f in r["factors"]:
            assert f["score"] is None or 0.0 <= f["score"] <= 1.0


@pytest.mark.parametrize("passed,status", [(82, "norm"), (75, "norm"), (74, "warning"), (50, "warning"), (49, "critical")])
def test_thresholds(cfg, passed, status):
    only = {k: {"missing": "тест"} for k in ("punctuality", "track_load", "resource_idle", "conflicts")}
    r = score(cfg.index, {"throughput": {"passed": passed, "planned": 100, "window_min": 60}, **only})
    assert r["value"] == pytest.approx(passed) and r["status"] == status


def test_missing_data_is_explicit_and_weights_renormalized(cfg):
    raw = _raw()
    raw["punctuality"] = {"missing": "нет поездов на участке"}
    raw["throughput"] = {"passed": 0, "planned": 0, "window_min": 60}   # по графику ничего не планировалось
    r = score(cfg.index, raw)
    labels = {f["key"]: f for f in r["factors"]}
    assert not labels["punctuality"]["available"] and not labels["throughput"]["available"]
    assert math.isclose(sum(f["weight_eff"] for f in r["factors"] if f["available"]), 1.0, abs_tol=1e-3)
    assert set(r["missing"]) == {"Отклонение от графика", "Пропускная способность"}
    empty = score(cfg.index, {k: {"missing": "нет"} for k in raw})
    assert empty["value"] is None and empty["status"] == "no_data"


def test_reasons_name_the_worst_factor(cfg):
    r = score(cfg.index, _raw(avg=20 * 60))
    assert r["reasons"] and r["reasons"][0].startswith("Отклонение от графика")


def test_live_index_in_range_and_reacts_to_delay(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 1.0
    rt = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    rt.load("normal", 42)
    rt._advance_steps(1800)
    before = rt.index.update(rt.planner.conflicts)
    pax = [x.train.id for x in rt.engine.active() if x.train.pte_rank <= 3]
    for tid in pax[:3]:
        rt.external_event("train_delay", {"train_id": tid, "minutes": 30})
    rt._advance_steps(1200)
    after = rt.index.update(rt.planner.conflicts)
    assert all(p["value"] is None or 0 <= p["value"] <= 100 for p in rt.index.history)
    assert len(rt.index.history) >= 50
    assert after["value"] < before["value"], "задержки должны снижать индекс"
    fc = forecast_index(c.index, rt.engine.world, rt.engine.trains, rt.planner.current, rt.engine.rules, rt.engine.t)
    assert fc["value"] is not None and 0 <= fc["value"] <= 100
