"""Прогноз конфликтов: что случится, если ничего не перепланировать.

Действующий план сдвигается на текущие отклонения поездов (кто опаздывает
к своей следующей точке — у того сдвигаются все будущие плечи), и
независимый валидатор ищет пересечения на ресурсах. Найденные конфликты
показываются заранее и запускают пересчёт.
"""
from __future__ import annotations

import copy

from bagdar.models.plan import Plan
from bagdar.validator import validate_plan


def deviations(engine, plan: Plan) -> dict[str, float]:
    """Насколько каждый поезд отстаёт от своего плана, с."""
    now = engine.t
    out: dict[str, float] = {}
    for rt in engine.active() + [r for r in engine.rt.values() if r.status == "pending"]:
        tid = rt.train.id
        if rt.status == "section":
            leg = plan.leg(tid, rt.k)
            if leg is None:
                continue
            sec = engine.world.sections[rt.train.sections[rt.k]]
            eta = now + (sec.length_m - rt.dist) / max(rt.v, rt.v_target, 5.0) + rt.hold_extra
            out[tid] = eta - leg.arr
        elif rt.status == "station":
            leg = plan.leg(tid, rt.k)
            if leg is None:
                continue
            out[tid] = max(now, rt.dwell_until) - leg.dep
        else:
            leg = plan.leg(tid, 0)
            if leg is None:
                continue
            out[tid] = max(now, rt.ready_at) - leg.dep
    return out


def _any_entered(plan: Plan, v, entered) -> bool:
    for tid in v.trains:
        for lg in plan.legs.get(tid, []):
            if lg.section_id == v.resource and (tid, lg.k) in entered:
                return True
    return False


def project_conflicts(engine, plan: Plan, horizon_s: float = 3600, limit: int = 12) -> tuple[list[dict], float]:
    """Конфликты действующего плана с учётом отклонений в ближайшие horizon_s секунд."""
    now = engine.t
    dev = deviations(engine, plan)
    shifted = copy.copy(plan)
    shifted.legs = {}
    for tid, legs in plan.legs.items():
        d = max(0.0, dev.get(tid, 0.0))
        if d < 1:
            shifted.legs[tid] = legs
            continue
        out = []
        for lg in legs:
            nl = copy.copy(lg)
            if (tid, lg.k) in engine.entered:
                nl.arr = lg.arr + d          # уже на перегоне: сдвигается только прибытие
            else:
                nl.dep, nl.arr = lg.dep + d, lg.arr + d
            out.append(nl)
        shifted.legs[tid] = out
    trains = engine.trains
    # пары, где хотя бы один поезд уже вошёл на перегон, разрешит блокировка (второй подождёт) —
    # это задержка, а не будущий конфликт; оставляем только пары ещё не начатых плеч
    entered = engine.entered
    violations = [v for v in validate_plan(engine.world, trains, shifted, engine.rules, since=now)
                  if not (v.kind in ("section", "headway") and _any_entered(shifted, v, entered))]
    res: list[dict] = []
    seen: set[tuple] = set()
    for v in sorted(violations, key=lambda x: x.t):
        if v.t > now + horizon_s or v.kind in ("runtime", "dwell"):
            continue
        key = (v.kind, v.resource, tuple(sorted(v.trains)))
        if key in seen:
            continue
        seen.add(key)
        res.append({"kind": v.kind, "resource": v.resource, "trains": v.trains, "t": round(v.t, 1),
                    "in_s": round(v.t - now), "message": v.message})
        if len(res) >= limit:
            break
    worst = max([d for d in dev.values()] or [0.0])
    return res, worst
