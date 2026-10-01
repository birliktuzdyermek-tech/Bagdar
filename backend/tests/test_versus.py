"""Этап 7: «Человек против Бағдара» — один поток дважды, слева без Бағдара."""
import pytest

from bagdar.api import schemas as S
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios


@pytest.fixture(scope="module")
def rt(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 0.5
    r = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    r.load("normal", 42)
    r.versus.start("lock", 42)
    return r


def test_shadow_is_same_flow_without_plan(rt):
    sh = rt.versus.shadow
    assert sh.engine.seed == rt.engine.seed and set(sh.engine.trains) == set(rt.engine.trains)
    assert not sh.engine.ex.plan.legs and not sh.cfg.planner.enabled
    rt._advance_steps(600)
    assert sh.engine.t == pytest.approx(rt.engine.t)
    # событие сценария (06:05, четыре длинных) пришло в обе модели одинаково
    assert len(sh.engine.trains) == len(rt.engine.trains) == len(rt.engine.trains)
    assert [i.kind for i in sh.incidents.items] == [i.kind for i in rt.incidents.items] == ["add_trains"]


def test_events_mirrored_and_human_hold(rt):
    sec = next(s for s in rt.engine.world.sections.values() if s.tracks == 1).id
    rt.external_event("section_closed", {"section_id": sec, "minutes": 20})
    assert rt.versus.shadow.engine.il.sections[sec].status == "closed"
    inc = rt.incidents.items[-1]
    rt.restore_incident(inc.id)
    assert rt.versus.shadow.engine.il.sections[sec].status != "closed"
    tid = next(r.train.id for r in rt.versus.shadow.engine.active() if r.status == "station"
               and r.k < len(r.train.route) - 1)
    msg = rt.versus.hold(tid, 5)
    assert "придержан" in msg and rt.versus.actions[-1]["train_id"] == tid


def test_bagdar_wins_on_lock(rt):
    rt._advance_steps(int(2.5 * 3600))
    p = rt.versus.payload()
    S.VersusOut.model_validate(p)
    left, right = p["left"]["score"], p["right"]["score"]
    assert left["money_total"] > right["money_total"]
    assert left["frozen"] >= right["frozen"]
    assert p["diff"]["money"] == pytest.approx(left["money_total"] - right["money_total"], abs=0.2)
    # другой мир — соревнование останавливается
    rt.load("normal", 42)
    assert not rt.versus.active and rt.versus.payload() == {"active": False}
