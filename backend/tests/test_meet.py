"""«Кто первым?»: цена двух порядков на однопутном перегоне и копия расчёта в витрине."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from bagdar import meet
from bagdar.config import BagdarConfig

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "showcase" / "src" / "meet" / "fixture.json"
sys.path.insert(0, str(ROOT / "showcase" / "tools"))


@pytest.fixture
def cfg() -> BagdarConfig:
    return BagdarConfig()


def _opt(res: dict, oid: str) -> dict:
    return next(o for o in res["options"] if o["id"] == oid)


def _pos(segs: list[dict], t: float) -> float:
    for s in segs:
        if s["t0"] <= t <= s["t1"]:
            dt = s["t1"] - s["t0"]
            if dt <= 0:
                return s["x0"]
            tau = t - s["t0"]
            a = (s["v1"] - s["v0"]) / dt
            sign = 1 if s["x1"] >= s["x0"] else -1
            return s["x0"] + sign * (s["v0"] * tau + a * tau * tau / 2)
    return segs[-1]["x1"] if t > segs[-1]["t1"] else segs[0]["x0"]


def test_usual_day_passenger_first(cfg):
    res = meet.compare(meet.MeetIn(), cfg)
    assert res["winner"] == res["econ_winner"] == "pax_first"
    pf, ff = _opt(res, "pax_first"), _opt(res, "freight_first")
    # грузовой ждёт и останавливается: цена — энергия остановки и простой, опоздания нет (запас 20 мин)
    assert pf["freight"]["stopped"] and not pf["pax"]["stopped"]
    assert pf["cost"]["stop_freight"] > 0 and pf["cost"]["delay_freight"] == 0
    # пропустить грузовой — пассажирский выходит за допуск: нарушение ПТЭ
    assert ff["pte_excess_min"] > 0 and ff["cost"]["pte"] > 0
    assert ff["econ"] > pf["econ"]


def test_planned_stop_and_uphill_make_freight_first(cfg):
    p = meet.MeetIn(pax=meet.PaxIn(cls="passenger", passengers=300, dwell_min=6),
                    freight=meet.FreightIn(mass_t=6000, uphill=True))
    res = meet.compare(p, cfg)
    assert res["winner"] == "freight_first"
    ff = _opt(res, "freight_first")
    assert ff["pax"]["planned_stop"] and ff["cost"]["stop_pax"] == 0 and ff["cost"]["idle_pax"] == 0
    assert ff["pte_excess_min"] == 0
    pf = _opt(res, "pax_first")
    # на подъёме остановка вчетверо дороже
    flat = _opt(meet.compare(meet.MeetIn(pax=p.pax, freight=meet.FreightIn(mass_t=6000)), cfg), "pax_first")
    assert pf["cost"]["stop_freight"] == pytest.approx(4 * flat["cost"]["stop_freight"], rel=1e-3)


def test_pte_beats_money(cfg):
    p = meet.MeetIn(pax=meet.PaxIn(cls="passenger", passengers=40),
                    freight=meet.FreightIn(cargo=["perishable", "urgent"], delay_min=40, slack_min=0))
    res = meet.compare(p, cfg)
    assert res["econ_winner"] == "freight_first"      # по деньгам дешевле пропустить груз
    assert res["winner"] == "pax_first"               # но ПТЭ выше экономики
    cfg.pte_strict = False
    assert meet.compare(p, cfg)["winner"] == "freight_first"


def test_more_passengers_make_waiting_costlier(cfg):
    costs = []
    for n in (100, 500, 1000):
        res = meet.compare(meet.MeetIn(pax=meet.PaxIn(passengers=n, slack_min=0)), cfg)
        costs.append(_opt(res, "freight_first")["cost"]["delay_pax"])
    assert costs[0] < costs[1] < costs[2]


@pytest.mark.parametrize("params", [{}, {"gap_min": 9}, {"gap_min": -12, "section_km": 25},
                                    {"section_km": 4, "pax": {"dwell_min": 6}}])
def test_trains_never_meet_on_single_track(cfg, params):
    """В обоих вариантах поезда не бывают на однопутном перегоне одновременно."""
    res = meet.compare(meet.MeetIn(section_km=params.get("section_km", 12.0), gap_min=params.get("gap_min", 0.0),
                                   pax=meet.PaxIn(**params.get("pax", {}))), cfg)
    L = res["geometry"]["section_m"]
    lp, lf = res["trains"]["pax"]["length_m"], res["trains"]["freight"]["length_m"]
    for o in res["options"]:
        mp, mf = o["motion"]["pax"], o["motion"]["freight"]
        for segs in (mp, mf):
            for a, b in zip(segs, segs[1:]):
                assert a["t1"] == pytest.approx(b["t0"], abs=0.05) and a["x1"] == pytest.approx(b["x0"], abs=0.5)
        t = 0.0
        while t < o["end_t"]:
            xp, xf = _pos(mp, t), _pos(mf, t)
            # на перегоне — любая часть состава между станциями (пассажирский едет к +, грузовой к −)
            pax_on = xp > 0 and xp - lp < L
            fr_on = xf < L and xf + lf > 0
            assert not (pax_on and fr_on), (o["id"], t, xp, xf)
            t += 2.0


def test_fixture_matches_core():
    """showcase/src/meet/fixture.json — ответы этого модуля; витрина сверяется с ним (npm run check:meet)."""
    import meet_fixture
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert [c["name"] for c in data["cases"]] == [c["name"] for c in meet_fixture.cases()]
    for case in data["cases"]:
        assert meet_fixture.compute(case) == case["result"], case["name"]


def test_api_meet():
    from fastapi.testclient import TestClient
    from bagdar.api.app import app
    with TestClient(app) as c:
        r = c.post("/api/meet", json={"freight": {"mass_t": 6000, "uphill": True}, "pax": {"dwell_min": 6}})
        assert r.status_code == 200
        body = r.json()
        assert body["options"][0]["yield"] in ("pax", "freight") and body["winner"] in ("pax_first", "freight_first")
        assert c.post("/api/meet", json={"section_km": 1}).status_code == 422
