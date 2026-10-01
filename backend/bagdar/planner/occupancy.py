"""Занятость ресурсов по плану и по факту — для диаграммы Ганта и прогноза индекса.

Интервалы путей считаются по тем же правилам слоя 0, что и в валидаторе:
путь приёма перед однопутным перегоном закреплён с отправления, на
двухпутном — с подхода; освобождается после отправления + время на
освобождение горловины (на конечной — после оборота).
"""
from __future__ import annotations

from dataclasses import dataclass

from bagdar.core.rules import TimingRules
from bagdar.models.plan import Plan
from bagdar.models.train import Train
from bagdar.models.world import World


@dataclass(slots=True)
class Busy:
    resource: str
    train_id: str
    t0: float
    t1: float
    kind: str          # stand | pass | section | hold


def plan_occupancy(world: World, trains: dict[str, Train], plan: Plan, rules: TimingRules) -> list[Busy]:
    out: list[Busy] = []
    for tid, sh in plan.start_hold.items():
        legs = plan.legs.get(tid)
        if legs:
            out.append(Busy(sh.track_id, tid, sh.since, legs[0].dep + rules.clear_s, "stand"))
        else:
            end = sh.until if sh.until is not None else (plan.horizon_end or sh.since + 3600)
            out.append(Busy(sh.track_id, tid, sh.since, end, "hold"))
    for tid, legs in plan.legs.items():
        tr = trains.get(tid)
        if tr is None or not legs:
            continue
        first = legs[0]
        if tid not in plan.start_hold and first.k == 0 and tid in plan.origin_track:
            out.append(Busy(plan.origin_track[tid], tid, first.dep - rules.prep_s, first.dep + rules.clear_s, "stand"))
        for i, leg in enumerate(legs):
            sec = world.sections[leg.section_id]
            out.append(Busy(sec.id, tid, leg.dep, leg.arr, "section"))
            h0 = leg.dep if sec.tracks == 1 else leg.arr - rules.approach_s
            if i + 1 < len(legs):
                h1 = legs[i + 1].dep + rules.clear_s
            elif leg.to_id == tr.route[-1]:
                h1 = leg.arr + rules.terminate_s
            else:
                h1 = leg.arr + rules.clear_s
            out.append(Busy(leg.track_id, tid, h0, h1, "stand" if leg.stop else "pass"))
    return out


def fact_occupancy(engine, t_from: float) -> list[Busy]:
    now = engine.t
    out = []
    for res, tid, t0, t1, kind in engine.occ:
        end = now if t1 is None else t1
        if end < t_from:
            continue
        out.append(Busy(res, tid, t0, end, kind))
    return out


def track_load_share(world: World, busy: list[Busy], t: float) -> float:
    tracks = {tr.id for st in world.stations.values() for tr in st.tracks}
    used = {b.resource for b in busy if b.resource in tracks and b.t0 <= t < b.t1}
    return len(used) / max(1, len(tracks))
