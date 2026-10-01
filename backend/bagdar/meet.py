"""«Кто первым?» — встреча пассажирского и грузового на однопутном перегоне.

Основа Бағдара в одной сцене. Перегон А — Б однопутный, разъехаться можно только на станции.
Пассажирский подходит к А, грузовой навстречу — к Б. Один занимает перегон первым, второй
ждёт на своей станции, пока перегон не освободится (встречный прибыл + интервал скрещения).

Цена варианта — те же слагаемые, что минимизирует планировщик (planner/economics.py):

- задержка: вес минуты (`train_weight`: класс × пассажиры, груз, бригада, уже опаздывает)
  × опоздание на конечной сверх запаса по графику;
- неплановая остановка: c_stop × E_стоп, E = m·v²/2 (на подъёме ×4, как в планировщике);
- простой локомотива и бригады: c_idle × минуты стоянки сверх графика (у пассажирского
  на плановой стоянке не считается — как в планировщике);
- ПТЭ: пассажирский старше. Если он из-за грузового пришёл на Б позже допуска класса,
  каждая минута сверх стоит 5 000 у.е. — лексикографически выше любой экономии.
  Окно пары 15 мин из планировщика здесь не применяется: пара в сцене заведомо конфликтная.

Кинематика — та же трапеция разгона и торможения класса (core/classes.py). Все цифры условные.
Копия расчёта для витрины без сервера — showcase/src/meet/model.ts, совпадение проверяется
тестом по showcase/src/meet/fixture.json.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from bagdar.config import BagdarConfig
from bagdar.core.classes import TRAIN_CLASSES
from bagdar.core.kinematics import stop_energy_kwh
from bagdar.models.train import ScheduleStop, Train
from bagdar.planner.economics import PTE_PENALTY_PER_MIN, UPHILL_STOP_FACTOR, train_weight

PAX_CLASSES = ("high_speed_passenger", "fast_passenger", "passenger")
FREIGHT_CLASSES = ("express_freight", "freight", "local_freight")
CARGO = ("urgent", "perishable", "deadline", "dangerous")
T0_S = 180.0              # через сколько секунд от начала сцены поезда подходят к станциям
VIEW_M = 4500.0           # сколько видно до станции и после неё
EXIT_M = 6000.0           # путь после дальней станции — поезд уходит за край
NOW_S = 8 * 3600.0        # условное «сейчас» для бригады и конечной


@dataclass
class PaxIn:
    cls: str = "fast_passenger"
    passengers: int = 600
    delay_min: float = 0.0
    slack_min: float = 3.0
    dwell_min: float = 0.0        # плановая стоянка на станции А, 0 — проходит без остановки
    transfer: bool = False
    trip_left_h: float = 3.0


@dataclass
class FreightIn:
    cls: str = "freight"
    mass_t: float = 5000.0
    cargo: list[str] = field(default_factory=list)
    delay_min: float = 0.0
    slack_min: float = 20.0
    uphill: bool = False          # станция Б для грузового на подъёме: трогаться тяжело
    crew_left_h: float = 6.0
    trip_left_h: float = 4.0


@dataclass
class MeetIn:
    section_km: float = 12.0
    speed_limit_kmh: float = 100.0
    gap_min: float = 0.0          # > 0 — пассажирский подходит к А позже, чем грузовой к Б
    pax: PaxIn = field(default_factory=PaxIn)
    freight: FreightIn = field(default_factory=FreightIn)
    pte_strict: bool | None = None  # None — как в настройках сервера


def freight_length_m(mass_t: float) -> float:
    wagons = max(10, round(mass_t / 70))
    return wagons * 14 + 34


def pax_length_m(passengers: int) -> float:
    cars = max(4, min(20, math.ceil(passengers / 54)))
    return cars * 25 + 20


def _train(tid: str, cls: str, mass_t: float, passengers: int, cargo: list[str], transfer: bool,
           trip_left_h: float, crew_left_h: float, length_m: float) -> Train:
    c = TRAIN_CLASSES[cls]
    return Train(id=tid, number=tid, cls=cls, pte_rank=c.pte_rank, direction=1, length_m=round(length_m),
                 mass_t=round(mass_t), passengers=passengers, cargo=list(cargo), traction="electric",
                 vmax_kmh=c.vmax_kmh, accel=c.accel, decel=c.decel, loco_id="L", crew_id="C",
                 crew_shift_end=NOW_S + crew_left_h * 3600,
                 route=["A", "B"], sections=["AB"],
                 schedule=[ScheduleStop("A", None, NOW_S, False, 0, "A1"),
                           ScheduleStop("B", NOW_S + trip_left_h * 3600, None, True, 0, "B1")],
                 transfer=transfer)


class _Motion:
    """Движение поезда по своему пути: s = 0 на первой станции, s = L на второй."""

    def __init__(self, x0: float, direction: int, v: float, a: float, d: float, L: float):
        self.x0, self.dir, self.v, self.a, self.d, self.L = x0, direction, v, a, d, L
        self.tb, self.db = v / d, v * v / (2 * d)      # торможение до остановки
        self.ta, self.da = v / a, v * v / (2 * a)      # разгон с места

    def segs_pass(self, t_reach: float) -> tuple[list[dict], float]:
        """Без остановки: голова на станции в t_reach. Возвращает отрезки и прибытие на вторую станцию."""
        pre = self.v * t_reach
        end = self.L + EXIT_M
        segs = [self._seg(0.0, t_reach + end / self.v, -pre, end, self.v, self.v)]
        return segs, t_reach + self.L / self.v

    def segs_stop(self, t_arr: float, t_dep: float) -> tuple[list[dict], float]:
        """Остановка на первой станции: прибытие t_arr, отправление t_dep."""
        pre = self.db + self.v * (t_arr - self.tb)
        t_cruise_end = t_dep + self.ta + (self.L + EXIT_M - self.da) / self.v
        segs = [
            self._seg(0.0, t_arr - self.tb, -pre, -self.db, self.v, self.v),
            self._seg(t_arr - self.tb, t_arr, -self.db, 0.0, self.v, 0.0),
            self._seg(t_arr, t_dep, 0.0, 0.0, 0.0, 0.0),
            self._seg(t_dep, t_dep + self.ta, 0.0, self.da, 0.0, self.v),
            self._seg(t_dep + self.ta, t_cruise_end, self.da, self.L + EXIT_M, self.v, self.v),
        ]
        return [s for s in segs if s["t1"] > s["t0"]], t_dep + self.ta + (self.L - self.da) / self.v

    def _seg(self, t0: float, t1: float, s0: float, s1: float, v0: float, v1: float) -> dict:
        return {"t0": round(t0, 2), "t1": round(t1, 2), "x0": round(self.x0 + self.dir * s0, 1),
                "x1": round(self.x0 + self.dir * s1, 1), "v0": round(v0, 3), "v1": round(v1, 3)}


def _side(m: _Motion, t_reach: float, dwell_s: float, t_free: float | None, min_stop: float) -> dict:
    """Как проходит первую станцию поезд, которому перегон впереди освобождается в t_free.
    t_reach — голова на станции (на полном ходу или в момент остановки, если стоянка плановая)."""
    if dwell_s > 0:
        dep_plan = t_reach + dwell_s
        dep = max(dep_plan, t_free or 0.0)
        segs, arr2 = m.segs_stop(t_reach, dep)
        return {"segs": segs, "arr2": arr2, "stopped": True, "planned": True, "arr": t_reach, "dep": dep,
                "wait_s": dep - dep_plan}
    if t_free is None or t_free <= t_reach:
        segs, arr2 = m.segs_pass(t_reach)
        return {"segs": segs, "arr2": arr2, "stopped": False, "planned": False, "arr": t_reach, "dep": t_reach,
                "wait_s": 0.0}
    arr = t_reach + m.tb / 2                    # тормозить до нуля дольше, чем проехать это место
    dep = max(arr + min_stop, t_free)
    segs, arr2 = m.segs_stop(arr, dep)
    return {"segs": segs, "arr2": arr2, "stopped": True, "planned": False, "arr": arr, "dep": dep,
            "wait_s": dep - arr}


def _added_late_s(delay_min: float, extra_s: float, slack_min: float) -> float:
    d, s = delay_min * 60, slack_min * 60
    return max(0.0, d + extra_s - s) - max(0.0, d - s)


def compare(p: MeetIn, cfg: BagdarConfig) -> dict:
    L = p.section_km * 1000
    cp, cf = TRAIN_CLASSES[p.pax.cls], TRAIN_CLASSES[p.freight.cls]
    vp = min(cp.vmax_kmh, p.speed_limit_kmh) / 3.6
    vf = min(cf.vmax_kmh, p.speed_limit_kmh) / 3.6
    pax_len = pax_length_m(p.pax.passengers)
    fr_len = freight_length_m(p.freight.mass_t)
    pax_mass = round(pax_len / 25 * 58 + 120)
    tau, min_stop = cfg.sim.tau_cross_s, cfg.sim.min_stop_s
    gap = p.gap_min * 60
    t_pa = T0_S + max(0.0, gap)
    t_fb = T0_S + max(0.0, -gap)
    dwell = p.pax.dwell_min * 60

    tr_p = _train("P", p.pax.cls, pax_mass, p.pax.passengers, [], p.pax.transfer, p.pax.trip_left_h, 8.0, pax_len)
    tr_f = _train("F", p.freight.cls, p.freight.mass_t, 0, [c for c in p.freight.cargo if c in CARGO], False,
                  p.freight.trip_left_h, p.freight.crew_left_h, fr_len)
    w_p, f_p = train_weight(tr_p, cfg, NOW_S, p.pax.delay_min * 60)
    w_f, f_f = train_weight(tr_f, cfg, NOW_S, p.freight.delay_min * 60)
    tol_p = cfg.tolerance_s(p.pax.cls)
    strict = cfg.pte_strict if p.pte_strict is None else p.pte_strict

    mp = _Motion(0.0, 1, vp, cp.accel, cp.decel, L)
    mf = _Motion(L, -1, vf, cf.accel, cf.decel, L)
    free_p = _side(mp, t_pa, dwell, None, min_stop)
    free_f = _side(mf, t_fb, 0.0, None, min_stop)

    options = []
    for oid in ("pax_first", "freight_first"):
        if oid == "pax_first":
            sp = free_p
            sf = _side(mf, t_fb, 0.0, sp["arr2"] + tau, min_stop)
        else:
            sf = free_f
            sp = _side(mp, t_pa, dwell, sf["arr2"] + tau, min_stop)
        extra_p = sp["arr2"] - free_p["arr2"]
        extra_f = sf["arr2"] - free_f["arr2"]
        late_p = _added_late_s(p.pax.delay_min, extra_p, p.pax.slack_min)
        late_f = _added_late_s(p.freight.delay_min, extra_f, p.freight.slack_min)
        cost = {"delay_pax": w_p * late_p / 60, "delay_freight": w_f * late_f / 60,
                "stop_pax": 0.0, "stop_freight": 0.0, "idle_pax": 0.0, "idle_freight": 0.0, "pte": 0.0}
        kwh = {"pax": 0.0, "freight": 0.0}
        if sp["stopped"] and not sp["planned"]:
            kwh["pax"] = stop_energy_kwh(pax_mass, vp)
            cost["stop_pax"] = cfg.cost.c_stop * kwh["pax"]
            cost["idle_pax"] = max(0.0, sp["wait_s"] - min_stop) / 60 * cfg.cost.c_idle
        if sf["stopped"]:
            kwh["freight"] = stop_energy_kwh(p.freight.mass_t, vf)
            cost["stop_freight"] = cfg.cost.c_stop * kwh["freight"] * (UPHILL_STOP_FACTOR if p.freight.uphill else 1.0)
            cost["idle_freight"] = max(0.0, sf["wait_s"] - min_stop) / 60 * cfg.cost.c_idle
        pte_excess = 0.0
        if oid == "freight_first" and strict and cp.pte_rank < cf.pte_rank:
            exc = extra_p - tol_p
            if exc > 1:
                pte_excess = exc
                cost["pte"] = PTE_PENALTY_PER_MIN * exc / 60
        econ = sum(v for k, v in cost.items() if k != "pte")
        options.append({
            "id": oid,
            "yield": "freight" if oid == "pax_first" else "pax",
            "motion": {"pax": sp["segs"], "freight": sf["segs"]},
            "pax": _side_out(sp, extra_p, late_p),
            "freight": _side_out(sf, extra_f, late_f),
            "kwh": {k: round(v, 1) for k, v in kwh.items()},
            "cost": {k: round(v, 1) for k, v in cost.items()},
            "econ": round(econ, 1),
            "total": round(econ + cost["pte"], 1),
            "pte_excess_min": round(pte_excess / 60, 2),
            "pax_person_min": round(p.pax.passengers * extra_p / 60),
            "freight_ton_h": round(p.freight.mass_t * extra_f / 3600),
            "end_t": round(max(sp["segs"][-1]["t1"], sf["segs"][-1]["t1"]), 1),
        })
    a, b = options
    winner = a if a["total"] <= b["total"] else b
    loser = b if winner is a else a
    econ_winner = a if a["econ"] <= b["econ"] else b
    return {
        "params": _params_out(p),
        "geometry": {"section_m": L, "view_from_m": -VIEW_M, "view_to_m": L + VIEW_M,
                     "loop_m": max(1400.0, max(fr_len, pax_len) + 300), "tau_cross_s": tau},
        "trains": {
            "pax": {"cls": p.pax.cls, "label": cp.label, "length_m": round(pax_len), "mass_t": pax_mass,
                    "v_kmh": round(vp * 3.6), "passengers": p.pax.passengers, "pte_rank": cp.pte_rank,
                    "weight": round(w_p, 2), "factors": [[n, round(m, 3)] for n, m in f_p],
                    "base_weight": cfg.weight(p.pax.cls), "tolerance_min": tol_p / 60,
                    "stop_kwh": round(stop_energy_kwh(pax_mass, vp), 1),
                    "brake_s": round(mp.tb), "accel_s": round(mp.ta)},
            "freight": {"cls": p.freight.cls, "label": cf.label, "length_m": round(fr_len),
                        "mass_t": round(p.freight.mass_t), "v_kmh": round(vf * 3.6), "pte_rank": cf.pte_rank,
                        "weight": round(w_f, 2), "factors": [[n, round(m, 3)] for n, m in f_f],
                        "base_weight": cfg.weight(p.freight.cls), "tolerance_min": cfg.tolerance_s(p.freight.cls) / 60,
                        "stop_kwh": round(stop_energy_kwh(p.freight.mass_t, vf), 1),
                        "brake_s": round(mf.tb), "accel_s": round(mf.ta)},
        },
        "options": options,
        "winner": winner["id"],
        "econ_winner": econ_winner["id"],
        "saving": round(loser["total"] - winner["total"], 1),
        "econ_saving": round(abs(a["econ"] - b["econ"]), 1),
        "constants": {"c_stop": cfg.cost.c_stop, "c_idle": cfg.cost.c_idle, "pte_penalty_per_min": PTE_PENALTY_PER_MIN,
                      "uphill_factor": UPHILL_STOP_FACTOR, "min_stop_s": min_stop, "pte_strict": strict},
    }


def _side_out(s: dict, extra: float, late: float) -> dict:
    return {"stopped": s["stopped"], "planned_stop": s["planned"], "arr": round(s["arr"], 1),
            "dep": round(s["dep"], 1), "wait_s": round(s["wait_s"], 1), "extra_s": round(extra, 1),
            "late_s": round(late, 1), "arr_far": round(s["arr2"], 1)}


def _params_out(p: MeetIn) -> dict:
    return {"section_km": p.section_km, "speed_limit_kmh": p.speed_limit_kmh, "gap_min": p.gap_min,
            "pax": vars(p.pax).copy(), "freight": {**vars(p.freight), "cargo": list(p.freight.cargo)}}
