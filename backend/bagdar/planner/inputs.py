"""Снимок состояния участка для планировщика.

Строится в потоке симуляции за миллисекунды и дальше не связан с движком,
поэтому решатель может работать в отдельном потоке.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from bagdar.config import BagdarConfig
from bagdar.core.classes import TRAIN_CLASSES
from bagdar.core.kinematics import effective_accel, effective_vmax, run_time
from bagdar.core.rules import TimingRules
from bagdar.models.plan import Plan
from bagdar.models.train import Train
from bagdar.models.world import Section, World
from bagdar.planner.economics import train_weight


@dataclass(slots=True)
class LegIn:
    k: int
    sec: Section
    d: int
    from_id: str
    to_id: str
    r: tuple[float, float, float, float]   # время хода: индекс = трогание + 2·остановка
    v_cruise: float
    planned_stop_next: bool                 # плановая остановка на to_id или конечная
    last: bool
    dwell_next: float
    sched_arr_next: float | None
    sched_dep_next: float | None
    pax_stop_next: bool                     # пассажирский: отправление не раньше расписания
    uphill_after: bool                      # тяжёлый поезд дальше идёт на подъём (не останавливать)

    def run(self, ss: bool, se: bool) -> float:
        return self.r[int(ss) + 2 * int(se)]


@dataclass
class TrainIn:
    id: str
    train: Train
    w: float
    factors: list[tuple[str, float]]
    tol: float
    extra: bool
    rank: int
    phase: str                      # pending | station | section | terminal
    k: int
    legs: list[LegIn]
    track: str | None = None
    since: float = 0.0
    t_ready: float = 0.0
    t_arr_est: float = 0.0
    stop_end: bool = False
    dest_track: str | None = None
    through_next: bool = False
    arr_route: bool = False         # маршрут приёма уже задан в реальности
    next_dest_track: str | None = None
    hold_extra: float = 0.0
    origin_dep: float = 0.0
    origin_track: str | None = None
    finish_at: float = 0.0
    lateness0: float = 0.0
    earliest_dep: list[float | None] = field(default_factory=list)

    def first_leg(self) -> int:
        return 0 if self.phase == "pending" else self.k


@dataclass
class PlanningInput:
    t0: float
    horizon_end: float
    freeze_until: float
    world: World
    rules: TimingRules
    cfg: BagdarConfig
    trains: dict[str, TrainIn]
    unavailable_tracks: frozenset[str]
    closed_sections: dict[str, tuple[float, float]]
    prev_plan: Plan | None
    entered: frozenset[tuple[str, int]]
    reason: str = ""
    # решения диспетчера (отмена B, выбор C): пара плеч на перегоне → кто идёт первым
    overrides: dict[frozenset, tuple[str, int]] = field(default_factory=dict)

    def fitting_tracks(self, station_id: str, length_m: int, keep: str | None = None) -> list[str]:
        st = self.world.stations[station_id]
        return [t.id for t in st.tracks
                if t.length_m >= length_m and (t.id not in self.unavailable_tracks or t.id == keep)]


def remaining_time(dist: float, v: float, vmax: float, a: float, b: float, stop_end: bool) -> float:
    """Сколько ещё ехать до конца перегона с текущей скорости v."""
    if dist <= 0:
        return 0.0
    v = min(v, vmax)
    da = (vmax * vmax - v * v) / (2 * a)
    ta = (vmax - v) / a
    dd = vmax * vmax / (2 * b) if stop_end else 0.0
    td = vmax / b if stop_end else 0.0
    if da + dd <= dist:
        return ta + td + (dist - da - dd) / vmax
    return dist / max((v + vmax) / 2, 1.0)


def _legs_for(world: World, tr: Train, cfg: BagdarConfig, restrictions: dict[str, float | None],
              margin: float) -> list[LegIn]:
    cls = TRAIN_CLASSES[tr.cls]
    out: list[LegIn] = []
    n = len(tr.route)
    for k, sid in enumerate(tr.sections):
        sec = world.sections[sid]
        u = tr.route[k]
        d = world.direction(sec, u)
        g = sec.gradient_for(d)
        vmax = effective_vmax(cls.vmax_kmh, sec.speed_limit_kmh, g, tr.mass_t, restrictions.get(sid))
        acc = effective_accel(cls.accel, g)
        r = tuple(run_time(sec.length_m, vmax, acc, cls.decel, bool(ss), bool(se)) * (1 + margin)
                  for se in (0, 1) for ss in (0, 1))
        stop = tr.schedule[k + 1]
        last = k + 1 == n - 1
        uphill = False
        if not last:
            nsec = world.sections[tr.sections[k + 1]]
            nd = world.direction(nsec, tr.route[k + 1])
            uphill = nsec.no_stop_uphill and nsec.gradient_for(nd) > 0 and tr.mass_t >= 3000
        out.append(LegIn(
            k=k, sec=sec, d=d, from_id=u, to_id=tr.route[k + 1], r=(r[0], r[1], r[2], r[3]), v_cruise=vmax,
            planned_stop_next=last or stop.stop, last=last, dwell_next=stop.dwell_s if stop.stop else 0.0,
            sched_arr_next=stop.arr, sched_dep_next=stop.dep,
            pax_stop_next=stop.stop and not last and tr.pte_rank <= 3, uphill_after=uphill))
    return out


def build_input(engine, cfg: BagdarConfig, prev_plan: Plan | None, reason: str = "",
                extra_freeze_s: float = 0.0, overrides: dict | None = None) -> PlanningInput:
    """Снимок движка (bagdar.sim.engine.Engine) в момент engine.t.

    extra_freeze_s — сколько секунд модели пройдёт, пока план считается (при ускорении):
    решения на это время тоже замораживаются, иначе план устареет к моменту применения."""
    t0 = engine.t
    rules = engine.rules
    margin = cfg.planner.run_margin
    restrictions = {sid: s.restriction_kmh for sid, s in engine.il.sections.items()}
    closed = {sid: (t0, t0 + 1e7) for sid, s in engine.il.sections.items() if s.status == "closed"}
    unavailable = frozenset(tid for tid, t in engine.il.tracks.items() if not t.available)
    trains: dict[str, TrainIn] = {}
    for tid in engine.order:
        rt = engine.rt[tid]
        tr = rt.train
        if rt.status == "finished":
            continue
        legs = _legs_for(engine.world, tr, cfg, restrictions, margin)
        lateness = engine.live_delay(rt)
        w, factors = train_weight(tr, cfg, t0, lateness)
        ti = TrainIn(id=tid, train=tr, w=w, factors=factors, tol=cfg.tolerance_s(tr.cls),
                     extra=tr.cls == "extraordinary", rank=tr.pte_rank, phase="pending", k=rt.k, legs=legs,
                     lateness0=lateness, hold_extra=getattr(rt, "hold_extra", 0.0))
        plan_leg0 = engine.ex.leg(tid, 0)
        if rt.status == "pending":
            ti.origin_dep = plan_leg0.dep if plan_leg0 else tr.origin_dep
            ti.t_ready = max(t0, ti.origin_dep, rt.ready_at)
            ti.origin_track = engine.ex.plan.origin_track.get(tid) or tr.schedule[0].track_id
            ti.k = 0
        elif rt.status == "station":
            ti.track = rt.track_id
            ti.since = rt.arrived_at
            if rt.k == len(tr.route) - 1:
                ti.phase = "terminal"
                ti.finish_at = rt.finish_at
            else:
                ti.phase = "station"
                ready = max(t0, rt.dwell_until)
                sched = tr.schedule[rt.k]
                if rt.k > 0 and tr.pte_rank <= 3 and sched.stop and sched.dep is not None:
                    ready = max(ready, sched.dep)
                ti.t_ready = ready
        else:
            ti.phase = "section"
            leg = legs[rt.k]
            cls = TRAIN_CLASSES[tr.cls]
            acc = effective_accel(cls.accel, leg.sec.gradient_for(leg.d))
            stop_end = engine._planned_stop(rt, rt.k) or ti.hold_extra > 0
            if rt.through:
                stop_end = False
            ti.stop_end = stop_end
            ti.since = _entry_time(engine, rt)
            ti.t_arr_est = t0 + remaining_time(leg.sec.length_m - rt.dist, rt.v, leg.v_cruise, acc, cls.decel,
                                               stop_end) * (1 + margin)
            ti.dest_track = rt.dest_track
            ti.through_next = rt.through
            ti.arr_route = rt.arr_route
            ti.next_dest_track = rt.next_dest_track
        ti.earliest_dep = _earliest(ti, t0)
        trains[tid] = ti
    return PlanningInput(
        t0=t0, horizon_end=t0 + cfg.solver.horizon_min * 60,
        freeze_until=t0 + max(cfg.solver.freeze_min * 60, extra_freeze_s),
        world=engine.world, rules=rules, cfg=cfg, trains=trains, unavailable_tracks=unavailable,
        closed_sections=closed, prev_plan=prev_plan, entered=frozenset(engine.entered), reason=reason,
        overrides=dict(overrides or {}))


def _entry_time(engine, rt) -> float:
    """Когда поезд вошёл на текущий перегон (по журналу движка или по плану)."""
    t = getattr(rt, "entered_at", None)
    if t is not None:
        return t
    leg = engine.ex.leg(rt.train.id, rt.k)
    return leg.dep if leg else engine.t


def _earliest(ti: TrainIn, t0: float) -> list[float | None]:
    """Самое раннее отправление на каждое плечо без учёта других поездов."""
    n = len(ti.legs)
    out: list[float | None] = [None] * n
    if ti.phase == "terminal":
        return out
    if ti.phase == "section":
        t = ti.t_arr_est
        stopped = ti.stop_end
        k0 = ti.k + 1
        if k0 < n:
            prev = ti.legs[ti.k]
            t += (prev.dwell_next if prev.planned_stop_next else 0.0) + ti.hold_extra
    else:
        t = ti.t_ready
        stopped = True
        k0 = ti.first_leg()
    for k in range(k0, n):
        leg = ti.legs[k]
        out[k] = t
        se = leg.planned_stop_next
        t = t + leg.run(stopped, se)
        if se and not leg.last:
            t += leg.dwell_next
            if leg.pax_stop_next and leg.sched_dep_next is not None:
                t = max(t, leg.sched_dep_next)
        stopped = se
    return out
