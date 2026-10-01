"""Планировщик: CP-SAT, эвристика, валидация, приоритеты, карточки, запасные варианты."""
import copy

import pytest

from bagdar.core.rules import TimingRules
from bagdar.generator.timetable import TimetableBuilder
from bagdar.generator.trains_gen import TrainSpec, generate_traffic
from bagdar.generator.world_gen import generate_world
from bagdar.planner import service as service_mod
from bagdar.planner.economics import plan_cost
from bagdar.planner.inputs import build_input
from bagdar.planner.service import Planner
from bagdar.sim.engine import Engine
from bagdar.validator import validate_plan

from conftest import START, build


@pytest.fixture(scope="module")
def fast_cfg(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 1.0
    return c


def _engine(cfg, seed=42, advance=1500):
    world, tt = build(seed, cfg)
    eng = Engine(world, tt.trains, tt.plan, cfg, seed, START)
    eng.advance(advance)
    return eng, tt


def _solve(eng, cfg, prev, version=1, reason="тест"):
    inp = build_input(eng, cfg, prev, reason)
    return inp, Planner(deterministic=True).solve(inp, version)


def _valid(eng, inp, plan):
    return validate_plan(eng.world, eng.trains, plan, eng.rules, since=inp.t0)


def test_plan_is_valid_and_not_worse_than_heuristics(fast_cfg):
    eng, tt = _engine(fast_cfg)
    inp, res = _solve(eng, fast_cfg, tt.plan)
    assert res.status in ("feasible", "delayed")
    assert _valid(eng, inp, res.plan) == []
    heur = [c.cost.lex for c in res.candidates if c.name != "cpsat" and c.valid]
    assert res.cost.lex <= min(heur) + 1e-6
    assert res.timings["total_ms"] > 0


def test_two_trains_claim_one_single_track_section(fast_cfg):
    eng, tt = _engine(fast_cfg, advance=1200)
    now = eng.t
    single = {s.id for s in eng.world.sections.values() if s.tracks == 1}
    legs = [lg for lg in tt.plan.all_legs() if lg.section_id in single and now + 600 < lg.dep < now + 4000]
    pair = None
    for a in legs:
        for b in legs:
            if a.section_id == b.section_id and a.direction != b.direction and 0 < b.dep - a.arr < 900:
                pair = (a, b)
                break
        if pair:
            break
    assert pair, "в графике нет встречной пары"
    a, b = pair
    rt = eng.rt[a.train_id]
    shift = b.dep - a.dep + 120   # первый теперь опоздает так, что окна пересекутся
    if rt.status == "pending":
        rt.ready_at += shift
    elif rt.status == "station":
        rt.dwell_until = max(rt.dwell_until, eng.t) + shift
    else:
        rt.hold_extra += shift
    inp, res = _solve(eng, fast_cfg, tt.plan)
    assert _valid(eng, inp, res.plan) == []
    la, lb = res.plan.leg(a.train_id, a.k), res.plan.leg(b.train_id, b.k)
    assert la is not None and lb is not None
    tau = eng.rules.tau_cross_s
    assert la.arr + tau <= lb.dep + 0.5 or lb.arr + tau <= la.dep + 0.5, "перегон занят встречными одновременно"


def test_long_train_never_on_short_track_and_throats_free(fast_cfg):
    eng, tt = _engine(fast_cfg)
    inp, res = _solve(eng, fast_cfg, tt.plan)
    for tid, legs in res.plan.legs.items():
        for lg in legs:
            track = eng.world.stations[lg.to_id].track(lg.track_id)
            assert track.length_m >= eng.trains[tid].length_m
    kinds = {v.kind for v in _valid(eng, inp, res.plan)}
    assert "throat" not in kinds and "track_length" not in kinds


def test_extraordinary_train_goes_first(fast_cfg):
    rules = TimingRules.from_config(fast_cfg.sim)
    world = generate_world("light", 42)
    specs = generate_traffic(world, 42)
    line = [s.id for s in sorted(world.stations.values(), key=lambda s: s.km)]
    specs.append(TrainSpec(id="t9001", number="9001", cls="extraordinary", direction=1, route=line,
                           desired_dep=START + 900, dwell={}, length_m=300, mass_t=900, passengers=0, cargo=[],
                           traction="diesel", loco_id="TE33A-9001", crew_id="Б-9001", crew_hours=10,
                           fixed_time=True))
    tt = TimetableBuilder(world, rules).build(specs)
    eng = Engine(world, tt.trains, tt.plan, fast_cfg, 42, START)
    eng.advance(600)
    eng.inject_delay("t9001", 900)   # внеочередной задержан и теперь мешает графику
    inp, res = _solve(eng, fast_cfg, tt.plan)
    assert _valid(eng, inp, res.plan) == []
    cost = plan_cost(inp, res.plan)
    # слой 1: ни один ещё не отправленный поезд не прошёл общий перегон раньше внеочередного
    assert cost.extra_violations == [], cost.extra_violations[:3]
    # и внеочередной почти не теряет времени: только на ресурсы, уже занятые в момент расчёта
    tc = cost.per_train["t9001"]
    assert tc.lateness_end_s <= 900 + 180, f"внеочередной потерял {round((tc.lateness_end_s - 900) / 60)} мин"


def test_strict_pte_senior_not_delayed_beyond_tolerance(cfg):
    # детерминированный режим с бюджетом, при котором решатель успевает (≈6 с)
    cfg = cfg.model_copy(deep=True)
    cfg.solver.time_limit_s = 6.0
    eng, tt = _engine(cfg)
    # задерживаем грузовой на станции — он начинает мешать поездам старших классов
    rt = next(r for r in eng.active() if r.status == "station" and r.train.pte_rank == 5
              and r.k < len(r.train.route) - 3)
    rt.dwell_until = max(rt.dwell_until, eng.t) + 600
    inp, res = _solve(eng, cfg, tt.plan)
    assert _valid(eng, inp, res.plan) == []
    cost = plan_cost(inp, res.plan)
    on_time_seniors = {tid for tid, ti in inp.trains.items() if ti.rank <= 4 and ti.lateness0 < 30}
    bad = [v for v in cost.pte_violations if v[0] in on_time_seniors]
    assert bad == [], f"старший поезд задержан младшим сверх допуска: {bad[:3]}"


def test_delay_changes_plan_and_produces_cards(fast_cfg):
    eng, tt = _engine(fast_cfg)
    inp1, r1 = _solve(eng, fast_cfg, tt.plan, 1)
    eng.apply_plan(r1.plan)
    eng.advance(300)
    pax = next(rt for rt in eng.active() if rt.train.pte_rank <= 3 and rt.status in ("station", "section")
               and rt.k < len(rt.train.route) - 2)
    leg_before = r1.plan.leg(pax.train.id, pax.k + 1)
    eng.inject_delay(pax.train.id, 15 * 60, "тест")
    inp2, r2 = _solve(eng, fast_cfg, r1.plan, 2)
    assert _valid(eng, inp2, r2.plan) == []
    leg_after = r2.plan.leg(pax.train.id, pax.k + 1)
    assert leg_before is not None and leg_after is not None
    assert leg_after.dep >= leg_before.dep + 10 * 60, "задержка не отразилась в плане"
    assert plan_cost(inp2, r2.plan).n_changes > 0 or r2.cards
    for c in r2.cards:
        assert c["action"] and c["reason"] and c["alternative"]
        assert c["level"] in ("A", "B", "C")
        assert c["delta_cost"] is None or isinstance(c["delta_cost"], float)


def test_fallback_to_heuristic_then_hold(fast_cfg, monkeypatch):
    eng, tt = _engine(fast_cfg)
    real = service_mod.solve_cpsat

    def broken(*a, **k):
        plan, st = real(*a, **k)
        st.status = "unknown"
        return None, st

    monkeypatch.setattr(service_mod, "solve_cpsat", broken)
    inp, res = _solve(eng, fast_cfg, tt.plan)
    assert res.solver in ("greedy", "repair", "fifo") and _valid(eng, inp, res.plan) == []

    # теперь валидатор отвергает всё: должен получиться честный план удержания
    class _V:
        message = "искусственное нарушение"

    monkeypatch.setattr(service_mod, "validate_plan", lambda *a, **k: [_V()])
    inp, res = _solve(eng, fast_cfg, tt.plan)
    assert res.solver == "hold" and res.status == "infeasible" and res.plan.hold_all
    assert res.cards and res.cards[0]["type"] == "no_plan"
    eng.apply_plan(res.plan)
    station = [rt for rt in eng.active() if rt.status == "station" and rt.k < len(rt.train.route) - 1]
    eng.advance(600)
    moved = [rt for rt in station if rt.status != "station"]
    assert not moved, "при отсутствии плана поезда должны стоять на станциях"


def test_replan_time_is_measured_and_bounded(fast_cfg):
    eng, tt = _engine(fast_cfg)
    inp = build_input(eng, fast_cfg, tt.plan, "время")
    res = Planner(deterministic=False).solve(inp, 1)   # реальный режим: лимит по часам
    t = res.timings
    assert t["greedy_ms"] < 1000
    assert t["total_ms"] < (fast_cfg.solver.time_limit_s * 1000) * 2 + 1500
    assert res.cp.build_ms > 0 and res.cp.solve_ms > 0


def test_planner_deterministic_for_same_seed(fast_cfg):
    def run():
        eng, tt = _engine(fast_cfg)
        eng.inject_delay(next(rt.train.id for rt in eng.active() if rt.status == "station"
                              and rt.k < len(rt.train.route) - 1), 600)
        _, res = _solve(eng, fast_cfg, tt.plan)
        return [(lg.train_id, lg.k, round(lg.dep), round(lg.arr), lg.track_id) for lg in res.plan.all_legs()]

    assert run() == run()


def test_heuristic_stress_always_valid(cfg):
    """Эвристика на 4 seed × 8 моментов со случайными задержками: ни одного конфликта и тупика."""
    import random

    from bagdar.planner.forward import run_greedy, run_repair
    for seed in (42, 7, 1, 2026):
        eng, tt = _engine(cfg, seed=seed, advance=0)
        rnd = random.Random(seed)
        for _ in range(8):
            eng.advance(900)
            st = [rt for rt in eng.active() if rt.status == "station" and rt.k < len(rt.train.route) - 1]
            if st:
                rt = rnd.choice(st)
                rt.dwell_until = max(rt.dwell_until, eng.t) + rnd.choice([300, 600, 900])
            inp = build_input(eng, cfg, tt.plan, "стресс")
            for fr in (run_greedy(inp), run_repair(inp, tt.plan)):
                assert not fr.deadlock
                assert _valid(eng, inp, fr.plan) == []


def test_published_plan_always_passes_validator(fast_cfg):
    import random
    for seed in (7, 2026):
        eng, tt = _engine(fast_cfg, seed=seed, advance=1200)
        rnd = random.Random(seed)
        prev = tt.plan
        for v in range(1, 3):
            st = [rt for rt in eng.active() if rt.status == "station" and rt.k < len(rt.train.route) - 1]
            eng.inject_delay(rnd.choice(st).train.id, rnd.choice([600, 900]))
            inp, res = _solve(eng, fast_cfg, prev, v)
            assert res.solver != "hold"
            assert _valid(eng, inp, res.plan) == []
            eng.apply_plan(res.plan)
            prev = res.plan
            eng.advance(600)
