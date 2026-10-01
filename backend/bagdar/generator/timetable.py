"""Построение исходного бесконфликтного графика движения.

Поезда вставляются по одному в таблицу резервирования ресурсов в порядке
очерёдности (класс по ПТЭ, затем желаемое время). Для каждого поезда ищется
самая ранняя нитка, которая не конфликтует с уже вставленными по всем
ресурсам: перегонам, путям станций и горловинам. Если поезду приходится
ждать на станции, где он шёл без остановки, нитка пересчитывается с
неплановой остановкой (торможение и разгон). Результат — план версии 0.
"""
from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field

from bagdar.core.classes import TRAIN_CLASSES
from bagdar.core.kinematics import effective_accel, effective_vmax, run_time
from bagdar.core.rules import TimingRules
from bagdar.generator.trains_gen import TrainSpec
from bagdar.models.plan import Plan, PlanLeg
from bagdar.models.train import ScheduleStop, Train
from bagdar.models.world import Section, Station, World

Interval = tuple[float, float, str]


def interval_retry(items: list[Interval], t0: float, t1: float, gap: float = 0.0) -> float | None:
    """None, если [t0, t1] свободен; иначе самое раннее начало, с которого стоит повторить."""
    retry = None
    for a, b, _ in items:
        if t0 < b + gap and a < t1 + gap:
            cand = b + gap
            retry = cand if retry is None or cand > retry else retry
    return retry


@dataclass(slots=True)
class SecRes:
    train_id: str
    direction: int
    t_in: float
    t_out: float


class ReservationTable:
    def __init__(self, world: World, rules: TimingRules) -> None:
        self.world = world
        self.r = rules
        self.sec: dict[str, list[SecRes]] = defaultdict(list)
        self.trk: dict[str, list[Interval]] = defaultdict(list)
        self.thr: dict[str, list[Interval]] = defaultdict(list)

    def section_retry(self, sec: Section, d: int, t_in: float, t_out: float) -> float | None:
        r = self.r
        retry: float | None = None
        for res in self.sec[sec.id]:
            if sec.tracks == 2 and res.direction != d:
                continue  # двухпутный: встречные на разных путях
            if res.direction != d or sec.signalling == "PAB":
                # встречные на однопутном или любой поезд при ПАБ — взаимное исключение
                if t_in < res.t_out + r.tau_cross_s and res.t_in < t_out + r.tau_cross_s:
                    cand = res.t_out + r.tau_cross_s
                    retry = cand if retry is None or cand > retry else retry
                continue
            # попутные при АБ: интервал на входе и на выходе, без обгона на перегоне
            run = t_out - t_in
            if res.t_in <= t_in:
                need_in = res.t_in + r.headway_s
                need_out = res.t_out + r.headway_arr_s
                if t_in < need_in or t_out < need_out:
                    cand = max(need_in, need_out - run)
                    retry = cand if retry is None or cand > retry else retry
            else:
                if t_in + r.headway_s > res.t_in or t_out + r.headway_arr_s > res.t_out:
                    cand = max(res.t_in + r.headway_s, res.t_out + r.headway_arr_s - run)
                    retry = cand if retry is None or cand > retry else retry
        return retry

    def pick_track(self, station: Station, length_m: int, h0: float, h1: float,
                   prefer_main: bool, preferred: str | None = None,
                   exclude: set[str] | frozenset[str] = frozenset()) -> tuple[str | None, float | None]:
        fitting = [t for t in station.tracks if t.length_m >= length_m and t.id not in exclude]
        if not fitting:
            return None, None
        fitting.sort(key=lambda t: (0 if t.id == preferred else 1, 0 if t.is_main == prefer_main else 1, t.length_m))
        best_retry: float | None = None
        for t in fitting:
            r = interval_retry(self.trk[t.id], h0, h1)
            if r is None:
                return t.id, None
            best_retry = r if best_retry is None or r < best_retry else best_retry
        return None, best_retry

    def track_free(self, track_id: str, h0: float, h1: float) -> bool:
        return interval_retry(self.trk[track_id], h0, h1) is None


@dataclass
class _Attempt:
    kind: str                                 # ok | shift | force_stop | impossible
    retry: float = 0.0
    station_idx: int = -1
    legs: list[PlanLeg] = field(default_factory=list)
    origin_track: str = ""
    holds: list[Interval] = field(default_factory=list)    # (h0, h1, track_id)
    throats: list[Interval] = field(default_factory=list)  # (a, b, throat_id)
    secs: list[tuple[str, SecRes]] = field(default_factory=list)


@dataclass
class TimetableResult:
    trains: list[Train]
    plan: Plan
    dropped: list[str]
    build_ms: float


class TimetableBuilder:
    MAX_SHIFT_S = 3 * 3600

    def __init__(self, world: World, rules: TimingRules) -> None:
        self.world = world
        self.r = rules
        self.table = ReservationTable(world, rules)

    # --- кинематика плеча ---
    def _leg_params(self, spec: TrainSpec) -> list[tuple[Section, int, float, float, float]]:
        cls = TRAIN_CLASSES[spec.cls]
        out = []
        for u, v in zip(spec.route, spec.route[1:]):
            sec = self.world.section_between(u, v)
            d = self.world.direction(sec, u)
            g = sec.gradient_for(d)
            vmax = effective_vmax(cls.vmax_kmh, sec.speed_limit_kmh, g, spec.mass_t)
            out.append((sec, d, vmax, effective_accel(cls.accel, g), cls.decel))
        return out

    def _run(self, leg: tuple[Section, int, float, float, float], stop_start: bool, stop_end: bool) -> float:
        sec, _, vmax, acc, dec = leg
        return run_time(sec.length_m, vmax, acc, dec, stop_start, stop_end) * (1 + self.r.recovery_margin)

    # --- поиск нитки ---
    def _try(self, spec: TrainSpec, t_dep0: float, forced: set[int],
             legp: list[tuple[Section, int, float, float, float]]) -> _Attempt:
        r, tb, w = self.r, self.table, self.world
        route = spec.route
        n = len(route)
        att = _Attempt(kind="ok")
        st0 = w.stations[route[0]]
        cur_h0 = t_dep0 - r.prep_s
        trk0, retry = tb.pick_track(st0, spec.length_m, cur_h0, t_dep0 + r.clear_s, prefer_main=False)
        if trk0 is None:
            if retry is None:
                return _Attempt(kind="impossible")
            return _Attempt(kind="shift", retry=max(t_dep0 + 60, retry + r.prep_s))
        cur_track = trk0
        att.origin_track = trk0
        t_ready = t_dep0
        stopped = True
        for k in range(n - 1):
            sec, d, _, _, _ = legp[k]
            nxt = w.stations[route[k + 1]]
            last = k + 1 == n - 1
            planned_stop = (k + 1) in spec.dwell
            stop_end = last or planned_stop or (k + 1) in forced
            dwell_next = spec.dwell.get(k + 1, r.min_stop_s if (k + 1) in forced else 0.0)
            single = sec.tracks == 1
            run = self._run(legp[k], stopped, stop_end)
            dep_thr = sec.departure_throat(d)
            arr_thr = sec.arrival_throat(d)
            prefer_main = not stop_end or (TRAIN_CLASSES[spec.cls].pte_rank <= 3 and not last)
            t = t_ready
            limit = t_ready + r.max_wait_s
            while True:
                if t > limit:
                    return _Attempt(kind="shift", retry=t_dep0 + 300)
                t_in, t_out = t, t + run
                rr = tb.section_retry(sec, d, t_in, t_out)
                if rr is not None:
                    t = max(t + 1, rr)
                    continue
                dw0, dw1 = (t_in, t_in + r.throat_s) if stopped else (t_in - r.approach_s, t_in + r.throat_s)
                rr = interval_retry(tb.thr[dep_thr], dw0, dw1)
                if rr is not None:
                    t = max(t + 1, t + (rr - dw0))
                    continue
                aw0, aw1 = t_out - r.approach_s, t_out
                rr = interval_retry(tb.thr[arr_thr], aw0, aw1)
                if rr is not None:
                    t = max(t + 1, t + (rr - aw0))
                    continue
                h0n = r.track_hold_start(single, t_in, t_out)
                h1n = t_out + (r.terminate_s if last else (dwell_next if stop_end else 0.0)) + r.clear_s
                trk, rr = tb.pick_track(nxt, spec.length_m, h0n, h1n, prefer_main)
                if trk is None:
                    if rr is None:
                        return _Attempt(kind="impossible")
                    t = max(t + 30, t + (rr - h0n))
                    continue
                if not tb.track_free(cur_track, cur_h0, t_in + r.clear_s):
                    cur_st = w.stations[route[k]]
                    alt, _ = tb.pick_track(cur_st, spec.length_m, cur_h0, t_in + r.clear_s, prefer_main=False)
                    if alt is None:
                        return _Attempt(kind="shift", retry=t_dep0 + 180)
                    cur_track = alt
                    if att.legs:
                        att.legs[-1].track_id = alt
                    else:
                        att.origin_track = alt
                break
            if not stopped and t > t_ready + 0.5:
                return _Attempt(kind="force_stop", station_idx=k)
            att.legs.append(PlanLeg(train_id=spec.id, k=k, section_id=sec.id, from_id=route[k],
                                    to_id=route[k + 1], direction=d, dep=t_in, arr=t_out,
                                    track_id=trk, stop=stop_end))
            att.holds.append((cur_h0, t_in + r.clear_s, cur_track))
            att.throats.append((dw0, dw1, dep_thr))
            att.throats.append((aw0, aw1, arr_thr))
            att.secs.append((sec.id, SecRes(spec.id, d, t_in, t_out)))
            cur_track, cur_h0 = trk, h0n
            stopped = stop_end
            t_ready = t_out + (dwell_next if (stop_end and not last) else 0.0)
        att.holds.append((cur_h0, att.legs[-1].arr + r.terminate_s, cur_track))
        return att

    def _commit(self, att: _Attempt) -> None:
        tb = self.table
        for h0, h1, trk in att.holds:
            tb.trk[trk].append((h0, h1, att.legs[0].train_id))
        for a, b, th in att.throats:
            tb.thr[th].append((a, b, att.legs[0].train_id))
        for sid, res in att.secs:
            tb.sec[sid].append(res)

    def insert(self, spec: TrainSpec) -> _Attempt | None:
        legp = self._leg_params(spec)
        t_dep0 = spec.desired_dep
        forced: set[int] = set()
        for _ in range(400):
            att = self._try(spec, t_dep0, forced, legp)
            if att.kind == "ok":
                self._commit(att)
                return att
            if att.kind == "impossible":
                return None
            if att.kind == "force_stop":
                forced.add(att.station_idx)
                continue
            t_dep0 = max(t_dep0 + 60, att.retry)
            forced = set()
            if t_dep0 - spec.desired_dep > (900 if spec.fixed_time else self.MAX_SHIFT_S):
                return None
        return None

    def build(self, specs: list[TrainSpec], plan_created_at: float = 0.0) -> TimetableResult:
        started = time.perf_counter()
        order = sorted(specs, key=lambda s: (not s.fixed_time, TRAIN_CLASSES[s.cls].pte_rank, s.desired_dep, s.id))
        trains: list[Train] = []
        legs: dict[str, list[PlanLeg]] = {}
        origin_track: dict[str, str] = {}
        dropped: list[str] = []
        for spec in order:
            att = self.insert(spec)
            if att is None:
                dropped.append(spec.number)
                continue
            legs[spec.id] = att.legs
            origin_track[spec.id] = att.origin_track
            trains.append(self._make_train(spec, att))
        trains.sort(key=lambda t: (t.origin_dep, t.id))
        ms = (time.perf_counter() - started) * 1000
        plan = Plan(version=0, created_at=plan_created_at, solver="timetable", status="feasible",
                    legs=legs, origin_track=origin_track, compute_ms=ms,
                    notes=[f"Исходный график: {len(trains)} поездов"] +
                          ([f"Не вошли в график: {', '.join(dropped)}"] if dropped else []))
        return TimetableResult(trains=trains, plan=plan, dropped=dropped, build_ms=ms)

    def _make_train(self, spec: TrainSpec, att: _Attempt) -> Train:
        cls = TRAIN_CLASSES[spec.cls]
        sched: list[ScheduleStop] = [ScheduleStop(spec.route[0], None, att.legs[0].dep, True, 0.0, att.origin_track)]
        for i in range(1, len(spec.route)):
            prev = att.legs[i - 1]
            nxt = att.legs[i] if i < len(att.legs) else None
            sched.append(ScheduleStop(
                station_id=spec.route[i], arr=prev.arr, dep=nxt.dep if nxt else None,
                stop=prev.stop, dwell_s=spec.dwell.get(i, self.r.min_stop_s if prev.stop and nxt else 0.0),
                track_id=prev.track_id))
        return Train(
            id=spec.id, number=spec.number, cls=spec.cls, pte_rank=cls.pte_rank, direction=spec.direction,
            length_m=spec.length_m, mass_t=spec.mass_t, passengers=spec.passengers, cargo=list(spec.cargo),
            traction=spec.traction, vmax_kmh=cls.vmax_kmh, accel=cls.accel, decel=cls.decel,
            loco_id=spec.loco_id, crew_id=spec.crew_id,
            crew_shift_end=att.legs[0].dep + spec.crew_hours * 3600,
            route=list(spec.route), sections=[leg.section_id for leg in att.legs], schedule=sched,
            suburban=spec.suburban, transfer=spec.transfer)
