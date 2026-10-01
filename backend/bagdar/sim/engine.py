"""Движок симуляции с фиксированным шагом времени.

Шаг модели (dt) не зависит от частоты кадров и ускорения: ускорение ×100
означает только, что за реальную секунду выполняется больше шагов.
Случайные отклонения (затянутые стоянки, позднее отправление) берутся из
генератора с seed, поэтому одинаковый seed и одинаковые внешние события
дают одинаковый прогон.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from bagdar.config import BagdarConfig
from bagdar.core.kinematics import effective_accel, effective_vmax, stop_energy_kwh
from bagdar.core.rules import TimingRules
from bagdar.models.plan import Plan
from bagdar.models.train import Train
from bagdar.models.world import Section, World
from bagdar.sim.events import SimEvent
from bagdar.sim.executor import PlanExecutor
from bagdar.sim.interlocking import POS_INF, Interlocking


def hhmm(t: float) -> str:
    t = int(round(t)) % 86400
    return f"{t // 3600:02d}:{(t % 3600) // 60:02d}"


@dataclass(slots=True)
class TrainRT:
    train: Train
    status: str = "pending"          # pending | station | section | finished
    k: int = 0                       # индекс станции (station) или плеча (section)
    track_id: str | None = None
    dist: float = 0.0                # м от начала перегона по ходу поезда
    v: float = 0.0                   # м/с
    v_target: float = 0.0
    dest_track: str | None = None    # путь приёма на route[k+1], закреплён
    arr_route: bool = False          # маршрут приёма задан (горловина)
    through: bool = False            # разрешение на безостановочный проход route[k+1]
    next_dest_track: str | None = None
    arrived_at: float = 0.0
    dwell_until: float = 0.0
    ready_at: float = 0.0
    finish_at: float = 0.0
    rec_delay_s: float = 0.0         # опоздание в последней контрольной точке
    delay_level: int = 0
    wait_reason: str | None = None
    wait_since: float | None = None
    held_reported: bool = False
    stops: int = 0
    unplanned_stops: int = 0
    stop_energy_kwh: float = 0.0
    v_peak: float = 0.0
    entered_at: float | None = None  # когда вошёл на текущий перегон
    hold_extra: float = 0.0          # внешняя задержка: стоянка на ближайшей станции, с
    idle_s: float = 0.0              # простой локомотива и бригады сверх графика, с
    trace: list = field(default_factory=list)   # факт для графика движения: [(t, км)]
    last_trace: float = -1e18


class Engine:
    def __init__(self, world: World, trains: list[Train], plan: Plan, cfg: BagdarConfig,
                 seed: int, start_time: float) -> None:
        self.world = world
        self.cfg = cfg
        self.rules = TimingRules.from_config(cfg.sim)
        self.trains = {t.id: t for t in trains}
        self.order = sorted(self.trains)
        self.rt = {tid: TrainRT(train=self.trains[tid]) for tid in self.order}
        self.il = Interlocking(world, self.rules)
        self.ex = PlanExecutor(world, plan)
        self.rng = random.Random(seed * 1_000_003 + 11)
        self.seed = seed
        self.t = start_time
        self.start_time = start_time
        self.dt = cfg.sim.dt_s
        self.seq = 0
        self.pending_events: list[SimEvent] = []
        self.entered: set[tuple[str, int]] = set()
        self.gone: set[str] = set()
        self.steps = 0
        self._cand: str | None = None
        self.hold_all = False
        # факт для показателей и графиков
        self.passages: list[float] = []          # моменты прибытия и проследования станций
        self.idle_total_s = 0.0                  # Σ простоя сверх графика по всем поездам
        self.active_total_s = 0.0                # Σ времени поездов на участке
        self.occ: list[list] = []                # журнал занятости: [ресурс, поезд, t0, t1|None, вид]
        self._occ_open: dict[tuple[str, str], int] = {}
        self._km = {sid: st.km for sid, st in world.stations.items()}
        self._init_from_plan(start_time)

    # ------------------------------------------------------------------ события
    def emit(self, kind: str, severity: str, message: str, **kw) -> SimEvent:
        self.seq += 1
        ev = SimEvent(seq=self.seq, t=self.t, kind=kind, severity=severity, message=message, **kw)
        self.pending_events.append(ev)
        return ev

    def drain_events(self) -> list[SimEvent]:
        out, self.pending_events = self.pending_events, []
        return out

    # ------------------------------------------------------------ инициализация
    def _origin_delay(self) -> float:
        s = self.cfg.sim
        if self.rng.random() < s.origin_delay_prob:
            return round(self.rng.uniform(30, s.origin_delay_max_s))
        return 0.0

    def _init_from_plan(self, t0: float) -> None:
        """Расставить поезда так, как их расставил бы план к моменту t0.

        План бесконфликтный, поэтому и начальное состояние согласовано."""
        r = self.rules
        on_section: list[tuple[float, str, int]] = []
        for tid in self.order:
            tr, rt = self.trains[tid], self.rt[tid]
            legs = self.ex.plan.legs.get(tid, [])
            rt.ready_at = (legs[0].dep if legs else tr.origin_dep) + self._origin_delay()
            if not legs:
                rt.status = "finished"
                self.gone.add(tid)
                continue
            if t0 < legs[0].dep - r.prep_s:
                continue  # ещё не появился
            if t0 >= legs[-1].arr + r.terminate_s:
                rt.status = "finished"
                self.gone.add(tid)
                for leg in legs:
                    self.entered.add((tid, leg.k))
                continue
            if t0 < legs[0].dep:
                trk = self.ex.plan.origin_track.get(tid) or tr.schedule[0].track_id
                self._place_at_station(rt, 0, trk, arrived=legs[0].dep - r.prep_s,
                                       dwell_until=max(rt.ready_at, legs[0].dep))
                continue
            placed = False
            for i, leg in enumerate(legs):
                self.entered.add((tid, leg.k))
                if leg.dep <= t0 < leg.arr:
                    on_section.append((leg.dep, tid, i))
                    placed = True
                    break
                nxt = legs[i + 1] if i + 1 < len(legs) else None
                if nxt is None or t0 < nxt.dep:
                    rt.rec_delay_s = 0.0
                    if nxt is None:
                        self._place_at_station(rt, leg.k + 1, leg.track_id, arrived=leg.arr, dwell_until=leg.arr)
                        rt.finish_at = leg.arr + r.terminate_s
                    else:
                        self._place_at_station(rt, leg.k + 1, leg.track_id, arrived=leg.arr, dwell_until=nxt.dep)
                    placed = True
                    break
            assert placed
        for dep, tid, i in sorted(on_section):
            rt = self.rt[tid]
            leg = self.ex.plan.legs[tid][i]
            sec = self.world.sections[leg.section_id]
            frac = (t0 - leg.dep) / max(1.0, leg.arr - leg.dep)
            rt.status = "section"
            rt.k = leg.k
            rt.dist = sec.length_m * frac
            rt.v = min(self._vmax(rt, sec, leg.direction), sec.length_m / max(1.0, leg.arr - leg.dep) * 1.05)
            rt.v_peak = rt.v
            rt.v_target = rt.v
            rt.entered_at = leg.dep
            self._trace(rt, leg.dep, self._km[leg.from_id])
            self._trace(rt, t0)
            self.occ_open(sec.id, tid, leg.dep, "section")
            self.il.enter_section(sec.id, leg.direction, tid, dep)
            if self.il.sections[sec.id].single:
                rt.dest_track = leg.track_id
                self.il.reserve_track(leg.track_id, tid)
        self.ex.set_plan(self.ex.plan, self.entered)

    def _place_at_station(self, rt: TrainRT, k: int, track_id: str, arrived: float, dwell_until: float) -> None:
        rt.status = "station"
        rt.k = k
        rt.track_id = track_id
        rt.arrived_at = arrived
        rt.dwell_until = dwell_until
        self.il.occupy_track(track_id, rt.train.id)
        self.occ_open(track_id, rt.train.id, arrived, "stand")
        self._trace(rt, arrived)

    # ------------------------------------------------------------- журнал факта
    def occ_open(self, res: str, tid: str, t: float, kind: str) -> None:
        key = (res, tid)
        if key in self._occ_open:
            return
        self._occ_open[key] = len(self.occ)
        self.occ.append([res, tid, t, None, kind])

    def occ_close(self, res: str | None, tid: str, t: float) -> None:
        if res is None:
            return
        i = self._occ_open.pop((res, tid), None)
        if i is not None:
            self.occ[i][3] = t

    def km_of(self, rt: TrainRT) -> float:
        tr = rt.train
        if rt.status == "section":
            sec = self.world.sections[tr.sections[rt.k]]
            a, b = self._km[tr.route[rt.k]], self._km[tr.route[rt.k + 1]]
            return a + (b - a) * min(1.0, max(0.0, rt.dist / sec.length_m))
        return self._km[tr.route[rt.k]]

    def _trace(self, rt: TrainRT, t: float, km: float | None = None) -> None:
        rt.trace.append((round(t, 1), round(self.km_of(rt) if km is None else km, 3)))
        rt.last_trace = t

    # ----------------------------------------------------------------- план и сбои
    def apply_plan(self, plan: Plan) -> None:
        """Новый план вступает в силу: порядок на перегонах и пути приёма."""
        self.ex.set_plan(plan, self.entered)
        self.hold_all = plan.hold_all

    def inject_delay(self, train_id: str, seconds: float, reason: str = "внешнее событие") -> str:
        """Задержать поезд: стоит на станции дольше или сделает стоянку на ближайшей."""
        rt = self.rt.get(train_id)
        if rt is None or rt.status == "finished":
            raise ValueError(f"Поезд {train_id} не на участке")
        tr = rt.train
        if rt.status == "pending":
            rt.ready_at = max(rt.ready_at, self.t) + seconds
            where = f"отправление со ст. {self.world.stations[tr.route[0]].name}"
        elif rt.status == "station":
            if rt.k == len(tr.route) - 1:
                raise ValueError(f"Поезд {tr.number} уже на конечной")
            rt.dwell_until = max(rt.dwell_until, self.t) + seconds
            where = f"ст. {self.world.stations[tr.route[rt.k]].name}"
        else:
            rt.hold_extra += seconds
            where = f"стоянка на ст. {self.world.stations[tr.route[rt.k + 1]].name}"
        self.emit("train_delay_injected", "warn",
                  f"Поезд {tr.number} задержан на {round(seconds / 60)} мин ({where}): {reason}",
                  train_id=train_id, data={"seconds": seconds})
        return where

    # ----------------------------------------------------------------- помощники
    def _vmax(self, rt: TrainRT, sec: Section, d: int) -> float:
        tr = rt.train
        srt = self.il.sections[sec.id]
        return effective_vmax(tr.vmax_kmh, sec.speed_limit_kmh, sec.gradient_for(d), tr.mass_t, srt.restriction_kmh)

    def _dir(self, tr: Train, k: int) -> int:
        sec = self.world.sections[tr.sections[k]]
        return self.world.direction(sec, tr.route[k])

    def number(self, tid: str) -> str:
        return self.trains[tid].number

    def dist_on(self, tid: str, sec_id: str) -> float:
        rt = self.rt[tid]
        if rt.status == "section" and rt.train.sections[rt.k] == sec_id:
            return rt.dist
        return -1.0

    def length_of(self, tid: str) -> float:
        return self.trains[tid].length_m

    def _planned_stop(self, rt: TrainRT, k_leg: int) -> bool:
        tr = rt.train
        if k_leg + 1 == len(tr.route) - 1:
            return True
        if rt.hold_extra > 0 and rt.status == "section" and k_leg == rt.k:
            return True
        leg = self.ex.leg(tr.id, k_leg)
        return leg.stop if leg else tr.schedule[k_leg + 1].stop

    def _set_wait(self, rt: TrainRT, now: float, reason: str) -> None:
        if rt.wait_since is None:
            rt.wait_since = now
        rt.wait_reason = reason
        if not rt.held_reported and now - rt.wait_since >= 120:
            rt.held_reported = True
            where = self.world.stations[rt.train.route[rt.k]].name if rt.status == "station" else \
                f"перегон {rt.train.sections[rt.k]}"
            self.emit("train_held", "info", f"Поезд {rt.train.number} ожидает ({where}): {reason}",
                      train_id=rt.train.id,
                      station_id=rt.train.route[rt.k] if rt.status == "station" else None,
                      section_id=rt.train.sections[rt.k] if rt.status == "section" else None)

    @staticmethod
    def _clear_wait(rt: TrainRT) -> None:
        rt.wait_reason = None
        rt.wait_since = None
        rt.held_reported = False

    def _record_delay(self, rt: TrainRT, delay: float) -> None:
        rt.rec_delay_s = max(0.0, delay)
        tol = self.cfg.tolerance_s(rt.train.cls)
        level = 0 if delay < 60 else (1 if delay < tol else 2)
        tr = rt.train
        if level == 2 and rt.delay_level < 2:
            self.emit("train_delay", "warn",
                      f"Поезд {tr.number} опаздывает на {round(delay / 60)} мин "
                      f"(допуск {round(tol / 60)} мин)", train_id=tr.id, data={"delay_s": round(delay)})
        elif level < 2 and rt.delay_level == 2:
            self.emit("train_recovered", "info", f"Поезд {tr.number} вошёл в допуск по опозданию",
                      train_id=tr.id, data={"delay_s": round(delay)})
        rt.delay_level = level

    # ----------------------------------------------------------------------- шаг
    def step(self) -> None:
        now = self.t
        for tid in self.order:
            rt = self.rt[tid]
            if rt.status == "pending":
                self._try_spawn(rt, now)
            elif rt.status == "station":
                self._station(rt, now)
        for tid in self.order:
            rt = self.rt[tid]
            if rt.status == "section":
                self._move(rt, now)
        self._account(now)
        self.t = now + self.dt
        self.steps += 1

    def _account(self, now: float) -> None:
        """Учёт простоя: поезд стоит сверх графика (на станции после планового
        отправления или у светофора на перегоне). Плюс точки факта для графика."""
        dt = self.dt
        for tid in self.order:
            rt = self.rt[tid]
            if rt.status == "section":
                self.active_total_s += dt
                if rt.v < 0.05:
                    rt.idle_s += dt
                    self.idle_total_s += dt
                if now - rt.last_trace >= 30:
                    self._trace(rt, now)
            elif rt.status == "station":
                tr = rt.train
                if rt.k == len(tr.route) - 1:
                    continue
                self.active_total_s += dt
                sd = tr.schedule[rt.k].dep
                if now >= rt.dwell_until and (sd is None or now > sd):
                    rt.idle_s += dt
                    self.idle_total_s += dt

    def advance(self, seconds: float) -> int:
        n = max(0, int(round(seconds / self.dt)))
        for _ in range(n):
            self.step()
        return n

    # ---------------------------------------------------------- появление поезда
    def _try_spawn(self, rt: TrainRT, now: float) -> None:
        tr = rt.train
        leg0 = self.ex.leg(tr.id, 0)
        dep = leg0.dep if leg0 else tr.origin_dep
        if now < dep - self.rules.prep_s:
            return
        planned = self.ex.plan.origin_track.get(tr.id)
        trk = self.il.pick_track(tr.route[0], tr.id, tr.length_m, now, planned, prefer_main=False)
        if trk is None:
            self._set_wait(rt, now, "нет свободного пути на станции формирования")
            return
        self._clear_wait(rt)
        self._place_at_station(rt, 0, trk, arrived=now, dwell_until=max(rt.ready_at, dep))
        self.emit("train_spawned", "debug", f"Поезд {tr.number} готов к отправлению со ст. "
                  f"{self.world.stations[tr.route[0]].name}", train_id=tr.id, station_id=tr.route[0])

    # ------------------------------------------------------------ поезд на станции
    def _station(self, rt: TrainRT, now: float) -> None:
        tr = rt.train
        if rt.k == len(tr.route) - 1:
            if now >= rt.finish_at:
                self._finish(rt, now)
            return
        if now < rt.dwell_until:
            return
        reason, is_delay = self._departure_block(rt, now, through=False, at=now)
        if reason is not None:
            if is_delay:
                self._set_wait(rt, now, reason)
            else:
                self._clear_wait(rt)
            return
        self._grant_departure(rt, now, through=False)

    def _departure_block(self, rt: TrainRT, now: float, through: bool, at: float) -> tuple[str | None, bool]:
        """Можно ли войти на следующий перегон. Возвращает (причина, это_задержка)."""
        tr = rt.train
        kl = rt.k + 1 if through else rt.k
        if kl >= len(tr.sections):
            return "конечная", False
        sec = self.world.sections[tr.sections[kl]]
        d = self.world.direction(sec, tr.route[kl])
        leg = self.ex.leg(tr.id, kl)
        if leg is None and self.hold_all:
            return "удержан: допустимый план не найден", True
        if leg is not None and at < leg.dep - (60 if through else 0):
            return f"по плану отправление в {hhmm(leg.dep)}", False
        sched = tr.schedule[kl]
        if (not through and tr.pte_rank <= 3 and sched.stop and sched.dep is not None and kl > 0
                and at < sched.dep):
            return f"по расписанию отправление в {hhmm(sched.dep)}", False
        blocker = self.ex.order_blocker(tr.id, kl, sec.id, d, self.entered, self.gone)
        if blocker is not None:
            return f"по плану первым идёт {self.number(blocker)}", True
        reason = self.il.entry_block_reason(sec.id, d, tr.id, now, lambda o: self.dist_on(o, sec.id),
                                            self.length_of, self.number)
        if reason is not None:
            return reason, True
        if not self.il.throat_free(sec.departure_throat(d), tr.id, now):
            return "горловина занята другим маршрутом", True
        self._cand = None
        if self.il.sections[sec.id].single:
            nxt = tr.route[kl + 1]
            trk = self.il.pick_track(nxt, tr.id, tr.length_m, now, leg.track_id if leg else None,
                                     prefer_main=not self._planned_stop(rt, kl))
            if trk is None:
                st = self.world.stations[nxt]
                return (f"на ст. {st.name} нет свободного пути ≥ {tr.length_m} м "
                        f"(защита от взаимной блокировки)"), True
            self._cand = trk
        return None, False

    def _grant_departure(self, rt: TrainRT, now: float, through: bool) -> None:
        tr = rt.train
        kl = rt.k + 1 if through else rt.k
        sec = self.world.sections[tr.sections[kl]]
        d = self.world.direction(sec, tr.route[kl])
        self.il.enter_section(sec.id, d, tr.id, now)
        self.entered.add((tr.id, kl))
        dep_thr = sec.departure_throat(d)
        if not through:
            rt.entered_at = now
        cand = self._cand
        if cand:
            self.il.reserve_track(cand, tr.id)
        if through:
            cur = self.world.sections[tr.sections[rt.k]]
            t_pass = now + max(0.0, cur.length_m - rt.dist) / max(rt.v, 1.0)
            self.il.lock_throat(dep_thr, tr.id, t_pass + self.rules.throat_s)
            self.il.open_signal(sec.id, d, t_pass + 15)
            rt.through = True
            rt.next_dest_track = cand
            return
        self.il.lock_throat(dep_thr, tr.id, now + self.rules.throat_s)
        self.il.open_signal(sec.id, d, now + self.rules.throat_s)
        if rt.track_id:
            self.il.release_track(rt.track_id, tr.id, now)
        self.occ_close(rt.track_id, tr.id, now)
        self.occ_open(sec.id, tr.id, now, "section")
        self._trace(rt, now)
        rt.track_id = None
        rt.status = "section"
        rt.dist = 0.0
        rt.dest_track = cand
        rt.arr_route = False
        rt.through = False
        sched = tr.schedule[kl]
        if sched.dep is not None:
            self._record_delay(rt, now - sched.dep)
        self._clear_wait(rt)
        self.emit("train_departed", "debug",
                  f"Поезд {tr.number} отправился со ст. {self.world.stations[tr.route[kl]].name}",
                  train_id=tr.id, station_id=tr.route[kl], section_id=sec.id)

    # ------------------------------------------------------------ поезд на перегоне
    def _move(self, rt: TrainRT, now: float) -> None:
        tr = rt.train
        k = rt.k
        sec = self.world.sections[tr.sections[k]]
        d = self.world.direction(sec, tr.route[k])
        L = sec.length_m
        vmax = self._vmax(rt, sec, d)
        acc = effective_accel(tr.accel, sec.gradient_for(d))
        dec = tr.decel
        dt = self.dt
        remaining = L - rt.dist
        last = k + 1 == len(tr.route) - 1
        must_stop = self._planned_stop(rt, k)
        leg = self.ex.leg(tr.id, k)
        # машинист ведёт поезд по плановому времени прибытия, не быстрее лимита
        if leg is not None and leg.arr > now + 1:
            v_req = remaining / (leg.arr - now) * (1.15 if must_stop else 1.03)
            v_tgt = min(vmax, max(v_req, 8.4))
        else:
            v_tgt = vmax
        rt.v_target = v_tgt
        # маршруты приёма и безостановочного пропуска задаются при подходе
        approach = max(rt.v * self.rules.approach_s, rt.v * rt.v / (2 * dec) + 300.0)
        if remaining <= approach:
            if not rt.arr_route:
                self._try_arrival_route(rt, now, sec, d, must_stop)
            if rt.arr_route and not must_stop and not last and not rt.through:
                eta = now + remaining / max(rt.v, 1.0)
                reason, _ = self._departure_block(rt, now, through=True, at=eta)
                if reason is None:
                    self._grant_departure(rt, now, through=True)
        if not rt.arr_route:
            stop_at: float | None = L - 30.0      # у входного светофора
        elif rt.through:
            stop_at = None
        else:
            stop_at = L
        leader = self.il.leader_ahead(sec.id, tr.id)
        if leader is not None:
            ld = self.dist_on(leader, sec.id)
            if ld >= 0:
                gap_stop = ld - self.trains[leader].length_m - 150.0
                stop_at = gap_stop if stop_at is None else min(stop_at, gap_stop)
        v = rt.v
        v_cap = v_tgt
        if stop_at is not None:
            room = stop_at - rt.dist
            v_cap = min(v_cap, math.sqrt(max(0.0, 2 * dec * room)))
            if room > 0.5:
                v_cap = max(v_cap, min(0.6, v_tgt))
            else:
                v_cap = 0.0
        if v_cap >= v:
            v_new = min(v + acc * dt, v_cap)
        else:
            v_new = max(v_cap, v - dec * 1.6 * dt)
        ds = (v + v_new) / 2 * dt
        if stop_at is not None and rt.dist + ds >= stop_at - 0.3:
            ds = max(0.0, stop_at - rt.dist)
            v_new = 0.0
        rt.dist += ds
        rt.v = v_new
        rt.v_peak = max(rt.v_peak, v_new)
        if v_new == 0.0 and v > 0.0 and rt.dist < L - 0.5:
            # вынужденная остановка на перегоне
            rt.unplanned_stops += 1
            rt.stop_energy_kwh += stop_energy_kwh(tr.mass_t, rt.v_peak)
            rt.v_peak = 0.0
        if rt.v == 0.0 and rt.dist < L - 0.5 and not rt.arr_route:
            st = self.world.stations[tr.route[k + 1]]
            self._set_wait(rt, now, rt.wait_reason or f"стоит у входного светофора ст. {st.name}")
        if rt.dist >= L - 0.01:
            if rt.through:
                self._pass_station(rt, now, sec)
            elif rt.arr_route:
                self._arrive(rt, now, sec, must_stop)

    def _try_arrival_route(self, rt: TrainRT, now: float, sec: Section, d: int, must_stop: bool) -> None:
        tr = rt.train
        nxt = tr.route[rt.k + 1]
        st = self.world.stations[nxt]
        if rt.dest_track is None:
            leg = self.ex.leg(tr.id, rt.k)
            trk = self.il.pick_track(nxt, tr.id, tr.length_m, now, leg.track_id if leg else None,
                                     prefer_main=not must_stop)
            if trk is None:
                rt.wait_reason = f"нет свободного пути приёма на ст. {st.name}"
                return
            self.il.reserve_track(trk, tr.id)
            rt.dest_track = trk
        thr = sec.arrival_throat(d)
        if not self.il.throat_free(thr, tr.id, now):
            rt.wait_reason = f"горловина ст. {st.name} занята"
            return
        self.il.lock_throat(thr, tr.id, POS_INF)
        rt.arr_route = True
        rt.wait_reason = None

    def _pass_station(self, rt: TrainRT, now: float, sec: Section) -> None:
        tr = rt.train
        d = self.world.direction(sec, tr.route[rt.k])
        self.il.exit_section(sec.id, tr.id, now)
        self.il.release_throat(sec.arrival_throat(d), tr.id, now)
        if rt.dest_track:
            self.il.release_track(rt.dest_track, tr.id, now)
        nk = rt.k + 1
        nsec = self.world.sections[tr.sections[nk]]
        nd = self.world.direction(nsec, tr.route[nk])
        self.il.lock_throat(nsec.departure_throat(nd), tr.id, now + self.rules.throat_s)
        sched = tr.schedule[nk]
        if sched.arr is not None:
            self._record_delay(rt, now - sched.arr)
        self.passages.append(now)
        self.occ_close(sec.id, tr.id, now)
        if rt.dest_track:
            occ_s = tr.length_m / max(rt.v, 5.0)
            self.occ.append([rt.dest_track, tr.id, now - occ_s / 2, now + occ_s / 2, "pass"])
        self.occ_open(nsec.id, tr.id, now, "section")
        self._trace(rt, now, self._km[tr.route[nk]])
        self.emit("train_passed", "debug",
                  f"Поезд {tr.number} проследовал ст. {self.world.stations[tr.route[nk]].name}",
                  train_id=tr.id, station_id=tr.route[nk])
        rt.k = nk
        rt.dist = max(0.0, rt.dist - sec.length_m)
        rt.entered_at = now
        rt.dest_track = rt.next_dest_track
        rt.next_dest_track = None
        rt.through = False
        rt.arr_route = False
        self._clear_wait(rt)

    def _arrive(self, rt: TrainRT, now: float, sec: Section, planned_stop: bool) -> None:
        tr = rt.train
        d = self.world.direction(sec, tr.route[rt.k])
        self.il.exit_section(sec.id, tr.id, now)
        self.il.release_throat(sec.arrival_throat(d), tr.id, now)
        nk = rt.k + 1
        trk = rt.dest_track
        assert trk is not None
        self.il.occupy_track(trk, tr.id)
        self.occ_close(sec.id, tr.id, now)
        self.occ_open(trk, tr.id, now, "stand")
        self.passages.append(now)
        rt.status = "station"
        rt.k = nk
        rt.track_id = trk
        rt.dest_track = None
        rt.arr_route = False
        rt.dist = 0.0
        rt.v = 0.0
        rt.arrived_at = now
        rt.stops += 1
        self._trace(rt, now)
        sched = tr.schedule[nk]
        if not sched.stop and nk != len(tr.route) - 1:
            # остановка, которой нет в расписании: теряется кинетическая энергия
            rt.unplanned_stops += 1
            rt.stop_energy_kwh += stop_energy_kwh(tr.mass_t, rt.v_peak)
        rt.v_peak = 0.0
        if sched.arr is not None:
            self._record_delay(rt, now - sched.arr)
        self._clear_wait(rt)
        st = self.world.stations[tr.route[nk]]
        if nk == len(tr.route) - 1:
            rt.finish_at = now + self.rules.terminate_s
            self.emit("train_arrived", "debug", f"Поезд {tr.number} прибыл на конечную ст. {st.name}",
                      train_id=tr.id, station_id=st.id)
            return
        planned_by_sched = sched.stop
        dwell = sched.dwell_s if planned_by_sched else 0.0
        s = self.cfg.sim
        if planned_by_sched and dwell > 0 and self.rng.random() < s.dwell_jitter_prob:
            dwell += round(self.rng.uniform(10, s.dwell_jitter_max_s))
        if rt.hold_extra > 0:
            dwell += rt.hold_extra
            rt.hold_extra = 0.0
        rt.dwell_until = now + dwell
        self.emit("train_arrived", "debug", f"Поезд {tr.number} прибыл на ст. {st.name}",
                  train_id=tr.id, station_id=st.id)

    def _finish(self, rt: TrainRT, now: float) -> None:
        tr = rt.train
        if rt.track_id:
            self.il.release_track(rt.track_id, tr.id, now)
        self.occ_close(rt.track_id, tr.id, now)
        rt.track_id = None
        rt.status = "finished"
        self.gone.add(tr.id)
        self.emit("train_finished", "debug", f"Поезд {tr.number} ушёл с участка", train_id=tr.id)

    # --------------------------------------------------------------- показатели
    def live_delay(self, rt: TrainRT) -> float:
        tr, now = rt.train, self.t
        if rt.status == "pending":
            return max(0.0, now - tr.origin_dep)
        if rt.status == "finished":
            return rt.rec_delay_s
        if rt.status == "station":
            sched = tr.schedule[rt.k]
            if sched.dep is not None and now > sched.dep:
                return max(rt.rec_delay_s, now - sched.dep)
            return rt.rec_delay_s
        sec = self.world.sections[tr.sections[rt.k]]
        sched = tr.schedule[rt.k + 1]
        if sched.arr is None:
            return rt.rec_delay_s
        eta = now + (sec.length_m - rt.dist) / max(rt.v, rt.v_target, 5.0)
        return max(0.0, eta - sched.arr)

    def active(self) -> list[TrainRT]:
        return [self.rt[t] for t in self.order if self.rt[t].status in ("station", "section")]

    def metrics(self) -> dict:
        act = self.active()
        delays = [self.live_delay(rt) for rt in act]
        on_time = sum(1 for rt, dl in zip(act, delays) if dl <= self.cfg.tolerance_s(rt.train.cls))
        return {
            "active_trains": len(act),
            "finished_trains": len(self.gone),
            "avg_delay_s": round(sum(delays) / len(delays), 1) if delays else 0.0,
            "max_delay_s": round(max(delays), 1) if delays else 0.0,
            "on_time_share": round(on_time / len(act), 3) if act else 1.0,
            "waiting_trains": sum(1 for rt in act if rt.wait_reason),
            "unplanned_stops": sum(rt.unplanned_stops for rt in self.rt.values()),
            "stop_energy_kwh": round(sum(rt.stop_energy_kwh for rt in self.rt.values()), 1),
        }
