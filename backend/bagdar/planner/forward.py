"""Событийный планировщик (мезоскопическая модель) — быстрая эвристика.

Поезда движутся от события к событию (готов к отправлению → прибыл), время
хода берётся из той же кинематики, что и в симуляторе. Ресурсы (перегоны,
пути, горловины) резервируются по тем же правилам слоя 0, поэтому любой
построенный план бесконфликтен по построению; валидатор проверяет его
независимо.

Кто первым занимает ресурс, решает политика:
- PriorityPolicy — эвристика Бағдара: внеочередные первыми, дальше
  сравнение цены ожидания двух поездов (вес × прирост опоздания + энергия
  лишней остановки + простой) с учётом запаса в расписании и режима
  pte_strict. Смотрит на шаг вперёд: придерживает поезд, если встречный или
  догоняющий важнее и успеет раньше, и только если тому есть куда встать.
- OrderPolicy — исполняет заданный порядок на перегонах. Нужна для
  восстановления прошлого плана (тёплый старт) и для честной оценки
  альтернатив в карточках решений.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from bagdar.generator.timetable import ReservationTable, SecRes, interval_retry
from bagdar.models.plan import Plan, PlanLeg, StartHold
from bagdar.planner.economics import section_sequences, stop_cost
from bagdar.planner.inputs import PlanningInput, TrainIn

INF = 1e15


@dataclass
class _TS:
    ti: TrainIn
    phase: str                     # pending | station | section | done
    k: int
    track: str | None = None
    hold: list | None = None       # [h0, h1, tid] — путь, где поезд стоит
    t_ready: float = 0.0
    stopped: bool = True
    sres: SecRes | None = None
    arr_win: list | None = None
    t_arr: float = 0.0
    dest: str | None = None
    dest_hold: list | None = None
    leg: PlanLeg | None = None
    forced: dict | None = None     # заранее выданное разрешение на следующий перегон
    retry_at: float = INF
    legs: list[PlanLeg] = field(default_factory=list)
    start_hold: StartHold | None = None
    origin_track: str | None = None
    ss_cur: bool = True            # плечо начато с остановки
    hold_applied: bool = False


@dataclass
class ForwardResult:
    plan: Plan
    held: list[str]
    deadlock: bool
    relaxed: bool
    events: int


class Policy:
    can_relax = True
    relax = False
    anti_lock = True       # защита от «замка» на две станции вперёд — часть диспетчерской логики Бағдара

    def sort_key(self, sched: "ForwardScheduler", tid: str) -> tuple:
        return (0, tid)

    def allow(self, sched: "ForwardScheduler", tid: str, k: int, t: float, through: bool) -> bool:
        return True

    def track(self, tid: str, k: int) -> str | None:
        return None

    def not_before(self, tid: str, k: int, through: bool) -> float | None:
        """Не отправлять раньше (план исполняется по времени, как в симуляторе)."""
        return None

    def arrive_not_before(self, tid: str, k: int) -> float | None:
        """Машинист ведёт поезд к плановому времени прибытия, а не быстрее."""
        return None

    def on_enter(self, tid: str, k: int) -> None:
        pass


ANTI_LOCK = True        # защита от замка на две станции вперёд
LOCK_WINDOW_S = 600.0   # «станция занята» — нет свободного пути в ближайшие 10 мин после прибытия
LOCK_RETRY_S = 60.0
LOCK_COMING = True      # учитывать встречных, которые уже едут к Y без назначенного пути
LOCK_LONGEST = True     # запирается самый длинный встречный, а не самый короткий


class ForwardScheduler:
    def __init__(self, inp: PlanningInput, policy: Policy, horizon_end: float | None = None) -> None:
        self.inp = inp
        self.world = inp.world
        self.r = inp.rules
        self.policy = policy
        self.h_end = horizon_end if horizon_end is not None else inp.horizon_end
        self.table = ReservationTable(inp.world, inp.rules)
        self.table.pab = set(inp.pab)
        self.ts: dict[str, _TS] = {}
        self.heap: list[tuple[float, int, str, str]] = []
        self.seq = 0
        self.waiting: set[str] = set()
        self.entered: set[tuple[str, int]] = set(inp.entered)
        self.n_events = 0
        self.relaxed = False

    # ------------------------------------------------------------ служебное
    def push(self, t: float, kind: str, tid: str) -> None:
        self.seq += 1
        heapq.heappush(self.heap, (t, self.seq, kind, tid))

    def _retry_later(self, s: _TS, t: float, rr: float | None) -> None:
        self.waiting.add(s.ti.id)
        if rr is not None and rr > t and rr < s.retry_at:
            s.retry_at = rr
            self.push(rr, "retry", s.ti.id)

    def track_possible(self, tid: str, station_id: str, h0: float, exclude: set[str]) -> bool:
        ti = self.inp.trains[tid]
        st = self.world.stations[station_id]
        trk, _ = self.table.pick_track(st, ti.train.length_m, h0, INF, prefer_main=True,
                                       exclude=set(self.inp.unavailable_tracks) | exclude)
        return trk is not None

    # ------------------------------------------------------------ запуск
    def run(self) -> ForwardResult:
        self._init()
        last_t = self.inp.t0
        hit_horizon = False
        while True:
            while self.heap:
                t, _, kind, tid = heapq.heappop(self.heap)
                if t > self.h_end:
                    # за горизонтом только назначаем пути приёма уже начатым плечам
                    rest = [(t, kind, tid)] + [(e[0], e[2], e[3]) for e in self.heap]
                    self.heap.clear()
                    for tt_, kk, tid_ in sorted(rest):
                        if kk == "approach":
                            self._approach(tid_, tt_)
                    hit_horizon = True
                    break
                last_t = t
                self.n_events += 1
                s = self.ts[tid]
                if kind == "retry":
                    if s.retry_at <= t + 1e-6:
                        s.retry_at = INF
                    self._attempt(tid, t)
                elif kind == "spawn":
                    self._spawn(tid, t)
                elif kind == "ready":
                    self._ready(tid, t)
                elif kind == "arrive":
                    self._arrive(tid, t)
                elif kind == "approach":
                    self._approach(tid, t)
                self._retry_waiting(t)
            stuck = [tid for tid in self.waiting if self.ts[tid].phase != "done"]
            if stuck and not hit_horizon and self.policy.can_relax and not self.policy.relax:
                # тупик из-за придержаний политики: снимаем придержания и пробуем ещё раз
                self.policy.relax = True
                self.relaxed = True
                self._retry_waiting(last_t)
                if self.heap:
                    continue
            break
        # удержаны — ждут ресурса без известного времени освобождения
        held = sorted(tid for tid in self.waiting
                      if self.ts[tid].phase in ("station", "pending", "section") and self.ts[tid].retry_at >= INF)
        deadlock = bool(held) and not hit_horizon
        return ForwardResult(plan=self._plan(held), held=held, deadlock=deadlock, relaxed=self.relaxed,
                             events=self.n_events)

    def _attempt(self, tid: str, t: float) -> bool:
        s = self.ts[tid]
        if s.phase == "pending":
            return self._spawn(tid, t)
        if s.phase == "station":
            return self._ready(tid, t)
        if s.phase == "section" and tid in self.waiting:
            return self._arrive(tid, t)
        return False

    def _retry_waiting(self, t: float) -> None:
        changed = True
        while changed and self.waiting:
            changed = False
            for tid in sorted(self.waiting, key=lambda x: self.policy.sort_key(self, x)):
                if tid in self.waiting and self._attempt(tid, t):
                    changed = True

    # ------------------------------------------------------------ начальное состояние
    def _init(self) -> None:
        inp, r = self.inp, self.r
        for tid in sorted(inp.trains):
            ti = inp.trains[tid]
            s = _TS(ti=ti, phase=ti.phase, k=ti.k)
            self.ts[tid] = s
            if ti.phase == "terminal":
                hold = [max(ti.since, inp.t0), max(ti.finish_at, inp.t0), tid]
                self.table.trk[ti.track].append(hold)
                s.phase = "done"
                s.start_hold = StartHold(ti.train.route[ti.k], ti.track, ti.since, until=ti.finish_at)
            elif ti.phase == "pending":
                self.push(max(inp.t0, ti.origin_dep - r.prep_s, ti.t_ready - r.prep_s), "spawn", tid)
            elif ti.phase == "station":
                hold = [max(ti.since, inp.t0), INF, tid]
                self.table.trk[ti.track].append(hold)
                s.hold, s.track, s.stopped = hold, ti.track, True
                s.t_ready = ti.t_ready
                s.start_hold = StartHold(ti.train.route[ti.k], ti.track, ti.since)
                self.push(ti.t_ready, "ready", tid)
        # поезда на перегонах — после станций; сначала те, у кого путь приёма уже
        # закреплён в реальности, потом остальные выбирают из свободных
        on_section = [tid for tid in sorted(inp.trains) if inp.trains[tid].phase == "section"]
        # порядок: уже заданные маршруты приёма, выданные проходы, остальные по времени прибытия
        on_section.sort(key=lambda x: (not inp.trains[x].arr_route, not inp.trains[x].through_next,
                                       inp.trains[x].dest_track is None, inp.trains[x].t_arr_est, x))
        for tid in on_section:
            ti = inp.trains[tid]
            s = self.ts[tid]
            leg = ti.legs[ti.k]
            dec = 0.0 if ti.stop_end else leg.run(False, True) - leg.run(False, False)
            t_arr = ti.t_arr_est
            thr = self.table.thr[leg.sec.arrival_throat(leg.d)]
            if not ti.arr_route:
                # маршрут приёма ещё не задан: если горловина будет занята, поезд подождёт у входного
                for _ in range(200):
                    rr = interval_retry(thr, t_arr - r.approach_s, t_arr + dec)
                    if rr is None or rr >= INF / 2:
                        break
                    t_arr = rr + r.approach_s
            t_out = t_arr + dec
            res = SecRes(tid, leg.d, ti.since, t_out)
            self.table.sec[leg.sec.id].append(res)
            aw = [t_arr - r.approach_s, t_out, tid]
            thr.append(aw)
            dest = ti.dest_track
            hold = None
            if dest is not None:
                hold = [max(inp.t0, ti.since if leg.sec.tracks == 1 else t_arr - r.approach_s), INF, tid]
                self.table.trk[dest].append(hold)
            s.sres, s.arr_win, s.t_arr, s.dest, s.dest_hold = res, aw, t_arr, dest, hold
            s.ss_cur = False
            s.leg = PlanLeg(tid, ti.k, leg.sec.id, leg.from_id, leg.to_id, leg.d, ti.since, t_arr,
                            dest or "", ti.stop_end)
            s.legs.append(s.leg)
            if ti.through_next and ti.k + 1 < len(ti.legs):
                s.forced = self._reserve(s, ti.k + 1, t_arr, ss=False, check=False,
                                         preferred=ti.next_dest_track)
                self.entered.add((tid, ti.k + 1))
            if dest is None:
                self.push(max(inp.t0, t_arr - r.approach_s), "approach", tid)
            self.push(t_arr, "arrive", tid)

    # ------------------------------------------------------------ события
    def _spawn(self, tid: str, t: float) -> bool:
        s = self.ts[tid]
        ti = s.ti
        st = self.world.stations[ti.train.route[0]]
        trk, rr = self.table.pick_track(st, ti.train.length_m, t, INF, prefer_main=False,
                                        preferred=self.policy.track(tid, -1) or ti.origin_track,
                                        exclude=set(self.inp.unavailable_tracks))
        if trk is None:
            self._retry_later(s, t, rr)
            return False
        self.waiting.discard(tid)
        hold = [t, INF, tid]
        self.table.trk[trk].append(hold)
        s.phase, s.k, s.track, s.hold, s.stopped = "station", 0, trk, hold, True
        s.origin_track = trk
        s.start_hold = StartHold(st.id, trk, t)
        s.t_ready = max(t, ti.t_ready)
        self.push(s.t_ready, "ready", tid)
        return True

    def _ready(self, tid: str, t: float) -> bool:
        s = self.ts[tid]
        if s.phase != "station":
            return False
        if s.k >= len(s.ti.legs):
            return False
        if t + 1e-6 < s.t_ready:
            self._retry_later(s, t, s.t_ready)
            return False
        ok, rr = self._depart(tid, t, through=False)
        if ok:
            self.waiting.discard(tid)
            return True
        self._retry_later(s, t, rr)
        return False

    def _depart(self, tid: str, t: float, through: bool) -> tuple[bool, float | None]:
        s = self.ts[tid]
        ti = s.ti
        k = s.k
        closed = self.inp.closed_sections.get(ti.legs[k].sec.id)
        if closed and closed[0] <= t + ti.legs[k].run(True, True) and t <= closed[1]:
            return False, closed[1]
        nb = self.policy.not_before(tid, k, through)
        if nb is not None and t + 1e-6 < nb:
            return False, nb
        if not self.policy.relax and not self.policy.allow(self, tid, k, t, through):
            return False, None
        got = self._reserve(s, k, t, ss=not through, check=True, preferred=self.policy.track(tid, k))
        if not isinstance(got, dict):
            return False, got
        # путь, на котором поезд стоял (или проходил), освобождается
        if s.hold is not None:
            s.hold[1] = t + self.r.clear_s
        self._activate(s, k, got, t)
        return True, None

    def _reserve(self, s: _TS, k: int, t_in: float, ss: bool, check: bool,
                 preferred: str | None) -> dict | float | None:
        """Зарезервировать плечо k с входом в t_in. dict — успех, иначе время повтора/None."""
        r, tb, ti = self.r, self.table, s.ti
        leg = ti.legs[k]
        sec, d = leg.sec, leg.d
        se = leg.planned_stop_next
        r_pass, r_stop = leg.run(ss, se), leg.run(ss, True)
        t_arr = t_in + r_pass
        anb = self.policy.arrive_not_before(ti.id, k)
        if anb is not None:
            t_arr = max(t_arr, anb)
        for res in tb.sec[sec.id]:
            if res.direction == d and res.train_id != ti.id and res.t_in <= t_in:
                t_arr = max(t_arr, res.t_out + r.headway_arr_s)
        if t_arr >= INF / 2:
            if check:
                return None          # впереди поезд стоит у сигнала без известного времени
            t_arr = t_in + r_pass
        t_out = t_arr + (r_stop - r_pass)
        dw = [t_in, t_in + r.throat_s, ti.id] if ss else [t_in - r.approach_s, t_in + r.throat_s, ti.id]
        aw = [t_arr - r.approach_s, t_out, ti.id]
        single = sec.tracks == 1
        h0 = t_in if single else t_arr - r.approach_s
        st = self.world.stations[leg.to_id]
        if check:
            rr = tb.section_retry(sec, d, t_in, t_out)
            if rr is not None:
                return rr
            rr = interval_retry(tb.thr[sec.departure_throat(d)], dw[0], dw[1])
            if rr is not None:
                return t_in + (rr - dw[0])
            rr = interval_retry(tb.thr[sec.arrival_throat(d)], aw[0], aw[1])
            if rr is not None:
                return t_in + (rr - aw[0])
            if single:
                trk, rr = tb.pick_track(st, ti.train.length_m, h0, INF, prefer_main=not se, preferred=preferred,
                                        exclude=set(self.inp.unavailable_tracks))
                if trk is None:
                    return None if rr is None else t_in + max(1.0, rr - h0)
                if self._would_lock(ti, k, trk, t_arr):
                    trk = self._lock_free_track(ti, k, st, trk, h0, t_arr)
                    if trk is None:
                        return t_in + LOCK_RETRY_S
            else:
                trk = None  # на двухпутном маршрут приёма задаётся при подходе, как в симуляторе
                cand, _ = tb.pick_track(st, ti.train.length_m, h0, INF, prefer_main=not se, preferred=preferred,
                                        exclude=set(self.inp.unavailable_tracks))
                if cand is not None and self._would_lock(ti, k, cand, t_arr):
                    return t_in + LOCK_RETRY_S   # подождать на станции, а не запереть две станции
        elif not single and preferred is None:
            trk = None
        else:
            trk = preferred
            if trk is None:
                trk, _ = tb.pick_track(st, ti.train.length_m, h0, INF, prefer_main=not se,
                                       exclude=set(self.inp.unavailable_tracks))
            trk = trk or next(t.id for t in st.tracks if t.is_main)
        res = SecRes(ti.id, d, t_in, t_out)
        tb.sec[sec.id].append(res)
        tb.thr[sec.departure_throat(d)].append(dw)
        tb.thr[sec.arrival_throat(d)].append(aw)
        hold = None
        if trk is not None:
            hold = [h0, INF, ti.id]
            tb.trk[trk].append(hold)
        return {"k": k, "res": res, "aw": aw, "t_arr": t_arr, "trk": trk, "hold": hold, "se": se, "ss": ss,
                "approach": t_arr - self.r.approach_s}

    def _lock_free_track(self, ti: TrainIn, k: int, st, first: str, h0: float, t_arr: float) -> str | None:
        """Другой свободный путь на X, при котором замка нет: сначала самые короткие подходящие —
        длинный путь лучше оставить длинному встречному."""
        bad = set(self.inp.unavailable_tracks) | {first}
        for t in sorted(st.tracks, key=lambda t: t.length_m):
            if t.id in bad or t.length_m < ti.train.length_m or not self.table.track_free(t.id, h0, INF):
                continue
            if not self._would_lock(ti, k, t.id, t_arr):
                return t.id
        return None

    def _would_lock(self, ti: TrainIn, k: int, trk: str, t_arr: float) -> bool:
        """Защита от «замка» на две станции вперёд (BAGDAR_PLAN, ситуация 1).

        Поезд не занимает станцию X (путь trk), если после этого на X не останется пути,
        куда поместится встречный со следующей станции Y, которому нужна X, а самому
        поезду некуда уйти на Y. Тогда X и Y ждали бы друг друга вечно. Проверка «впереди
        есть свободный путь» спасает только от застревания на перегоне, а это круговое
        ожидание двух станций. Длины путей учитываются: короткий свободный путь длинному
        встречному не поможет."""
        legs = ti.legs
        if not ANTI_LOCK or not self.policy.anti_lock or k + 1 >= len(legs):
            return False                          # X — конечная поезда, дальше ему не нужно
        tb, w = self.table, self.world
        x_id, d = legs[k].to_id, legs[k].d
        y_id = legs[k + 1].to_id
        win = (t_arr, t_arr + LOCK_WINDOW_S)
        unavailable = self.inp.unavailable_tracks
        opp: list[int] = []                       # длины встречных, которые стоят (или встанут) на Y и ждут X
        for t in w.stations[y_id].tracks:
            for h0, h1, other in tb.trk[t.id]:
                if other == ti.id or h1 <= win[0] or h0 >= win[1]:
                    continue
                oi = self.inp.trains.get(other)
                if oi is None or y_id not in oi.train.route:
                    continue
                j = oi.train.route.index(y_id)
                if j < len(oi.legs) and oi.legs[j].to_id == x_id and oi.legs[j].d == -d:
                    opp.append(oi.train.length_m)
        # встречные, которые уже едут к Y по двухпутному перегону: путь приёма им назначат только
        # при подходе, в таблице их ещё нет, но место на Y они займут раньше нас
        coming: list[float] = []
        for s in (self.ts.values() if LOCK_COMING else ()):
            if s.phase != "section" or s.dest is not None or s.leg is None or s.ti.id == ti.id:
                continue
            if s.leg.to_id != y_id or s.t_arr >= win[1] or s.k + 1 >= len(s.ti.legs):
                continue
            nxt = s.ti.legs[s.k + 1]
            if nxt.to_id == x_id and nxt.d == -d:
                coming.append(s.ti.train.length_m)
        opp += coming
        if not opp:
            return False
        # запирается самый длинный встречный: короткий путь на X, свободный для короткого
        # встречного, длинному не поможет — он так и будет ждать на Y, пока мы не уйдём с X
        longest = max(opp) if LOCK_LONGEST else min(opp)
        if any(t.id != trk and t.id not in unavailable and t.length_m >= longest and tb.track_free(t.id, *win)
               for t in w.stations[x_id].tracks):
            return False                          # на X останется путь для любого встречного
        free_y = sorted((t for t in w.stations[y_id].tracks if t.id not in unavailable and tb.track_free(t.id, *win)),
                        key=lambda t: t.length_m)
        for length in sorted(coming, reverse=True):
            fit = next((t for t in free_y if t.length_m >= length), None)
            if fit is not None:
                free_y.remove(fit)                # подходящий встречный займёт кратчайший подходящий путь
        if any(t.length_m >= ti.train.length_m for t in free_y):
            return False                          # поезду будет куда уйти с X
        return True

    def _activate(self, s: _TS, k: int, got: dict, t_in: float) -> None:
        ti = s.ti
        leg = ti.legs[k]
        s.phase, s.k = "section", k
        s.sres, s.arr_win, s.t_arr = got["res"], got["aw"], got["t_arr"]
        s.dest, s.dest_hold, s.ss_cur = got["trk"], got["hold"], got["ss"]
        s.leg = PlanLeg(ti.id, k, leg.sec.id, leg.from_id, leg.to_id, leg.d, t_in, got["t_arr"], got["trk"] or "",
                        got["se"])
        s.legs.append(s.leg)
        s.track, s.hold = None, None
        self.entered.add((ti.id, k))
        self.policy.on_enter(ti.id, k)
        if got["trk"] is None:
            self.push(max(t_in, got["approach"]), "approach", ti.id)
        self.push(got["t_arr"], "arrive", ti.id)

    def _approach(self, tid: str, t: float) -> None:
        """Подход к станции по двухпутному перегону: задать маршрут приёма, если путь свободен."""
        s = self.ts[tid]
        if s.phase != "section" or s.dest is not None:
            return
        ti = s.ti
        li = ti.legs[s.k]
        st = self.world.stations[li.to_id]
        trk, _ = self.table.pick_track(st, ti.train.length_m, t, INF, prefer_main=not li.planned_stop_next,
                                       preferred=self.policy.track(tid, s.k),
                                       exclude=set(self.inp.unavailable_tracks))
        if trk is not None:
            s.dest = trk
            s.dest_hold = [t, INF, tid]
            self.table.trk[trk].append(s.dest_hold)
            s.leg.track_id = trk

    def _arrive(self, tid: str, t: float) -> bool:
        s = self.ts[tid]
        if s.phase != "section":
            return False
        if t + 1e-6 < s.t_arr:
            return False   # устаревшее событие: прибытие было перенесено позже
        ti = s.ti
        li = ti.legs[s.k]
        r = self.r
        # попутный не может прибыть раньше, чем впереди идущий плюс интервал
        req = t
        for res in self.table.sec[li.sec.id]:
            if res.direction == li.d and res.train_id != tid and res.t_in <= s.sres.t_in:
                req = max(req, res.t_out + r.headway_arr_s)
        if req > t + 0.5:
            if req >= INF / 2:
                s.sres.t_out = INF
                self._retry_later(s, t, None)
            else:
                self._move_arrival(s, li, req)
            return False
        if s.dest is None:
            st = self.world.stations[li.to_id]
            trk, rr = self.table.pick_track(st, ti.train.length_m, t, INF, prefer_main=False,
                                            exclude=set(self.inp.unavailable_tracks))
            if trk is None:
                s.sres.t_out = INF
                self._retry_later(s, t, rr)
                return False
            s.dest = trk
            s.dest_hold = [t, INF, tid]
            self.table.trk[trk].append(s.dest_hold)
            s.leg.track_id = trk
            # маршрут задан только сейчас: поезд стоял у входного и въезжает через approach_s
            s.ss_cur = True
            self.waiting.discard(tid)
            self._move_arrival(s, li, t + r.approach_s)
            return True
        self.waiting.discard(tid)
        rec, sres, aw = s.leg, s.sres, s.arr_win
        hold_now = ti.hold_extra > 0 and not s.hold_applied and ti.phase == "section" and s.k == ti.k
        if s.forced is not None:
            # разрешение на проход уже выдано в реальности
            rec.arr, rec.stop = t, False
            sres.t_out = t
            aw[1] = t
            if s.dest_hold is not None:
                s.dest_hold[1] = t + self.r.clear_s
            got, s.forced = s.forced, None
            delta = t - got["res"].t_in
            if delta > 0:
                # прибытие сдвинулось — заранее выданный проход сдвигается целиком
                got["res"].t_in += delta
                got["res"].t_out += delta
                got["aw"][0] += delta
                got["aw"][1] += delta
                got["t_arr"] += delta
            self._activate(s, s.k + 1, got, t)
            return True
        if not li.last and not li.planned_stop_next and not hold_now:
            s.phase, s.k, s.hold, s.track = "station", s.k + 1, s.dest_hold, s.dest
            ok, _ = self._depart(tid, t, through=True)
            if ok:
                rec.arr, rec.stop = t, False
                sres.t_out = min(sres.t_out, t)
                aw[1] = min(aw[1], t)
                return True
            s.phase, s.k, s.hold, s.track = "section", s.k - 1, None, None
        dec = 0.0 if li.planned_stop_next else li.run(s.ss_cur, True) - li.run(s.ss_cur, False)
        t_stop = t + dec
        rec.arr, rec.stop = t_stop, True
        sres.t_out = t_stop
        aw[1] = t_stop
        s.phase, s.k, s.track, s.hold, s.stopped = "station", s.k + 1, s.dest, s.dest_hold, True
        if li.last:
            s.hold[1] = t_stop + self.r.terminate_s
            s.phase = "done"
            return True
        dwell = li.dwell_next if li.planned_stop_next else self.r.min_stop_s
        if hold_now:
            dwell += ti.hold_extra
            s.hold_applied = True
        ready = t_stop + dwell
        if li.pax_stop_next and li.sched_dep_next is not None:
            ready = max(ready, li.sched_dep_next)
        s.t_ready = ready
        self.push(ready, "ready", tid)
        return True

    def _move_arrival(self, s: _TS, li, t_new: float) -> None:
        """Прибытие откладывается: поезд ждёт на перегоне. Окно горловины переносится
        на ближайшее свободное, а не растягивается поверх чужих маршрутов."""
        r = self.r
        dec = 0.0 if li.planned_stop_next else li.run(s.ss_cur, True) - li.run(s.ss_cur, False)
        others = [x for x in self.table.thr[li.sec.arrival_throat(li.d)] if x is not s.arr_win]
        for _ in range(200):
            rr = interval_retry(others, t_new - r.approach_s, t_new + dec)
            if rr is None:
                break
            if rr >= INF / 2:
                # горловину держит поезд без известного времени — ждём освобождения
                s.sres.t_out = INF
                self._retry_later(s, t_new, None)
                return
            t_new = rr + r.approach_s
        s.arr_win[0], s.arr_win[1] = t_new - r.approach_s, t_new + dec
        s.sres.t_out = t_new + dec
        s.t_arr = t_new
        s.leg.arr = t_new
        self.push(t_new, "arrive", s.ti.id)

    # ------------------------------------------------------------ результат
    def _plan(self, held: list[str]) -> Plan:
        legs: dict[str, list[PlanLeg]] = {}
        origin: dict[str, str] = {}
        start: dict[str, StartHold] = {}
        for tid, s in self.ts.items():
            if s.legs and s.phase == "section" and s.dest is None:
                # путь приёма так и не назначен (станция занята до конца расчёта) — плечо не публикуем
                s.legs = [lg for lg in s.legs if lg.track_id]
            if s.legs:
                legs[tid] = sorted(s.legs, key=lambda x: x.k)
            if s.origin_track:
                origin[tid] = s.origin_track
            if s.start_hold is not None:
                start[tid] = s.start_hold
        return Plan(version=0, created_at=self.inp.t0, solver="greedy", status="feasible", legs=legs,
                    origin_track=origin, start_hold=start, horizon_end=self.h_end, held=held)


# ======================================================================= политики
class PriorityPolicy(Policy):
    """Эвристика Бағдара: экономическое сравнение с заглядыванием на шаг вперёд."""

    def __init__(self, inp: PlanningInput, prefer_schedule_tracks: bool = True) -> None:
        self.inp = inp
        self.cfg = inp.cfg
        self.r = inp.rules
        self.prefer = prefer_schedule_tracks

    def sort_key(self, sched: ForwardScheduler, tid: str) -> tuple:
        ti = self.inp.trains[tid]
        return (0 if ti.extra else 1, -ti.w * (1 + max(0.0, ti.lateness0) / 600), tid)

    def track(self, tid: str, k: int) -> str | None:
        if not self.prefer:
            return None
        tr = self.inp.trains[tid].train
        return tr.schedule[k + 1].track_id if 0 <= k + 1 < len(tr.schedule) else tr.schedule[0].track_id

    def not_before(self, tid: str, k: int, through: bool) -> float | None:
        # пока поезд не опаздывает, он идёт по расписанию и не забегает вперёд
        dep = self.inp.trains[tid].train.schedule[k].dep
        return None if dep is None else dep - (60 if through else 0)

    def arrive_not_before(self, tid: str, k: int) -> float | None:
        return self.inp.trains[tid].train.schedule[k + 1].arr

    # --- оценка цены ожидания (та же логика, что в карточках решений) ---
    def wait_cost(self, ti: TrainIn, station_idx: int, t_dep: float, wait: float, extra_stop: bool,
                  leg_k: int) -> tuple[float, float, float]:
        """(цена у.е., опоздание до, опоздание после) при ожидании wait на станции station_idx."""
        sched = ti.train.schedule[station_idx]
        ref = sched.dep if sched.dep is not None else sched.arr
        before = max(0.0, t_dep - ref) if ref is not None else 0.0
        after = max(0.0, t_dep + wait - ref) if ref is not None else 0.0
        cost = ti.w * (after - before) / 60 + self.cfg.cost.c_idle * wait / 60
        if extra_stop and leg_k >= 1:
            li = ti.legs[leg_k - 1]
            cost += stop_cost(self.cfg, ti.train.mass_t, li.v_cruise, li.uphill_after)
        return cost, before, after

    @staticmethod
    def unavoidable(ti: TrainIn, station_idx: int) -> float:
        """Опоздание на отправлении со станции, которого не избежать даже без других поездов."""
        sched = ti.train.schedule[station_idx]
        ref = sched.dep if sched.dep is not None else sched.arr
        e = ti.earliest_dep[station_idx] if station_idx < len(ti.earliest_dep) else None
        if ref is None or e is None:
            return 0.0
        return max(0.0, e - ref)

    def j_should_yield(self, j: TrainIn, i: TrainIn, j_station: int, i_station: int, t_j: float, t_i: float,
                       wait_j: float, wait_i: float, j_through: bool, i_through: bool,
                       kj: int, ki: int) -> bool:
        if i.extra and not j.extra:
            return True
        cj, bj, aj = self.wait_cost(j, j_station, t_j, wait_j, j_through, kj)
        ci, bi, ai = self.wait_cost(i, i_station, t_i, wait_i, i_through, ki)
        if self.cfg.pte_strict:
            # слой 2 — по накопленной задержке, как в CP-SAT: старший не может опоздать больше,
            # чем неизбежно (по его самому раннему ходу без других поездов) плюс допуск.
            # Сравнение с «до ожидания» пропускало серию скрещений по 3–4 мин каждое.
            if i.rank < j.rank and ai > self.unavoidable(i, i_station) + i.tol:
                return True
            if j.rank < i.rank and aj > self.unavoidable(j, j_station) + j.tol:
                return False
        if abs(cj - ci) < 1e-6:
            return self.sort_key(None, i.id) < self.sort_key(None, j.id)  # type: ignore[arg-type]
        return cj < ci

    def request_time(self, sched: ForwardScheduler, tid: str, sec_id: str, t: float) -> tuple[float, int, bool, int] | None:
        """(когда поезд запросит перегон, индекс станции, идёт ли без остановки, индекс плеча)."""
        s = sched.ts[tid]
        ti = s.ti
        n = len(ti.legs)
        if s.phase == "station" and s.k < n and ti.legs[s.k].sec.id == sec_id and (tid, s.k) not in sched.entered:
            return max(t, s.t_ready), s.k, False, s.k
        if s.phase == "pending" and n and ti.legs[0].sec.id == sec_id:
            return max(t, ti.t_ready), 0, False, 0
        if s.phase == "section" and s.k + 1 < n and ti.legs[s.k + 1].sec.id == sec_id \
                and (tid, s.k + 1) not in sched.entered:
            li = ti.legs[s.k]
            if li.planned_stop_next:
                tr = s.t_arr + li.dwell_next
                if li.pax_stop_next and li.sched_dep_next is not None:
                    tr = max(tr, li.sched_dep_next)
                return tr, s.k + 1, False, s.k + 1
            return s.t_arr, s.k + 1, True, s.k + 1
        return None

    def allow(self, sched: ForwardScheduler, tid: str, k: int, t: float, through: bool) -> bool:
        s = sched.ts[tid]
        j = s.ti
        if j.extra:
            return True
        leg = j.legs[k]
        sec, d = leg.sec, leg.d
        r = self.r
        j_run = leg.run(not through, leg.planned_stop_next)
        here = leg.from_id
        own = {s.track} if s.track else set()
        for i_id, si in sched.ts.items():
            if i_id == tid or si.phase == "done":
                continue
            i = si.ti
            ki = next((x for x, li_ in enumerate(i.legs) if li_.sec.id == sec.id), None)
            if ki is None:
                continue
            li = i.legs[ki]
            req = self.request_time(sched, i_id, sec.id, t)
            if req is None and (i.extra or (self.cfg.pte_strict and i.rank < j.rank)) and not j.extra:
                # внеочередной (слой 1) или старший в строгом ПТЭ дальше одного перегона —
                # учитываем по самому раннему подходу
                cur = si.k if si.phase in ("station", "pending") else si.k + 1
                if ki >= cur and (i_id, ki) not in sched.entered and i.earliest_dep[ki] is not None:
                    req = (max(t, i.earliest_dep[ki]), ki, not i.legs[ki - 1].planned_stop_next if ki > 0 else False, ki)
            if req is None:
                continue
            e_i, i_station, i_through, _ = req
            if li.d != d:
                # скрещение на однопутном перегоне
                if sec.tracks != 1:
                    continue
                clear_j = t + j_run + r.tau_cross_s
                if e_i >= clear_j:
                    continue
                if not sched.track_possible(i_id, here, e_i, own):
                    continue  # встречному некуда встать — придерживать бессмысленно
                i_run = li.run(not i_through, li.planned_stop_next)
                wait_i = clear_j - e_i
                wait_j = max(0.0, e_i + i_run + r.tau_cross_s - t)
                if self.j_should_yield(j, i, k, i_station, t, e_i, wait_j, wait_i, through, i_through, k, ki):
                    return False
            else:
                # обгон: догоняющий поезд на этой же станции или на подходе к ней
                if i.train.route[i_station] != here or e_i > t + 20 * 60:
                    continue
                i_free_arr = e_i + li.run(not i_through, li.planned_stop_next)
                j_arr = t + j_run
                if i_free_arr >= j_arr + r.headway_arr_s:
                    continue  # не мешает
                if si.phase == "section" and not sched.track_possible(i_id, here, e_i - r.approach_s, own):
                    continue
                delay_i = j_arr + r.headway_arr_s - i_free_arr
                wait_j = max(0.0, e_i + r.headway_s - t)
                if self.j_should_yield(j, i, k, i_station, t, e_i, wait_j, delay_i, through, False, k, ki):
                    return False
        return True


class OrderPolicy(Policy):
    """Порядок входа на перегоны задан планом. Плечи вне плана — по запасной политике."""

    def __init__(self, inp: PlanningInput, plan: Plan, fallback: Policy | None = None,
                 swap: tuple[tuple[str, int], tuple[str, int], tuple[str, int]] | None = None,
                 can_relax: bool = False, keep_times: bool = True, release: set[str] | None = None) -> None:
        self.inp = inp
        self.fallback = fallback
        self.can_relax = can_relax
        self.keep_times = keep_times
        # у оцениваемой пары плановые времена не действуют (и в базе, и в альтернативе)
        self.released: set[str] = set(release or ()) | ({swap[1][0], swap[2][0]} if swap else set())
        self.arr: dict[tuple[str, int], float] = {}
        self.seq: dict[tuple[str, int], list[tuple[str, int]]] = {}
        self.member: dict[tuple[str, int], tuple[str, int]] = {}
        self.tracks: dict[tuple[str, int], str] = {}
        self.dep: dict[tuple[str, int], float] = {}
        for key, legs in section_sequences(plan, inp.world, inp.entered).items():
            lst = [(lg.train_id, lg.k) for lg in legs]
            if swap is not None and swap[0] == key and swap[1] in lst and swap[2] in lst:
                a, b = swap[1], swap[2]
                lst.remove(b)
                lst.insert(lst.index(a), b)
            self.seq[key] = lst
            for item in lst:
                self.member[item] = key
        for lg in plan.all_legs():
            self.tracks[(lg.train_id, lg.k)] = lg.track_id
            self.dep[(lg.train_id, lg.k)] = lg.dep
            self.arr[(lg.train_id, lg.k)] = lg.arr
        self.origin = dict(plan.origin_track)

    def not_before(self, tid: str, k: int, through: bool) -> float | None:
        if not self.keep_times or tid in self.released:
            return None
        d = self.dep.get((tid, k))
        return None if d is None else d - (60 if through else 0)

    def arrive_not_before(self, tid: str, k: int) -> float | None:
        if not self.keep_times or tid in self.released:
            return None
        return self.arr.get((tid, k))

    def sort_key(self, sched: ForwardScheduler, tid: str) -> tuple:
        s = sched.ts[tid]
        return (self.dep.get((tid, s.k), INF), tid)

    def track(self, tid: str, k: int) -> str | None:
        if k < 0:
            return self.origin.get(tid)
        return self.tracks.get((tid, k)) or (self.fallback.track(tid, k) if self.fallback else None)

    def allow(self, sched: ForwardScheduler, tid: str, k: int, t: float, through: bool) -> bool:
        key = self.member.get((tid, k))
        if key is None:
            return self.fallback.allow(sched, tid, k, t, through) if self.fallback else True
        for item in self.seq[key]:
            if item == (tid, k):
                return True
            u = item[0]
            if item in sched.entered or u not in sched.ts or sched.ts[u].phase == "done":
                continue
            return False
        return True


class FifoPolicy(Policy):
    """«Кто первый пришёл, тот первый едет» — эталон «без Бағдара».

    Без приоритетов, без заглядывания вперёд и без придержаний: поезд занимает
    ресурс, как только он свободен. Защита от застревания на однопутном перегоне
    остаётся (это СЦБ, а не диспетчер). Поезда идут по расписанию и не раньше него.

    anti_lock=False — эталон для отчёта «до / после»: правила «на две станции вперёд»
    нет, станции могут запереться. anti_lock=True — кандидат планировщика: тот же
    порядок, но с защитой от замка (без неё исполнение такого плана запирало участок)."""
    can_relax = False

    def __init__(self, inp: PlanningInput, anti_lock: bool = False) -> None:
        self.inp = inp
        self.anti_lock = anti_lock

    def sort_key(self, sched: "ForwardScheduler", tid: str) -> tuple:
        s = sched.ts[tid]
        return (s.retry_at if s.retry_at < INF else 0.0, tid)

    def track(self, tid: str, k: int) -> str | None:
        tr = self.inp.trains[tid].train
        return tr.schedule[k + 1].track_id if 0 <= k + 1 < len(tr.schedule) else tr.schedule[0].track_id

    def not_before(self, tid: str, k: int, through: bool) -> float | None:
        dep = self.inp.trains[tid].train.schedule[k].dep
        return None if dep is None else dep - (60 if through else 0)

    def arrive_not_before(self, tid: str, k: int) -> float | None:
        return self.inp.trains[tid].train.schedule[k + 1].arr


def run_fifo(inp: PlanningInput, horizon_end: float | None = None, anti_lock: bool = False) -> ForwardResult:
    return ForwardScheduler(inp, FifoPolicy(inp, anti_lock), horizon_end=horizon_end).run()


def run_greedy(inp: PlanningInput) -> ForwardResult:
    return ForwardScheduler(inp, PriorityPolicy(inp)).run()


def run_repair(inp: PlanningInput, plan: Plan) -> ForwardResult:
    """Прошлый план, восстановленный к текущему состоянию: тот же порядок, новые времена."""
    return ForwardScheduler(inp, OrderPolicy(inp, plan, fallback=PriorityPolicy(inp), can_relax=True)).run()


def run_with_order(inp: PlanningInput, plan: Plan, swap=None, release: set[str] | None = None) -> ForwardResult:
    """Оценка плана с заданным порядком (и, возможно, одной перестановкой)."""
    return ForwardScheduler(inp, OrderPolicy(inp, plan, fallback=None, swap=swap, can_relax=False,
                                             release=release)).run()
