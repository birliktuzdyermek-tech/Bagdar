"""Оркестратор планирования.

1. Эвристика (свежая) и восстановленный прошлый план — за десятки мс.
2. CP-SAT с тёплым стартом от лучшего из них, лимит solver.time_limit_s.
   Если с заморозкой модель недопустима — повтор без заморозки.
3. Каждый кандидат проверяется независимым валидатором. Кандидат с
   нарушением отбрасывается и никогда не выдаётся за допустимый.
4. Публикуется лучший по J (с лексикографическим штрафом слоя 2).
5. Если допустимого плана нет — план удержания: поезда на перегонах
   доходят до ближайшей станции и стоят, статус «план не найден».
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from bagdar.models.plan import Plan, PlanLeg, StartHold
from bagdar.planner.cpsat import CpStats, solve_cpsat
from bagdar.planner.decisions import CardCtx, build_cards
from bagdar.planner.economics import CostBreakdown, override_violations, plan_cost
from bagdar.planner.forward import ForwardResult, run_greedy, run_repair
from bagdar.planner.inputs import PlanningInput
from bagdar.validator import validate_plan

log = logging.getLogger("bagdar.planner")
RESERVE_S = 0.4   # запас бюджета после CP-SAT: проверка кандидатов и карточки решений


@dataclass
class Candidate:
    name: str
    plan: Plan | None
    ms: float
    valid: bool = False
    cost: CostBreakdown | None = None
    violations: list[str] = field(default_factory=list)
    held: list[str] = field(default_factory=list)
    deadlock: bool = False

    def summary(self) -> dict:
        return {"name": self.name, "ms": round(self.ms, 1), "valid": self.valid,
                "J": None if self.cost is None else round(self.cost.total, 1),
                "J_lex": None if self.cost is None else round(self.cost.lex, 1),
                "pte_violations": 0 if self.cost is None else len(self.cost.pte_violations),
                "violations": self.violations[:3], "held": self.held, "deadlock": self.deadlock}


@dataclass
class Variant:
    """Вариант решения уровня C: целый план со своей ценой."""
    id: str
    title: str
    solver: str
    plan: Plan
    cost: CostBreakdown
    valid: bool
    late_pax: int = 0
    note: str = ""

    def public(self, best: CostBreakdown | None) -> dict:
        return {"id": self.id, "title": self.title, "solver": self.solver, "valid": self.valid,
                "J": round(self.cost.total, 1), "J_lex": round(self.cost.lex, 1),
                "delta_money": None if best is None else round(self.cost.total - best.total, 1),
                "pte_violations": len(self.cost.pte_violations), "late_pax": self.late_pax, "note": self.note}


@dataclass
class PlanResult:
    plan: Plan
    status: str                       # feasible | delayed | infeasible
    solver: str
    cost: CostBreakdown | None
    candidates: list[Candidate]
    cp: CpStats
    timings: dict[str, float]
    cards: list[dict]
    t0: float
    reason: str
    late_trains: list[str] = field(default_factory=list)
    card_ctx: dict[str, CardCtx] = field(default_factory=dict)
    variants: dict[str, list[Variant]] = field(default_factory=dict)

    def stats(self) -> dict:
        return {
            "version": self.plan.version, "t0": round(self.t0, 1), "status": self.status, "solver": self.solver,
            "reason": self.reason, "J": None if self.cost is None else self.cost.as_dict(),
            "candidates": [c.summary() for c in self.candidates], "cpsat": self.cp.as_dict(),
            "cp_notes": self.cp.notes[:3], "timings": {k: round(v, 1) for k, v in self.timings.items()},
            "held": self.plan.held, "late_trains": self.late_trains, "cards": len(self.cards),
        }


class Planner:
    def __init__(self, deterministic: bool = False) -> None:
        self.deterministic = deterministic

    def _check(self, inp: PlanningInput, cand: Candidate) -> Candidate:
        if cand.plan is None:
            return cand
        trains = {tid: ti.train for tid, ti in inp.trains.items()}
        blocked = [(sid, a, b) for sid, (a, b) in inp.closed_sections.items()]
        v = validate_plan(inp.world, trains, cand.plan, inp.rules, blocked=blocked, since=inp.t0)
        cand.violations = [x.message for x in v] + override_violations(inp, cand.plan)
        cand.valid = not cand.violations and not cand.deadlock
        cand.cost = plan_cost(inp, cand.plan)
        return cand

    @staticmethod
    def _from_forward(name: str, fr: ForwardResult, ms: float) -> Candidate:
        fr.plan.solver = name
        return Candidate(name=name, plan=fr.plan, ms=ms, held=fr.held, deadlock=fr.deadlock)

    def solve(self, inp: PlanningInput, version: int) -> PlanResult:
        cfg = inp.cfg
        t_all = time.perf_counter()
        timings: dict[str, float] = {}
        cands: list[Candidate] = []

        t = time.perf_counter()
        g = self._check(inp, self._from_forward("greedy", run_greedy(inp), 0.0))
        g.ms = timings["greedy_ms"] = (time.perf_counter() - t) * 1000
        cands.append(g)
        if inp.prev_plan is not None:
            t = time.perf_counter()
            rp = self._check(inp, self._from_forward("repair", run_repair(inp, inp.prev_plan), 0.0))
            rp.ms = timings["repair_ms"] = (time.perf_counter() - t) * 1000
            cands.append(rp)
        heur = [c for c in cands if c.valid]
        ref = min(heur, key=lambda c: c.cost.lex).plan if heur else None

        t = time.perf_counter()
        # общий бюджет пересчёта — solver.time_limit_s: CP-SAT получает остаток после эвристик
        # минус запас на проверку, карточки решений и их оценку (до ~150 мс на 5 карточек)
        spent = time.perf_counter() - t_all
        limit = cfg.solver.time_limit_s if self.deterministic else max(0.4, cfg.solver.time_limit_s - spent - RESERVE_S)
        cp_plan, cp = solve_cpsat(inp, ref, limit, workers=cfg.planner.workers, deterministic=self.deterministic,
                                  use_freeze=True)
        if cp_plan is None and cp.status in ("infeasible", "invalid"):
            left = max(0.3, limit - (time.perf_counter() - t))
            cp_plan, cp2 = solve_cpsat(inp, ref, left, workers=cfg.planner.workers,
                                       deterministic=self.deterministic, use_freeze=False)
            cp2.notes.insert(0, f"с заморозкой: {cp.status}; повтор без заморозки")
            cp = cp2
        timings["cpsat_ms"] = (time.perf_counter() - t) * 1000
        cpc = self._check(inp, Candidate(name="cpsat", plan=cp_plan, ms=timings["cpsat_ms"]))
        cands.append(cpc)
        if cp_plan is not None and not cpc.valid:
            log.warning("CP-SAT plan rejected by validator: %s", cpc.violations[:2])

        valid = [c for c in cands if c.valid]
        if valid:
            best = min(valid, key=lambda c: (c.cost.lex, 0 if c.name == "cpsat" else 1))
            plan = best.plan
            solver = best.name
        else:
            plan = self._hold_plan(inp)
            solver = "hold"
            best = None
        plan.version = version
        plan.created_at = inp.t0
        plan.horizon_end = inp.horizon_end
        plan.solver = solver
        cost = best.cost if best else None
        late = []
        if cost is not None:
            for tid, tc in cost.per_train.items():
                ti = inp.trains[tid]
                if tc.lateness_end_s > ti.tol:
                    late.append(tid)
        if solver == "hold" or (best and best.held and any(
                inp.trains[h].phase in ("station", "pending") for h in best.held) and best.deadlock):
            status = "infeasible"
        elif late or (cost is not None and cost.pte_violations):
            status = "delayed"
        else:
            status = "feasible"
        plan.status = status  # type: ignore[assignment]
        plan.cost = cost.as_dict() if cost else {}
        plan.compute_ms = (time.perf_counter() - t_all) * 1000
        plan.notes = [f"{c.name}: J={c.cost.lex:.0f}" if c.cost else f"{c.name}: нет плана" for c in cands]

        t = time.perf_counter()
        cards: list[dict] = []
        ctx: dict[str, CardCtx] = {}
        variants: dict[str, list[Variant]] = {}
        if solver != "hold":
            try:
                cards, ctx = build_cards(inp, inp.prev_plan, plan, version, cfg.planner.max_cards)
                c_cards = [c for c in cards if c["level"] == "C"]
                if c_cards:
                    # варианты — целые планы, поэтому выбор один на пересчёт: в первой карточке C
                    main = c_cards[0]
                    variants[main["id"]] = self._variants(inp, c_cards, ctx, best, cands)
                    main["variants"] = [v.public(cost) for v in variants[main["id"]]]
                    for c in c_cards[1:]:
                        c["choice_card"] = main["id"]
            except Exception:  # noqa: BLE001 — карточки не должны ронять планирование
                log.exception("decision cards failed")
        else:
            cards = [self._no_plan_card(inp, version, cands)]
        timings["cards_ms"] = (time.perf_counter() - t) * 1000
        timings["total_ms"] = (time.perf_counter() - t_all) * 1000
        return PlanResult(plan=plan, status=status, solver=solver, cost=cost, candidates=cands, cp=cp,
                          timings=timings, cards=cards, t0=inp.t0, reason=inp.reason, late_trains=late,
                          card_ctx=ctx, variants=variants)

    def _late_pax(self, inp: PlanningInput, cost: CostBreakdown) -> int:
        return sum(1 for tid, tc in cost.per_train.items()
                   if inp.trains[tid].rank <= 3 and tc.lateness_end_s > inp.trains[tid].tol)

    def _variants(self, inp: PlanningInput, c_cards: list[dict], ctx: dict[str, CardCtx], best: Candidate | None,
                  cands: list[Candidate]) -> list[Variant]:
        """2–3 варианта: рекомендация, прежний порядок спорной пары, другой допустимый план."""
        out: list[Variant] = []
        if best is not None and best.plan is not None and best.cost is not None:
            out.append(Variant("v1", "Рекомендация Бағдара: " + c_cards[0]["action"], best.name, best.plan,
                               best.cost, True, self._late_pax(inp, best.cost)))
        for card in c_cards:
            cx = ctx.get(card["id"])
            if cx is None or cx.alt_plan is None or len(out) >= 2:
                continue
            alt = self._check(inp, Candidate(name="alt", plan=cx.alt_plan, ms=0.0))
            if alt.cost is not None and alt.valid:
                out.append(Variant(f"v{len(out) + 1}", "Прежний порядок: " + card["alternative"], "greedy",
                                   cx.alt_plan, alt.cost, True, self._late_pax(inp, alt.cost)))
        seen = [v.cost.total for v in out]
        for c in cands:
            if len(out) >= 3:
                break
            if not c.valid or c.cost is None or c.plan is None or (best is not None and c.name == best.name):
                continue
            if any(abs(c.cost.total - j) <= max(1.0, 0.01 * abs(j)) for j in seen):
                continue
            title = {"repair": "Сохранить прежний порядок всех поездов",
                     "greedy": "Другой план: эвристика по классу и весу поездов",
                     "cpsat": "Другой план: решатель CP-SAT"}.get(c.name, c.name)
            out.append(Variant(f"v{len(out) + 1}", title, c.name, c.plan, c.cost, True, self._late_pax(inp, c.cost)))
            seen.append(c.cost.total)
        return out

    def _hold_plan(self, inp: PlanningInput) -> Plan:
        """План удержания: поезда на перегонах доходят до станции, остальные стоят."""
        legs: dict[str, list[PlanLeg]] = {}
        start: dict[str, StartHold] = {}
        for tid, ti in inp.trains.items():
            if ti.phase == "section":
                li = ti.legs[ti.k]
                st = inp.world.stations[li.to_id]
                track = ti.dest_track or next(t.id for t in st.tracks if t.is_main)
                legs[tid] = [PlanLeg(tid, ti.k, li.sec.id, li.from_id, li.to_id, li.d, ti.since,
                                     max(ti.t_arr_est, inp.t0), track, True)]
            elif ti.phase in ("station", "terminal"):
                start[tid] = StartHold(ti.train.route[ti.k], ti.track, ti.since,
                                       until=ti.finish_at if ti.phase == "terminal" else None)
        return Plan(version=0, created_at=inp.t0, solver="hold", status="infeasible", legs=legs, origin_track={},
                    start_hold=start, horizon_end=inp.horizon_end, hold_all=True,
                    held=[tid for tid, ti in inp.trains.items() if ti.phase in ("station", "pending")])

    @staticmethod
    def _no_plan_card(inp: PlanningInput, version: int, cands: list[Candidate]) -> dict:
        why = "; ".join(f"{c.name}: {c.violations[0] if c.violations else ('тупик' if c.deadlock else 'нет решения')}"
                        for c in cands)
        return {
            "id": f"d-{version:04d}-0", "plan_version": version, "t": round(inp.t0, 1), "type": "no_plan",
            "level": "C", "station_id": None, "station": None, "section_id": None, "trains": [],
            "action": "Удержать поезда на станциях до появления допустимого плана",
            "reason": f"На горизонте {round((inp.horizon_end - inp.t0) / 3600)} ч бесконфликтный план не найден ({why})",
            "alternative": "Нет: любой порядок нарушает ограничения безопасности",
            "cost_plan": None, "cost_alt": None, "delta_cost": None, "alt_feasible": False, "wait_min": None,
            "effects": [], "index_before": None, "index_after": None, "status": "applied",
            "impact": None, "variants": [],
        }
