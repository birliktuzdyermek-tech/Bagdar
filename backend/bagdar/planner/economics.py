"""Слой 3: экономика. Вес задержки с множителями и целевая функция плана.

J = Σ w_i · опоздание_i                     (ущерб от задержек, у.е./мин)
  + c_stop · Σ E_stop_i                      (энергия неплановых остановок, E = m·v²/2)
  + c_idle · Σ простой_i                     (локомотив и бригада стоят сверх плана)
  + c_change · число_изменений               (стабильность плана)

Опоздание считается в последней точке плана на горизонте и, для
пассажирских, в каждой плановой остановке (с коэффициентом 0,3).
Энергия хода по фиксированному маршруту на горизонте почти постоянна и
оптимизируется советчиком скорости (этап 5), поэтому в J её нет.
Все цифры условные.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from bagdar.config import BagdarConfig
from bagdar.core.kinematics import stop_energy_kwh
from bagdar.models.plan import Plan, PlanLeg
from bagdar.models.train import Train

if TYPE_CHECKING:
    from bagdar.planner.inputs import PlanningInput

PAX_STOP_FACTOR = 0.3
UPHILL_STOP_FACTOR = 4.0
PTE_PENALTY_PER_MIN = 1000.0   # слой 2 лексикографически выше экономики
PTE_WINDOW_S = 15 * 60         # младший «мешает» старшему, если прошёл перегон не раньше чем за 15 мин
EXTRA_PENALTY = 20000.0        # слой 1: «внеочередной не первым» — за каждый случай


def train_weight(tr: Train, cfg: BagdarConfig, now: float, lateness_s: float) -> tuple[float, list[tuple[str, float]]]:
    """Вес минуты задержки поезда: базовый вес класса × множители (BAGDAR.md, раздел 5)."""
    w = cfg.weight(tr.cls)
    factors: list[tuple[str, float]] = []
    if tr.passengers > 0 and tr.pte_rank <= 3:
        factors.append((f"пассажиров {tr.passengers}", max(0.5, tr.passengers / 500)))
    if tr.transfer and lateness_s >= 60:
        factors.append(("пересадка под угрозой", 1.5))
    if "perishable" in tr.cargo or "urgent" in tr.cargo:
        factors.append(("срочный или скоропортящийся груз", 1.5))
    if "deadline" in tr.cargo:
        factors.append(("истекает срок доставки", 2.0))
    if "dangerous" in tr.cargo:
        factors.append(("опасный груз", 1.3))
    remaining = max(0.0, tr.final_arr - now) + lateness_s
    if tr.crew_shift_end - now < remaining + 3600:
        factors.append((f"у бригады осталось {max(0.0, (tr.crew_shift_end - now) / 3600):.1f} ч", 2.0))
    tol = cfg.tolerance_s(tr.cls)
    if lateness_s > tol:
        steps = math.floor((lateness_s - tol) / 600) + 1
        factors.append((f"уже опаздывает на {round(lateness_s / 60)} мин", 1.2 ** steps))
    for _, m in factors:
        w *= m
    return w, factors


def stop_cost(cfg: BagdarConfig, mass_t: float, v: float, uphill: bool) -> float:
    return cfg.cost.c_stop * stop_energy_kwh(mass_t, v) * (UPHILL_STOP_FACTOR if uphill else 1.0)


@dataclass
class TrainCost:
    lateness_end_s: float = 0.0
    delay: float = 0.0
    stops: float = 0.0
    idle: float = 0.0
    unplanned_stops: int = 0


@dataclass
class CostBreakdown:
    total: float = 0.0
    delay: float = 0.0
    stops: float = 0.0
    idle: float = 0.0
    changes: float = 0.0
    n_changes: int = 0
    pte_excess_s: float = 0.0
    pte_violations: list[tuple[str, str, str, float]] = field(default_factory=list)
    extra_violations: list[tuple[str, str, str]] = field(default_factory=list)
    per_train: dict[str, TrainCost] = field(default_factory=dict)

    @property
    def lex(self) -> float:
        """J с лексикографическим штрафом за нарушения ПТЭ — для сравнения планов."""
        return (self.total + PTE_PENALTY_PER_MIN * self.pte_excess_s / 60
                + EXTRA_PENALTY * len(self.extra_violations))

    def as_dict(self) -> dict[str, float]:
        return {"total": round(self.total, 1), "delay": round(self.delay, 1), "stops": round(self.stops, 1),
                "idle": round(self.idle, 1), "changes": round(self.changes, 1), "n_changes": self.n_changes,
                "pte_violations": len(self.pte_violations), "pte_excess_min": round(self.pte_excess_s / 60, 1)}


def plan_cost(inp: "PlanningInput", plan: Plan) -> CostBreakdown:
    cfg = inp.cfg
    out = CostBreakdown()
    H = plan.horizon_end or 0.0
    for tid, ti in inp.trains.items():
        legs = [lg for lg in plan.legs.get(tid, []) if lg.k >= ti.first_leg()]
        if not legs:
            # поезд не тронулся до конца горизонта: опоздание растёт до конца горизонта
            if H and ti.phase in ("station", "pending"):
                sched = ti.train.schedule[ti.first_leg()].dep
                if sched is not None and sched < H and ti.t_ready < H:
                    tc = TrainCost(lateness_end_s=H - max(sched, inp.t0) + max(0.0, inp.t0 - sched))
                    tc.delay = ti.w * tc.lateness_end_s / 60
                    tc.idle = (H - ti.t_ready) / 60 * cfg.cost.c_idle
                    out.per_train[tid] = tc
                    out.delay += tc.delay
                    out.idle += tc.idle
            continue
        tc = TrainCost()
        for i, lg in enumerate(legs):
            li = ti.legs[lg.k]
            if lg.stop and not li.planned_stop_next:
                tc.stops += stop_cost(cfg, ti.train.mass_t, li.v_cruise, li.uphill_after)
                tc.unplanned_stops += 1
            if li.pax_stop_next and li.sched_arr_next is not None and i < len(legs) - 1:
                tc.delay += PAX_STOP_FACTOR * ti.w * max(0.0, lg.arr - li.sched_arr_next) / 60
            if i + 1 < len(legs):
                wait = legs[i + 1].dep - lg.arr
                if li.planned_stop_next:
                    if not li.pax_stop_next:
                        tc.idle += max(0.0, wait - li.dwell_next - ti.hold_extra * (i == 0)) / 60 * cfg.cost.c_idle
                elif lg.stop:
                    tc.idle += max(0.0, wait - inp.rules.min_stop_s) / 60 * cfg.cost.c_idle
        first = legs[0]
        if ti.phase in ("station", "pending") and first.k == ti.first_leg():
            tc.idle += max(0.0, first.dep - ti.t_ready) / 60 * cfg.cost.c_idle
        last = legs[-1]
        sched = ti.legs[last.k].sched_arr_next
        tc.lateness_end_s = max(0.0, last.arr - sched) if sched is not None else 0.0
        if H and not ti.legs[last.k].last and last.arr < H:
            # дальше плана нет: поезд стоит до конца горизонта
            nxt = ti.legs[last.k + 1] if last.k + 1 < len(ti.legs) else None
            sdep = ti.train.schedule[last.k + 1].dep
            if nxt is not None and sdep is not None and sdep < H and (ti.earliest_dep[last.k + 1] or H) < H:
                tc.lateness_end_s = max(tc.lateness_end_s, H - sdep)
        tc.delay += ti.w * tc.lateness_end_s / 60
        out.per_train[tid] = tc
        out.delay += tc.delay
        out.stops += tc.stops
        out.idle += tc.idle
    if inp.prev_plan is not None:
        out.n_changes = count_changes(inp, inp.prev_plan, plan)
        out.changes = out.n_changes * cfg.cost.c_change
    out.total = out.delay + out.stops + out.idle + out.changes
    if cfg.pte_strict:
        _pte(inp, plan, out)
    _extra(inp, plan, out)
    return out


def _extra(inp: "PlanningInput", plan: Plan, out: CostBreakdown) -> None:
    """Слой 1: внеочередной прошёл перегон не первым (в пределах окна конфликта)."""
    for key, seq in section_sequences(plan, inp.world, inp.entered).items():
        for i, first in enumerate(seq):
            tf = inp.trains.get(first.train_id)
            if tf is None or tf.extra:
                continue
            for second in seq[i + 1:]:
                if second.dep - first.dep > PTE_WINDOW_S:
                    break
                ts = inp.trains.get(second.train_id)
                if ts is not None and ts.extra:
                    out.extra_violations.append((second.train_id, first.train_id, key[0]))


def _pte(inp: "PlanningInput", plan: Plan, out: CostBreakdown) -> None:
    """Слой 2: младший прошёл перегон раньше старшего, а старший вышел за допуск."""
    W = PTE_WINDOW_S
    prev = inp.prev_plan

    def frozen(a: PlanLeg, b: PlanLeg) -> bool:
        # решение по паре закреплено заморозкой прошлого плана — его не пересматривают
        if prev is None:
            return False
        pa, pb = prev.leg(a.train_id, a.k), prev.leg(b.train_id, b.k)
        return pa is not None and pb is not None and min(pa.dep, pb.dep) < inp.freeze_until

    for key, seq in section_sequences(plan, inp.world, inp.entered).items():
        for i, first in enumerate(seq):
            tf = inp.trains.get(first.train_id)
            if tf is None:
                continue
            for second in seq[i + 1:]:
                if second.dep - first.dep > W:
                    break
                ts = inp.trains.get(second.train_id)
                if ts is None or second.train_id == first.train_id or tf.extra or ts.extra or ts.rank >= tf.rank:
                    continue
                if frozen(first, second):
                    continue
                li = ts.legs[second.k]
                if li.sched_arr_next is None:
                    continue
                e = ts.earliest_dep[second.k]
                lb_arr = (e if e is not None else inp.t0) + li.run(True, li.planned_stop_next)
                bound = max(0.0, lb_arr - li.sched_arr_next) + ts.tol
                exc = second.arr - li.sched_arr_next - bound
                if exc > 1:
                    out.pte_excess_s += exc
                    out.pte_violations.append((second.train_id, first.train_id, key[0], exc))


def section_sequences(plan: Plan, world, entered: frozenset[tuple[str, int]]) -> dict[tuple[str, int], list[PlanLeg]]:
    """Очерёдность входа на каждый перегон (без уже вошедших)."""
    seqs: dict[tuple[str, int], list[PlanLeg]] = {}
    for lg in plan.all_legs():
        if (lg.train_id, lg.k) in entered:
            continue
        sec = world.sections[lg.section_id]
        key = (lg.section_id, 0 if sec.tracks == 1 else lg.direction)
        seqs.setdefault(key, []).append(lg)
    for v in seqs.values():
        v.sort(key=lambda x: (x.dep, x.train_id))
    return seqs


def count_changes(inp: "PlanningInput", old: Plan, new: Plan) -> int:
    """Число изменённых решений: перестановки пар на перегонах и смены пути приёма."""
    old_seq = section_sequences(old, inp.world, inp.entered)
    new_seq = section_sequences(new, inp.world, inp.entered)
    n = 0
    for key, nl in new_seq.items():
        ol = old_seq.get(key)
        if not ol:
            continue
        opos = {(x.train_id, x.k): i for i, x in enumerate(ol)}
        common = [(x.train_id, x.k) for x in nl if (x.train_id, x.k) in opos]
        for i in range(len(common)):
            for j in range(i + 1, len(common)):
                if opos[common[i]] > opos[common[j]]:
                    n += 1
    for tid, legs in new.legs.items():
        for lg in legs:
            o = old.leg(tid, lg.k)
            if o is not None and o.track_id != lg.track_id and (tid, lg.k) not in inp.entered:
                n += 1
    return n
