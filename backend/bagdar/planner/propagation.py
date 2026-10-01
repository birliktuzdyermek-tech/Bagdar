"""Дерево распространения задержки: кто кого задержал по плану.

Для каждого плеча считается, сколько поезд ждал сверх собственной
возможности (после своего прибытия и плановой стоянки). Ожидание
приписывается поезду, который освободил ресурс прямо перед отправлением:
встречному на однопутном перегоне (или при ПАБ) — по скрещению, попутному —
по межпоездному интервалу. Дерево строится от поезда, с которого началось
возмущение. Атрибуция приближённая, но объяснимая: каждое ребро —
«X ждал Y на станции S N минут».
"""
from __future__ import annotations

from collections import defaultdict

from bagdar.models.plan import Plan, PlanLeg
from bagdar.planner.inputs import PlanningInput

MIN_WAIT_S = 60.0
MATCH_S = 45.0


def wait_edges(inp: PlanningInput, plan: Plan) -> list[tuple[str, str, float, str, float]]:
    """[(виновник, задержанный, ожидание с, станция, когда)]."""
    r = inp.rules
    by_sec: dict[str, list[PlanLeg]] = defaultdict(list)
    for lg in plan.all_legs():
        by_sec[lg.section_id].append(lg)
    out = []
    for tid, legs in plan.legs.items():
        ti = inp.trains.get(tid)
        if ti is None:
            continue
        for i, lg in enumerate(legs):
            if (tid, lg.k) in inp.entered:
                continue
            if i == 0:
                own = ti.t_ready if ti.phase in ("station", "pending") else lg.dep
            else:
                prev = legs[i - 1]
                li = ti.legs[prev.k]
                own = prev.arr + (li.dwell_next if li.planned_stop_next else 0.0)
                if li.pax_stop_next and li.sched_dep_next is not None:
                    own = max(own, li.sched_dep_next)
            wait = lg.dep - own
            if wait < MIN_WAIT_S:
                continue
            sec = inp.world.sections[lg.section_id]
            best = None
            for other in by_sec[lg.section_id]:
                if other.train_id == tid:
                    continue
                opposing = other.direction != lg.direction
                if opposing and sec.tracks == 2:
                    continue                  # на двухпутном встречные друг другу не мешают
                pab = sec.signalling == "PAB" or (sec.id, lg.direction) in inp.pab
                # скрещение или ПАБ — ждал освобождения перегона; попутный при АБ — интервала
                free = other.arr + r.tau_cross_s if (opposing or pab) else other.dep + r.headway_s
                if abs(free - lg.dep) <= MATCH_S and other.dep <= lg.dep:
                    if best is None or abs(free - lg.dep) < best[0]:
                        best = (abs(free - lg.dep), other.train_id)
            if best is not None:
                out.append((best[1], tid, wait, lg.from_id, lg.dep))
    return out


def delay_tree(inp: PlanningInput, plan: Plan, root: str, max_nodes: int = 60) -> dict:
    """Дерево от root: узлы {train_id, number, wait_s, station, children[]} и число задетых."""
    edges = wait_edges(inp, plan)
    children: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    for a, b, w, st, _ in edges:
        children[a].append((b, w, st))
    seen = {root}
    count = 0

    def node(tid: str, wait: float, station: str | None, depth: int) -> dict:
        nonlocal count
        ti = inp.trains.get(tid)
        out = {"train_id": tid, "number": ti.train.number if ti else tid,
               "wait_s": round(wait), "station": inp.world.stations[station].name if station else None,
               "children": []}
        if depth >= 8:
            return out
        for b, w, st in sorted(children.get(tid, []), key=lambda x: -x[1]):
            if b in seen or count >= max_nodes:
                continue
            seen.add(b)
            count += 1
            out["children"].append(node(b, w, st, depth + 1))
        return out

    tree = node(root, 0.0, None, 0)
    total_wait = sum(w for a, b, w, _, _ in edges if b in seen and b != root)
    return {"root": root, "affected": count, "total_wait_min": round(total_wait / 60, 1), "tree": tree}
