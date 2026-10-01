"""Модель CP-SAT планировщика зоны на скользящем горизонте.

Переменные (секунды от момента планирования t0):
  dep[i,k], arr[i,k]  — вход на перегон k и прибытие на следующую станцию;
  se[i,k]             — остановка поезда i в конце плеча k (плановая — константа 1);
  x[i,k,τ]            — путь приёма τ на станции в конце плеча k;
  b[p,q]              — порядок двух поездов на общем перегоне.

Жёсткие ограничения (слой 0): время хода с учётом разгона и торможения;
стоянки; пассажирский не уходит раньше расписания; встречные на однопутном
перегоне и любые поезда при ПАБ не пересекаются (интервал скрещения τ);
попутные при АБ — межпоездной интервал на входе и выходе, без обгона на
перегоне; NoOverlap по каждому пути станции (с длиной поезда) и по каждой
горловине. Путь приёма перед однопутным перегоном закрепляется с момента
отправления — защита от взаимной блокировки.
Слой 1: внеочередные идут первыми. Слой 2 (pte_strict): младший вперёд
старшего только если старший остаётся в своём допуске.
Слой 3: минимум J (см. economics.py).

Тёплый старт: подсказка — лучший из двух планов-эвристик (восстановленный
прошлый план или свежая эвристика). Заморозка: решения ближайших
freeze_min минут из прошлого плана не меняются. Пары поездов, далёкие по
времени (> pair_window_min), не переупорядочиваются.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from bagdar.models.plan import Plan, PlanLeg, StartHold
from bagdar.planner.economics import PAX_STOP_FACTOR, PTE_WINDOW_S, stop_cost
from bagdar.planner.inputs import PlanningInput

DET_RATIO = 8.0
EXTRA_PENALTY = 100 * 20000          # 20 000 у.е. за каждый случай «внеочередной не первым»
PTE_PENALTY = int(100 * 1000 / 60)   # 1000 у.е. за минуту сверх допуска старшего (в сотых, за секунду)

STATUS_NAME = {cp_model.OPTIMAL: "optimal", cp_model.FEASIBLE: "feasible", cp_model.INFEASIBLE: "infeasible",
               cp_model.MODEL_INVALID: "invalid", cp_model.UNKNOWN: "unknown"}


@dataclass
class CpStats:
    status: str = "not_run"
    build_ms: float = 0.0
    solve_ms: float = 0.0
    objective: float | None = None
    bound: float | None = None
    legs: int = 0
    trains: int = 0
    order_vars: int = 0
    fixed_pairs: int = 0
    intervals: int = 0
    freeze: bool = True
    warm: bool = False
    pte_violations: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"status": self.status, "build_ms": round(self.build_ms, 1), "solve_ms": round(self.solve_ms, 1),
                "objective": None if self.objective is None else round(self.objective, 1),
                "bound": None if self.bound is None else round(self.bound, 1), "legs": self.legs,
                "trains": self.trains, "order_vars": self.order_vars, "fixed_pairs": self.fixed_pairs,
                "intervals": self.intervals, "freeze": self.freeze, "warm": self.warm,
                "pte_violations": len(self.pte_violations)}


@dataclass
class _L:
    tid: str
    k: int
    dep: object          # IntVar или int
    arr: object
    ss: object           # 0/1 или BoolVar
    se: object
    started: bool
    entered: bool
    ref_dep: float
    in_ref: bool = False
    options: list[str] = field(default_factory=list)
    x: dict = field(default_factory=dict)


def _ci(v: float) -> int:
    return int(math.ceil(v - 1e-9))


def solve_cpsat(inp: PlanningInput, ref: Plan | None, time_limit_s: float, workers: int = 8,
                deterministic: bool = False, use_freeze: bool = True,
                debug_disable: frozenset[str] = frozenset()) -> tuple[Plan | None, CpStats]:
    t_build = time.perf_counter()
    st = CpStats(freeze=use_freeze)
    r, cfg, world = inp.rules, inp.cfg, inp.world
    T0 = inp.t0
    rel = lambda t: int(round(t - T0))  # noqa: E731
    H = rel(inp.horizon_end)
    DOM = H + 6 * 3600
    LOW = -48 * 3600
    W = cfg.planner.pair_window_min * 60
    prev = inp.prev_plan if use_freeze else None
    m = cp_model.CpModel()
    obj: list = []
    hints: list[tuple[object, int]] = []
    C = 100.0  # объектив в сотых долях у.е.

    def ref_leg(tid: str, k: int) -> PlanLeg | None:
        return ref.leg(tid, k) if ref is not None else None

    legs: dict[tuple[str, int], _L] = {}
    per_train: dict[str, list[_L]] = {}
    track_iv: dict[str, list] = {}
    throat_iv: dict[str, list] = {}
    origin_x: dict[str, list] = {}

    def add_track_iv(track: str, iv) -> None:
        track_iv.setdefault(track, []).append(iv)
        st.intervals += 1

    def add_throat_iv(th: str, iv) -> None:
        throat_iv.setdefault(th, []).append(iv)
        st.intervals += 1

    # ------------------------------------------------------------ переменные плеч
    for tid in sorted(inp.trains):
        ti = inp.trains[tid]
        if ti.phase == "terminal":
            end = max(1, rel(ti.finish_at))
            add_track_iv(ti.track, m.new_fixed_size_interval_var(0, end, f"term_{tid}"))
            continue
        k0 = ti.first_leg()
        chosen: list[int] = []
        for k in range(k0, len(ti.legs)):
            if ti.phase == "section" and k == ti.k:
                chosen.append(k)
                continue
            e = ti.earliest_dep[k]
            rl = ref_leg(tid, k)
            if rl is None and ref is not None and "allegs" not in debug_disable:
                break
            start = min(e if e is not None else 1e18, rl.dep if rl else 1e18)
            if start > inp.horizon_end:
                break
            chosen.append(k)
        if not chosen:
            if ti.phase == "station":
                add_track_iv(ti.track, m.new_fixed_size_interval_var(0, DOM, f"held_{tid}"))
            continue
        lst: list[_L] = []
        for idx, k in enumerate(chosen):
            li = ti.legs[k]
            started = ti.phase == "section" and k == ti.k
            entered = started or (tid, k) in inp.entered
            rl = ref_leg(tid, k)
            if started:
                dep: object = rel(ti.since)
            else:
                lb = rel(ti.earliest_dep[k]) if ti.earliest_dep[k] is not None else 0
                dep = m.new_int_var(max(0, lb), DOM, f"dep_{tid}_{k}")
                if rl:
                    hints.append((dep, max(max(0, lb), rel(rl.dep))))
            arr = m.new_int_var(LOW, DOM, f"arr_{tid}_{k}")
            if rl:
                hints.append((arr, rel(rl.arr)))
            if li.planned_stop_next or li.last:
                se: object = 1
            elif started and ti.through_next:
                se = 0
            elif started and ti.hold_extra > 0:
                se = 1
            else:
                se = m.new_bool_var(f"se_{tid}_{k}")
                if rl:
                    hints.append((se, int(rl.stop)))
            if idx == 0:
                ss: object = 0 if started else 1
            else:
                ss = lst[-1].se
            ref_dep = rl.dep if rl else (ti.earliest_dep[k] if ti.earliest_dep[k] is not None else ti.since)
            L = _L(tid, k, dep, arr, ss, se, started, entered, ref_dep, in_ref=rl is not None)
            lst.append(L)
            legs[(tid, k)] = L
            # время хода
            if started:
                dec = _ci(li.run(False, True) - li.run(False, False))
                base = rel(ti.t_arr_est)
                if isinstance(se, int):
                    m.add(arr >= base)
                else:
                    m.add(arr >= base + dec * se)
            else:
                r00, r10, r01, r11 = li.r
                # округление до ближайшей секунды: запас хода в плане (run_margin) покрывает погрешность
                lin = round(r00) + round(r10 - r00) * ss + round(r01 - r00) * se
                corr = r11 - r10 - r01 + r00
                if corr > 0.5 and not isinstance(ss, int) and not isinstance(se, int):
                    both = m.new_bool_var(f"both_{tid}_{k}")
                    m.add_multiplication_equality(both, [ss, se])
                    lin = lin + round(corr) * both
                m.add(arr - dep >= lin)
                if "ub" not in debug_disable:
                    m.add(arr - dep <= _ci(max(1.5 * r11, r11 + 120)))
        per_train[tid] = lst
        st.trains += 1
        st.legs += len(lst)

        # стоянки между плечами
        for a, b in zip(lst, lst[1:]):
            li = ti.legs[a.k]
            extra = ti.hold_extra if (a.started and ti.hold_extra > 0) else 0.0
            if li.planned_stop_next:
                m.add(b.dep - a.arr >= _ci(li.dwell_next + extra))
                if li.pax_stop_next and li.sched_dep_next is not None:
                    m.add(b.dep >= rel(li.sched_dep_next))
                if not li.pax_stop_next:
                    idle = m.new_int_var(0, DOM, f"idle_{tid}_{a.k}")
                    m.add(idle >= b.dep - a.arr - _ci(li.dwell_next + extra))
                    obj.append(idle * _ci(C * cfg.cost.c_idle / 60))
            else:
                if isinstance(a.se, int):
                    m.add(b.dep - a.arr >= _ci(r.min_stop_s * a.se + extra))
                    if a.se == 0:
                        m.add(b.dep == a.arr)
                else:
                    m.add(b.dep - a.arr >= _ci(r.min_stop_s) * a.se)
                    m.add(b.dep - a.arr <= DOM * a.se)
                idle = m.new_int_var(0, DOM, f"idle_{tid}_{a.k}")
                m.add(idle >= b.dep - a.arr - _ci(r.min_stop_s) * a.se)
                obj.append(idle * _ci(C * cfg.cost.c_idle / 60))
        first = lst[0]
        if not first.started:
            m.add(first.dep >= max(0, rel(ti.t_ready)))
            obj.append((first.dep - max(0, rel(ti.t_ready))) * _ci(C * cfg.cost.c_idle / 60))

        # пути станций
        if ti.phase == "station":
            end = first.dep + _ci(r.clear_s)
            size = m.new_int_var(0, DOM, f"hsz_{tid}")
            add_track_iv(ti.track, m.new_interval_var(0, size, end, f"hold_{tid}"))
        if ti.phase == "pending":
            opts = inp.fitting_tracks(ti.train.route[0], ti.train.length_m)
            if ti.origin_track in opts:
                opts.remove(ti.origin_track)
                opts.insert(0, ti.origin_track)
            s0 = m.new_int_var(0, DOM, f"os_{tid}")
            m.add_max_equality(s0, [first.dep - _ci(r.prep_s), 0])
            end = first.dep + _ci(r.clear_s)
            xs = []
            for tr_id in opts:
                x = m.new_bool_var(f"ox_{tid}_{tr_id}")
                size = m.new_int_var(0, DOM, f"osz_{tid}_{tr_id}")
                add_track_iv(tr_id, m.new_optional_interval_var(s0, size, end, x, f"oiv_{tid}_{tr_id}"))
                xs.append((tr_id, x))
            m.add_exactly_one(x for _, x in xs)
            origin_x[tid] = xs
            if xs:
                hints.append((xs[0][1], 1))
        for i, L in enumerate(lst):
            li = ti.legs[L.k]
            S = li.to_id
            keep = None
            if L.started and ti.dest_track:
                opts = [ti.dest_track]
            elif ti.through_next and L.k == ti.k + 1 and ti.next_dest_track:
                opts = [ti.next_dest_track]
            else:
                opts = inp.fitting_tracks(S, ti.train.length_m, keep=keep)
                pl = prev.leg(tid, L.k) if prev is not None else None
                rl0 = ref_leg(tid, L.k)
                if pl is not None and pl.dep < inp.freeze_until and pl.track_id in opts and not L.entered \
                        and (rl0 is None or rl0.track_id == pl.track_id):
                    opts = [pl.track_id]
            if not opts:
                st.notes.append(f"нет пути подходящей длины для {ti.train.number} на {S}")
                return None, _finish(st, t_build, "invalid")
            L.options = opts
            single = li.sec.tracks == 1
            if single:
                start = L.dep if not L.started else max(0, rel(ti.since))
            else:
                start = L.arr - _ci(r.approach_s)
            if li.last:
                end = L.arr + _ci(r.terminate_s)
            elif i + 1 < len(lst):
                end = lst[i + 1].dep + _ci(r.clear_s)
            else:
                end = m.new_int_var(0, DOM, f"hend_{tid}_{L.k}")
                m.add_max_equality(end, [L.arr + _ci(li.dwell_next + r.clear_s), H])
            rl = ref_leg(tid, L.k)
            for tr_id in opts:
                x = 1 if len(opts) == 1 else m.new_bool_var(f"x_{tid}_{L.k}_{tr_id}")
                size = m.new_int_var(0, 2 * DOM, f"sz_{tid}_{L.k}_{tr_id}")
                if isinstance(x, int):
                    add_track_iv(tr_id, m.new_interval_var(start, size, end, f"iv_{tid}_{L.k}_{tr_id}"))
                else:
                    add_track_iv(tr_id, m.new_optional_interval_var(start, size, end, x,
                                                                    f"iv_{tid}_{L.k}_{tr_id}"))
                    if rl and rl.track_id == tr_id:
                        hints.append((x, 1))
                L.x[tr_id] = x
            if len(opts) > 1:
                m.add_exactly_one(v for v in L.x.values())
            # горловины
            sec, d = li.sec, li.d
            if not L.started:
                if isinstance(L.ss, int):
                    if L.ss == 1:
                        add_throat_iv(sec.departure_throat(d),
                                      m.new_fixed_size_interval_var(L.dep, _ci(r.throat_s), f"dw_{tid}_{L.k}"))
                    else:
                        add_throat_iv(sec.departure_throat(d),
                                      m.new_fixed_size_interval_var(L.dep - _ci(r.approach_s),
                                                                    _ci(r.approach_s + r.throat_s),
                                                                    f"dw_{tid}_{L.k}"))
                else:
                    w0 = m.new_int_var(LOW, DOM, f"dw0_{tid}_{L.k}")
                    m.add(w0 == L.dep - _ci(r.approach_s) + _ci(r.approach_s) * L.ss)
                    sz = m.new_int_var(_ci(r.throat_s), _ci(r.throat_s + r.approach_s), f"dwz_{tid}_{L.k}")
                    m.add(sz == _ci(r.throat_s + r.approach_s) - _ci(r.approach_s) * L.ss)
                    add_throat_iv(sec.departure_throat(d),
                                  m.new_interval_var(w0, sz, L.dep + _ci(r.throat_s), f"dwi_{tid}_{L.k}"))
            add_throat_iv(sec.arrival_throat(d),
                          m.new_fixed_size_interval_var(L.arr - _ci(r.approach_s), _ci(r.approach_s),
                                                        f"aw_{tid}_{L.k}"))
            # задержки
            if li.sched_arr_next is not None:
                is_last = i == len(lst) - 1
                factor = 1.0 if is_last else (PAX_STOP_FACTOR if li.pax_stop_next else 0.0)
                if factor > 0:
                    late = m.new_int_var(0, DOM + 48 * 3600, f"late_{tid}_{L.k}")
                    m.add(late >= L.arr - rel(li.sched_arr_next))
                    obj.append(late * max(1, int(round(C * factor * ti.w / 60))))
            if not isinstance(L.se, int) and not li.planned_stop_next:
                obj.append(L.se * int(round(C * stop_cost(cfg, ti.train.mass_t, li.v_cruise, li.uphill_after))))

    if "throat" not in debug_disable:
        for th, ivs in throat_iv.items():
            m.add_no_overlap(ivs)
    if "track" not in debug_disable:
        for tr_id, ivs in track_iv.items():
            m.add_no_overlap(ivs)

    # ------------------------------------------------------------ перегоны: пары поездов
    by_sec: dict[str, list[_L]] = {}
    for L in legs.values():
        by_sec.setdefault(inp.trains[L.tid].legs[L.k].sec.id, []).append(L)
    prev_order: dict[tuple, bool] = {}
    if inp.prev_plan is not None:
        for sid, lst_ in by_sec.items():
            for p in lst_:
                pp = inp.prev_plan.leg(p.tid, p.k)
                if pp is not None:
                    prev_order[(p.tid, p.k)] = pp.dep
    change_coef = int(round(C * cfg.cost.c_change))
    pte_terms: list = []
    tau, h, h_arr = _ci(r.tau_cross_s), _ci(r.headway_s), _ci(r.headway_arr_s)
    only = {x[5:] for x in debug_disable if x.startswith("only:")}
    for sid, items in by_sec.items():
        sec = world.sections[sid]
        if only and sid not in only:
            continue
        items.sort(key=lambda L: (L.ref_dep, L.tid))
        for a_i in range(len(items)):
            p = items[a_i]
            tp = inp.trains[p.tid]
            lp = tp.legs[p.k]
            for q in items[a_i + 1:]:
                if q.tid == p.tid:
                    continue
                tq = inp.trains[q.tid]
                lq = tq.legs[q.k]
                if p.started and q.started:
                    continue
                if sec.tracks == 2 and lp.d != lq.d:
                    continue
                exclusive = lp.d != lq.d or sec.signalling == "PAB"
                fixed: bool | None = None          # True — p раньше q
                if p.entered and not q.entered:
                    fixed = True
                elif q.entered and not p.entered:
                    fixed = False
                elif p.entered and q.entered:
                    fixed = p.ref_dep <= q.ref_dep
                elif frozenset(((p.tid, p.k), (q.tid, q.k))) in inp.overrides:
                    # решение диспетчера (отмена B или выбор варианта C) — закон для планировщика
                    fixed = inp.overrides[frozenset(((p.tid, p.k), (q.tid, q.k)))] == (p.tid, p.k)
                elif tp.extra != tq.extra:
                    fixed = None               # слой 1 решается штрафом EXTRA_PENALTY (см. ниже)
                elif prev is not None and (p.tid, p.k) in prev_order and (q.tid, q.k) in prev_order and \
                        min(prev_order[(p.tid, p.k)], prev_order[(q.tid, q.k)]) < inp.freeze_until and \
                        (not (p.in_ref and q.in_ref) or
                         (prev_order[(p.tid, p.k)] <= prev_order[(q.tid, q.k)]) == (p.ref_dep <= q.ref_dep)):
                    # заморозка: ближайшие решения прошлого плана не меняются
                    fixed = prev_order[(p.tid, p.k)] <= prev_order[(q.tid, q.k)]
                elif p.in_ref and q.in_ref and abs(p.ref_dep - q.ref_dep) > W and "window" not in debug_disable:
                    fixed = p.ref_dep <= q.ref_dep
                if fixed is None:
                    b = m.new_bool_var(f"b_{p.tid}_{p.k}_{q.tid}_{q.k}")
                    st.order_vars += 1
                    if p.in_ref and q.in_ref:
                        hints.append((b, 1 if p.ref_dep <= q.ref_dep else 0))   # согласованная подсказка
                    elif tp.extra != tq.extra:
                        hints.append((b, 1 if tp.extra else 0))
                    if tp.extra != tq.extra:
                        # слой 1: внеочередной первым — лексикографически выше ПТЭ и экономики;
                        # штраф, а не запрет, потому что иногда впереди идущему негде пропустить
                        obj.append(((1 - b) if tp.extra else b) * EXTRA_PENALTY)
                    lits = [(b, p, q), (b.Not(), q, p)]
                else:
                    st.fixed_pairs += 1
                    lits = [(None, p, q) if fixed else (None, q, p)]
                if "pairs" in debug_disable:
                    continue
                for lit, first_, second in lits:
                    cons = []
                    if exclusive:
                        cons.append(m.add(second.dep >= first_.arr + tau))
                    else:
                        cons.append(m.add(second.dep >= first_.dep + h))
                        cons.append(m.add(second.arr >= first_.arr + h_arr))
                    if lit is not None:
                        for c in cons:
                            c.only_enforce_if(lit)
                if fixed is None:
                    # слой 2: младший вперёд старшего — только если старший в допуске
                    if cfg.pte_strict and tp.rank != tq.rank and not tp.extra and not tq.extra \
                            and abs(p.ref_dep - q.ref_dep) <= PTE_WINDOW_S:
                        senior, s_leg, junior_first = (p, lp, b.Not()) if tp.rank < tq.rank else (q, lq, b)
                        ts_ = inp.trains[senior.tid]
                        if s_leg.sched_arr_next is not None:
                            e = ts_.earliest_dep[senior.k]
                            lb_arr = (e if e is not None else T0) + s_leg.run(True, s_leg.planned_stop_next)
                            lb_late = max(0.0, lb_arr - s_leg.sched_arr_next)
                            bound = lb_late + ts_.tol   # из-за младших — не больше допуска старшего
                            # лексикографически: штраф несоизмеримо больше экономики слоя 3,
                            # поэтому нарушение возможно, только если избежать его нельзя
                            exc = m.new_int_var(0, DOM + 48 * 3600, f"pte_{p.tid}_{p.k}_{q.tid}_{q.k}")
                            m.add(exc >= senior.arr - rel(s_leg.sched_arr_next) - _ci(bound)).only_enforce_if(
                                junior_first)
                            obj.append(exc * PTE_PENALTY)
                            pte_terms.append((exc, senior.tid, p.tid if senior is q else q.tid, sid))
                    # стабильность: штраф за смену порядка относительно прошлого плана
                    if (p.tid, p.k) in prev_order and (q.tid, q.k) in prev_order:
                        was = prev_order[(p.tid, p.k)] <= prev_order[(q.tid, q.k)]
                        obj.append((1 - b if was else b) * change_coef)
    # сдвиг отправления относительно прошлого плана: без причины план не «дёргается»
    shift_coef = int(round(C * cfg.cost.c_shift / 60))
    if inp.prev_plan is not None and shift_coef > 0:
        for L in legs.values():
            if L.started or L.entered or isinstance(L.dep, int):
                continue
            pl = inp.prev_plan.leg(L.tid, L.k)
            if pl is None or pl.dep < T0:
                continue
            dev = m.new_int_var(0, DOM + 48 * 3600, f"sh_{L.tid}_{L.k}")
            m.add(dev >= L.dep - rel(pl.dep))
            m.add(dev >= rel(pl.dep) - L.dep)
            obj.append(dev * shift_coef)
    # смена пути приёма относительно прошлого плана
    if inp.prev_plan is not None:
        for L in legs.values():
            pl = inp.prev_plan.leg(L.tid, L.k)
            if pl is None or L.entered or len(L.x) < 2:
                continue
            if pl.track_id in L.x:
                obj.append((1 - L.x[pl.track_id]) * change_coef)

    m.minimize(sum(obj))
    # подсказка: дискретные решения (порядок, пути, остановки) из плана-эвристики;
    # времена решатель выводит сам — дробные времена эвристики после округления
    # нарушали бы ограничения на секунду
    hint_times = "hint_times" in debug_disable
    for var, val in hints:
        if not hint_times and not _is_bool(var):
            continue
        try:
            m.add_hint(var, val)
        except Exception:  # noqa: BLE001
            pass
    st.build_ms = (time.perf_counter() - t_build) * 1000

    def params(sv: cp_model.CpSolver, limit: float) -> None:
        if deterministic:
            # детерминированное время не равно секундам: на этой модели единица ≈ 8–10 с
            # реального времени при одном потоке, поэтому бюджет делится на DET_RATIO
            sv.parameters.num_workers = 1
            sv.parameters.max_deterministic_time = limit / DET_RATIO
            sv.parameters.random_seed = 7
        else:
            sv.parameters.num_workers = workers
            sv.parameters.max_time_in_seconds = limit

    if "core" in debug_disable:
        lits = []
        for var, val in hints:
            if _is_bool(var):
                lits.append(var if val == 1 else var.Not())
        m.add_assumptions(lits)
        sv = cp_model.CpSolver()
        sv.parameters.num_workers = 1
        sv.parameters.max_time_in_seconds = 20
        c = sv.solve(m)
        core = sv.sufficient_assumptions_for_infeasibility()
        names = []
        for idx in core:
            v = m.proto.variables[abs(idx) if idx >= 0 else -idx - 1]
            names.append(("" if idx >= 0 else "NOT ") + v.name)
        st.notes.append(f"core status={STATUS_NAME.get(c, c)}: {names}")
        return None, st
    t_solve = time.perf_counter()
    # Фаза А: дискретные решения подсказки фиксируются, решатель достраивает
    # целочисленные времена — получаем гарантированно допустимый старт.
    warm = False
    if hints and "fixhint" not in debug_disable and "nowarm" not in debug_disable:
        ma = m.clone()
        ma.clear_hints()
        for var, val in hints:
            idx = var.index
            if _is_bool(var):
                # дискретные решения подсказки фиксируются ограничением
                ma.add(ma.get_bool_var_from_proto_index(idx) == val)
            else:
                ma.proto.solution_hint.vars.append(idx)
                ma.proto.solution_hint.values.append(val)
        sa = cp_model.CpSolver()
        params(sa, min(1.0, time_limit_s * 0.4) if not deterministic else max(0.8, time_limit_s * 0.5))
        sa.parameters.stop_after_first_solution = "evalref" not in debug_disable
        sa.parameters.cp_model_presolve = False   # при зафиксированных решениях presolve только мешает
        ca = sa.solve(ma)
        if ca not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # подсказка противоречит жёстким правилам (например, внеочередной первым) —
            # пробуем мягкую подсказку: решения не фиксируются, решатель правит сам
            st.notes.append(f"фаза А с фиксацией: {STATUS_NAME.get(ca, ca)}, мягкая подсказка")
            mb = m.clone()
            mb.clear_hints()
            for var, val in hints:
                mb.proto.solution_hint.vars.append(var.index)
                mb.proto.solution_hint.values.append(val)
            sa = cp_model.CpSolver()
            params(sa, min(1.0, time_limit_s * 0.4) if not deterministic else max(0.8, time_limit_s * 0.5))
            sa.parameters.stop_after_first_solution = True
            ca = sa.solve(mb)
        if ca in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            m.clear_hints()
            values = sa.response_proto.solution
            for i in range(len(m.proto.variables)):
                m.proto.solution_hint.vars.append(i)
                m.proto.solution_hint.values.append(values[i])
            warm = True
            st.notes.append(f"тёплый старт: фаза А {round((time.perf_counter() - t_solve) * 1000)} мс")
        else:
            st.notes.append(f"тёплый старт не удался ({STATUS_NAME.get(ca, ca)})")
    solver = cp_model.CpSolver()
    if "fixhint" in debug_disable:
        solver.parameters.fix_variables_to_their_hinted_value = True
    remaining = time_limit_s if deterministic else max(0.2, time_limit_s - (time.perf_counter() - t_solve))
    params(solver, remaining)
    code = solver.solve(m)
    st.solve_ms = (time.perf_counter() - t_solve) * 1000
    st.status = STATUS_NAME.get(code, str(code))
    st.warm = warm
    if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, st
    st.objective = solver.objective_value / C
    st.bound = solver.best_objective_bound / C
    for exc, senior, junior, sid in pte_terms:
        v = solver.value(exc)
        if v > 0:
            st.pte_violations.append({"senior": senior, "junior": junior, "section": sid, "excess_s": int(v)})

    out_legs: dict[str, list[PlanLeg]] = {}
    origin: dict[str, str] = {}
    start: dict[str, StartHold] = {}
    for tid, lst in per_train.items():
        ti = inp.trains[tid]
        res = []
        for L in lst:
            li = ti.legs[L.k]
            dep = T0 + (L.dep if isinstance(L.dep, int) else solver.value(L.dep))
            arr = T0 + solver.value(L.arr)
            track = next(trk for trk, x in L.x.items() if (x == 1 if isinstance(x, int) else solver.value(x)))
            stop = bool(L.se) if isinstance(L.se, int) else bool(solver.value(L.se))
            res.append(PlanLeg(tid, L.k, li.sec.id, li.from_id, li.to_id, li.d, float(dep), float(arr), track, stop))
        out_legs[tid] = res
        if ti.phase == "station":
            start[tid] = StartHold(ti.train.route[ti.k], ti.track, ti.since)
        elif ti.phase == "pending":
            xs = origin_x.get(tid, [])
            chosen = next((trk for trk, x in xs if solver.value(x)), ti.origin_track)
            origin[tid] = chosen
            start[tid] = StartHold(ti.train.route[0], chosen, max(T0, res[0].dep - r.prep_s))
    for tid, ti in inp.trains.items():
        if ti.phase == "terminal":
            start[tid] = StartHold(ti.train.route[ti.k], ti.track, ti.since, until=ti.finish_at)
        elif ti.phase == "station" and tid not in per_train:
            start[tid] = StartHold(ti.train.route[ti.k], ti.track, ti.since)
    plan = Plan(version=0, created_at=T0, solver="cpsat", status="feasible", legs=out_legs, origin_track=origin,
                start_hold=start, horizon_end=inp.horizon_end)
    return plan, st


def _is_bool(var) -> bool:
    try:
        proto = var.proto
        return len(proto.domain) == 2 and proto.domain[0] == 0 and proto.domain[1] == 1
    except AttributeError:
        return False


def _finish(st: CpStats, t_build: float, status: str) -> CpStats:
    st.status = status
    st.build_ms = (time.perf_counter() - t_build) * 1000
    return st
