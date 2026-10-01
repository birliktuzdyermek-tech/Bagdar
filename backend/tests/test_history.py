"""Этап 6: журнал, перемотка, CSV и PDF из живых данных."""
import csv
import io

import pytest

from bagdar.export import csv_events, csv_plan, pdf_report, report_data
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios


@pytest.fixture(scope="module")
def rt(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 0.5
    r = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    r.load("pax_delay", 42)
    r._advance_steps(40 * 60)          # 06:40: в 06:20 по сценарию опоздал скорый
    r._flush_events()
    return r


def test_rewind_15_minutes_consistent(rt):
    h = rt.history_payload()
    assert h["window"]["to"] - h["window"]["from"] >= 15 * 60
    assert h["snapshots"] >= 15 * 6 and h["plans"] >= 2
    target = rt.engine.t - 15 * 60
    past = rt.history_at(target)
    assert target - 10 <= past["t"] <= target
    st = past["state"]
    assert st["t"] == pytest.approx(past["t"], abs=0.5)
    assert all(e["t"] <= past["t"] + 1e-6 for e in past["events"])
    assert all(c["t"] <= past["t"] + 1e-6 for c in past["cards"])
    assert all(p["t"] <= past["t"] + 1e-6 for p in past["index_history"])
    assert past["plan"]["version"] <= rt.planner.current.version
    assert st["index"] is not None and 0 <= st["index"]["value"] <= 100
    # Гант на тот момент: факт не заглядывает в будущее, план — действовавший тогда
    occ = rt.occupancy("current", None, None, at=past["t"])
    assert occ["t"] == pytest.approx(past["t"]) and occ["plan_version"] == past["plan"]["version"]
    assert all(i["t1"] <= past["t"] + 1e-6 for i in occ["items"] if i["source"] == "fact")


def test_history_does_not_change_while_viewing(rt):
    t = rt.engine.t - 10 * 60
    a = rt.history_at(t)
    rt._advance_steps(120)
    rt.external_event("train_delay", {"train_class": "passenger_any", "minutes": 5})
    b = rt.history_at(t)
    assert a["t"] == b["t"] and a["state"] == b["state"] and a["plan"] == b["plan"]


def test_csv_contains_current_scenario(rt):
    rows = list(csv.reader(io.StringIO(csv_events(rt).lstrip("﻿")), delimiter=";"))
    assert rows[0][:4] == ["seq", "время", "t_с", "тип"]
    assert any("Опоздание скорого" in r[5] for r in rows[1:])           # загрузка сценария pax_delay
    assert any(r[3] == "incident" for r in rows[1:])
    last = list(csv.reader(io.StringIO(csv_events(rt, rt.engine.t - 15 * 60, None).lstrip("﻿")), delimiter=";"))
    assert 1 < len(last) < len(rows) and all(float(r[2]) >= rt.engine.t - 15 * 60 - 1 for r in last[1:])
    plan = list(csv.reader(io.StringIO(csv_plan(rt).lstrip("﻿")), delimiter=";"))
    numbers = {tr.number for tr in rt.engine.trains.values()}
    assert len(plan) > 20 and all(r[1] in numbers for r in plan[1:])
    assert all(r[13] == str(rt.planner.current.version) for r in plan[1:])


def test_pdf_contains_current_scenario(rt):
    d = report_data(rt)
    assert d["scenario_id"] == "pax_delay" and d["incidents"] and d["plans"] > 0
    assert any("Опоздание поезда" in i["title"] for i in d["incidents"])
    pdf = pdf_report(rt, rt.engine.t - 15 * 60, None)
    assert pdf[:5] == b"%PDF-" and len(pdf) > 10_000
