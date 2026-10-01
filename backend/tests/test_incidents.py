"""Этап 4: сбои и перепланирование «до / после», обязательные сценарии и первая волна."""
import shutil

import pytest

from bagdar.config import parse_hhmm
from bagdar.incidents import KINDS
from bagdar.planner.service import blocked_of
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import SCENARIOS_DIR, load_scenarios
from bagdar.validator import validate_plan

MANDATORY = {"pax_delay", "infra_faults", "closure", "surge"}
WAVE1 = {"lock", "butterfly", "saturation"}


def _rt(cfg, scenario: str, warm_s: int = 0) -> SimulationRuntime:
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 1.0
    r = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    r.load(scenario, 42)
    if warm_s:
        r._advance_steps(warm_s)
    return r


def _check(rt):
    """Последний план — допустим по независимому валидатору с учётом закрытий, путей и ПАБ."""
    res = rt.planner.last
    inp = res.inp
    return res, validate_plan(inp.world, rt.engine.trains, res.plan, inp.rules, blocked=blocked_of(inp),
                              since=inp.t0, pab=inp.pab)


def _card(rt, inc_id):
    return next(c for c in rt.planner.cards if c.get("incident_id") == inc_id)


def _busy_section(rt, single=True):
    """Перегон, по которому в ближайший час по плану пройдёт больше всего поездов."""
    eng = rt.engine
    cnt: dict[str, int] = {}
    for lg in rt.planner.current.all_legs():
        if eng.t + 300 < lg.dep < eng.t + 3600 and (not single or eng.world.sections[lg.section_id].tracks == 1):
            cnt[lg.section_id] = cnt.get(lg.section_id, 0) + 1
    return max(cnt, key=cnt.get)


# ------------------------------------------------------------------ сценарии как данные
def test_scenarios_are_data_files():
    sc = load_scenarios()
    assert MANDATORY | WAVE1 <= set(sc)
    for sid in MANDATORY | WAVE1:
        assert sc[sid].disruptions, sid
        for d in sc[sid].disruptions:
            assert d.type in KINDS, (sid, d.type)
            assert parse_hhmm(d.at) >= parse_hhmm(sc[sid].start_time)


def test_new_scenario_without_code(tmp_path, cfg):
    """Новый сценарий — это только файл: сеть, график, сбои по времени и seed."""
    for p in SCENARIOS_DIR.glob("*.yaml"):
        shutil.copy(p, tmp_path / p.name)
    (tmp_path / "my_case.yaml").write_text(
        "id: my_case\ntitle: Свой кейс\nsummary: проверка\nmode: light\nseed: 7\nstart_time: \"06:00\"\n"
        "disruptions:\n"
        "  - {at: \"06:03\", type: speed_restriction, params: {section_id: s05, kmh: 25, minutes: 20}}\n"
        "  - {at: \"06:04\", type: extra_train, params: {direction: -1, in_min: 3}}\n", encoding="utf-8")
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 0.5
    rt = SimulationRuntime(c, load_scenarios(tmp_path), planner_sync=True)
    rt.load("my_case")
    assert rt.engine.seed == 7
    n0 = len(rt.engine.trains)
    rt._advance_steps(5 * 60)
    kinds = [(i.kind, i.source) for i in rt.incidents.items]
    assert kinds == [("speed_restriction", "scenario"), ("extra_train", "scenario")]
    assert rt.engine.il.sections["s05"].restriction_kmh == 25
    assert len(rt.engine.trains) == n0 + 1


# ------------------------------------------------------------------ «Замок»
def _run_frozen(cfg, planner: bool, hours: int = 3):
    """Прогон «Замка»: какие поезда простояли на одном месте не меньше часа к концу прогона."""
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 1.0
    c.planner.enabled = planner
    rt = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    rt.load("lock", 42)
    eng = rt.engine
    pos: dict[str, tuple] = {}
    for _ in range(hours * 60):
        rt._advance_steps(60)
        for r in eng.rt.values():
            key = (r.status, r.k)
            if pos.get(r.train.id, (None,))[0] != key:
                pos[r.train.id] = (key, eng.t)
    act = [r for r in eng.active() if r.k < len(r.train.route) - 1]
    frozen = [r.train.id for r in act if eng.t - pos[r.train.id][1] >= 3600]
    return rt, frozen


def test_lock_scenario_has_no_deadlock(cfg):
    # без Бағдара (поезда по расписанию, защищает только СЦБ) участок запирается
    _, frozen_off = _run_frozen(cfg, planner=False)
    assert len(frozen_off) >= 4, frozen_off
    # с Бағдаром — никто не стоит на месте час, длинные составы в плане и едут
    rt, frozen_on = _run_frozen(cfg, planner=True)
    assert frozen_on == [], frozen_on
    eng = rt.engine
    inc = rt.incidents.items[0]
    assert inc.kind == "add_trains" and inc.source == "scenario" and len(inc.train_ids) == 4
    long_ids = inc.train_ids
    assert all(eng.trains[t].length_m > 1000 for t in long_ids)
    assert all(eng.rt[t].status == "done" or eng.rt[t].k >= 3 for t in long_ids)
    res, viol = _check(rt)
    assert not viol, viol[:3]
    pending_or_running = [t for t in long_ids if eng.rt[t].status != "done"]
    assert all(t in res.plan.legs for t in pending_or_running)   # в плане, а не «вне плана»
    rep = _card(rt, inc.id)["report"]
    assert rep["plan"]["J_lex"] < rep["fifo"]["J_lex"]


# ------------------------------------------------------------------ инфраструктура
@pytest.fixture(scope="module")
def rtn(cfg):
    return _rt(cfg, "normal", 1800)


def test_closure_respected_and_auto_restored(rtn):
    rt, eng = rtn, rtn.engine
    sid = _busy_section(rt)
    rt.external_event("section_closed", {"section_id": sid, "minutes": 30})
    inc = rt.incidents.items[-1]
    assert inc.level == "C" and eng.il.sections[sid].status == "closed"
    res, viol = _check(rt)
    assert res.status == "infeasible" or not viol, viol[:3]
    assert res.solver != "hold"
    started = {(tid, k) for tid, k in res.inp.entered}
    for lg in res.plan.all_legs():
        if lg.section_id == sid and (lg.train_id, lg.k) not in started:
            assert lg.dep >= inc.until - 1, f"{lg.train_id} отправлен на закрытый перегон"
    card = _card(rt, inc.id)
    assert {"before", "plan", "no_change", "fifo"} <= set(card["report"])
    assert ".." not in card["reason"] and card["reason"][0].isupper()
    assert "восстановится" in card["reason"] or card["report"]["plan"]["recovery_at"] is None
    # таймер снимает закрытие сам
    rt._advance_steps(31 * 60)
    assert inc.status == "resolved" and eng.il.sections[sid].status != "closed"
    rt._flush_events()
    assert any(e["kind"] == "incident_resolved" for e in rt.events_since(0, min_severity="info"))


def test_closure_unknown_duration(rtn):
    rt, eng = rtn, rtn.engine
    sid = _busy_section(rt)
    rt.external_event("section_closed", {"section_id": sid, "minutes": "unknown"})
    inc = rt.incidents.items[-1]
    assert inc.until is None and eng.il.sections[sid].closed_until is None
    res, viol = _check(rt)
    started = set(res.inp.entered)
    assert not any(lg.section_id == sid and (lg.train_id, lg.k) not in started for lg in res.plan.all_legs())
    assert res.status == "infeasible" or not viol
    rt.restore_incident(inc.id)
    assert eng.il.sections[sid].status != "closed"
    with pytest.raises(ValueError):
        rt.restore_incident(inc.id)                     # второй раз снять нельзя


def test_track_block_gives_valid_plan_or_honest_not_found(rtn):
    rt, eng = rtn, rtn.engine
    busy = sorted(eng.world.stations.values(), key=lambda s: -sum(
        1 for lg in rt.planner.current.all_legs() if lg.to_id == s.id and eng.t < lg.arr < eng.t + 3600))
    st = next(s for s in busy if any(not t.is_main for t in s.tracks))
    rt.external_event("track_unavailable", {"station_id": st.id, "minutes": 40})
    inc = rt.incidents.items[-1]
    trk = inc.resource
    assert not eng.il.tracks[trk].available
    res, viol = _check(rt)
    if res.solver == "hold":
        no_plan = next(c for c in reversed(rt.planner.cards) if c["type"] == "no_plan")
        assert res.status == "infeasible" and "не найден" in no_plan["reason"]
    else:
        assert not viol, viol[:3]
        # новые прибытия на недоступный путь не планируются
        for tid, legs in res.plan.legs.items():
            for lg in legs:
                if (tid, lg.k) not in res.inp.entered and lg.dep > res.t0 + 1:
                    assert lg.track_id != trk, f"{tid} принят на недоступный путь"
    rt.restore_incident(inc.id)
    assert eng.il.tracks[trk].available


def test_signal_fault_works_like_pab(rtn):
    rt, eng = rtn, rtn.engine
    sid = _busy_section(rt, single=False)
    rt.external_event("signal_fault", {"section_id": sid, "minutes": 40})
    inc = rt.incidents.items[-1]
    sec_rt = eng.il.sections[sid]
    assert sec_rt.restriction_kmh == 40 and sec_rt.status == "restricted"
    res, viol = _check(rt)                              # валидатор проверяет «попутные по одному»
    assert res.inp.pab and all(s == sid for s, _ in res.inp.pab)
    assert res.status == "infeasible" or not viol, viol[:3]
    for d in (1, -1):
        legs = sorted((lg for lg in res.plan.all_legs() if lg.section_id == sid and lg.direction == d
                       and (sid, d) in res.inp.pab and lg.dep > res.t0), key=lambda lg: lg.dep)
        for a, b in zip(legs, legs[1:]):
            assert b.dep >= a.arr - 1, f"попутные {a.train_id} и {b.train_id} одновременно на перегоне при ПАБ"
    rt.restore_incident(inc.id)
    assert sec_rt.restriction_kmh is None and not sec_rt.limits


def test_surge_adds_and_plans_trains(rtn):
    rt, eng = rtn, rtn.engine
    n0, v0 = len(eng.trains), rt.world_version
    rt.external_event("add_trains", {"count": 3, "within_min": 20})
    inc = rt.incidents.items[-1]
    assert len(eng.trains) == n0 + 3 and rt.world_version == v0 + 1
    assert len(set(t.number for t in eng.trains.values())) == len(eng.trains)   # номера не повторяются
    res, viol = _check(rt)
    miss = [(t, t in res.inp.trains, eng.rt[t].status) for t in inc.train_ids if t not in res.plan.legs]
    assert not miss, (miss, res.solver, res.status, res.plan.version, rt.planner.version, rt.planner.proposal)
    assert res.status == "infeasible" or not viol, viol[:3]
    assert _card(rt, inc.id)["report"]["plan"]["affected"] is not None


def test_pax_delay_card_has_before_after_and_tree(rtn):
    rt = rtn
    rt.external_event("train_delay", {"train_class": "passenger_any", "minutes": 15})
    inc = rt.incidents.items[-1]
    assert inc.level == "B"
    card = _card(rt, inc.id)
    rep = card["report"]
    assert rep["before"]["plan_version"] < card["plan_version"]
    assert rep["tree"]["root"] == inc.train_ids[0] and rep["tree"]["tree"]["train_id"] == inc.train_ids[0]
    assert rep["fifo"]["J_lex"] is not None and rep["plan"]["J_lex"] is not None
    assert rep["plan"]["J_lex"] <= rep["fifo"]["J_lex"] + 1
    assert inc.status == "done"


# ------------------------------------------------------------------ таймлайн и насыщение
def test_scenario_timeline_applies_disruptions_in_time(cfg):
    rt = _rt(cfg, "infra_faults")
    eng = rt.engine
    assert rt.state_payload()["scenario_next"] is not None
    rt._advance_steps(int(parse_hhmm("06:16") - eng.t))
    inc = rt.incidents.items[0]
    assert inc.kind == "signal_fault" and inc.source == "scenario" and inc.t >= parse_hhmm("06:15")
    rt._advance_steps(int(parse_hhmm("06:36") - eng.t))
    assert [i.kind for i in rt.incidents.items] == ["signal_fault", "switch_fault"]
    rt._advance_steps(int(parse_hhmm("06:56") - eng.t))
    assert inc.status == "resolved"                     # 40 мин неисправности истекли в 06:55
    assert len(rt.incidents.items) == 3
    res, viol = _check(rt)
    assert res.status == "infeasible" or not viol, viol[:3]


def test_saturation_radar_and_metering(cfg):
    rt = _rt(cfg, "saturation", 3600 + 1800)
    radar = rt.index.radar
    assert radar["status"] in ("ok", "warning", "critical") and radar["delay_slope_min_h"] is not None
    sat = rt.saturation_payload()
    opts = sat["options"]
    assert [o["hold"] for o in opts][:1] == [0] and len(opts) >= 2
    best = next(o for o in opts if o["id"] == sat["best"])
    assert best["J_lex"] == min(o["J_lex"] for o in opts)
    held = next((o for o in opts if o["hold"] > 0), None)
    if held is not None:
        n_inc = len(rt.incidents.items)
        rt.external_event("hold_at_origin", {"train_ids": held["train_ids"], "minutes": held["minutes"]})
        assert len(rt.incidents.items) == n_inc + 1 and rt.incidents.items[-1].kind == "hold_at_origin"
