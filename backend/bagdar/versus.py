"""«Человек против Бағдара»: один и тот же поток поездов дважды.

Справа — основная модель с Бағдаром. Слева — теневая копия того же сценария и
того же seed без Бағдара: пустой план, порядок решает только СЦБ — кто первый
подошёл к ресурсу, тот и едет («кто первый пришёл, тот первый едет»). Обе модели
шагают синхронно, сбои (кнопки и события сценария) применяются к обеим. Зритель
может сам быть диспетчером слева: придерживать поезда на станциях.

Счёт одинаковый для обеих сторон: накопленная задержка (пассажирские и грузовые
отдельно), простой сверх графика, энергия неплановых остановок, поезда, которые
стоят на месте больше часа, проследования станций. Деньги — по тарифам из
настроек («подставьте свой тариф»), все цифры условные.
"""
from __future__ import annotations

from bagdar.models.plan import Plan

FROZEN_S = 3600.0          # «стоит намертво» — не сдвигался час
POS_EVERY_S = 30.0         # как часто запоминать позиции поездов


def empty_plan(t: float) -> Plan:
    return Plan(version=0, created_at=t, solver="fifo-live", status="feasible", legs={}, origin_track={})


class Versus:
    def __init__(self, runtime) -> None:
        self.rt = runtime
        self.shadow = None
        self.active = False
        self.actions: list[dict] = []
        self._pos: dict[str, dict[str, tuple]] = {"left": {}, "right": {}}
        self._next_pos = 0.0

    # ------------------------------------------------------------ жизненный цикл
    def start(self, scenario_id: str | None, seed: int | None) -> None:
        from bagdar.runtime import SimulationRuntime
        rt = self.rt
        self.stop()
        rt._versus_loading = True
        try:
            rt.load(scenario_id, seed)
        finally:
            rt._versus_loading = False
        c = rt.cfg.model_copy(deep=True)
        c.planner.enabled = False
        sh = SimulationRuntime(c, rt.scenarios, planner_sync=True)
        sh.load(rt.scenario.id, rt.engine.seed)
        sh.engine.apply_plan(empty_plan(sh.engine.t))
        self.shadow = sh
        self.active = True
        self.actions = []
        self._pos = {"left": {}, "right": {}}
        self._next_pos = rt.engine.t
        rt.engine.emit("versus", "info", f"Соревнование: «{rt.scenario.title}», слева без Бағдара, справа с ним")
        rt._flush_events()

    def stop(self) -> None:
        self.active = False
        self.shadow = None

    def step(self) -> None:
        sh = self.shadow
        if sh is None:
            return
        sh._advance_steps(1)
        t = self.rt.engine.t
        if t >= self._next_pos:
            self._next_pos = t + POS_EVERY_S
            self._remember("left", sh.engine)
            self._remember("right", self.rt.engine)

    def _remember(self, side: str, eng) -> None:
        remember_positions(self._pos[side], eng)

    # ------------------------------------------------------------ события
    def apply_event(self, kind: str, params: dict) -> None:
        if self.shadow is None:
            return
        try:
            self.shadow.incidents.apply(kind, params, "dispatcher")
        except (ValueError, KeyError):
            pass                       # у тени, например, поезд уже ушёл — сбой не применим
        self.shadow._flush_events()

    def restore(self, inc_id: str) -> None:
        if self.shadow is None:
            return
        try:
            self.shadow.incidents.restore(inc_id)
        except ValueError:
            pass

    def hold(self, train_id: str, minutes: float) -> str:
        """Решение человека-диспетчера слева: придержать поезд на станции."""
        if self.shadow is None:
            raise ValueError("Соревнование не запущено")
        eng = self.shadow.engine
        where = eng.inject_delay(train_id, minutes * 60, "решение человека-диспетчера")
        self.actions.append({"t": round(eng.t, 1), "train_id": train_id, "number": eng.number(train_id),
                             "minutes": minutes, "where": where})
        return f"Поезд {eng.number(train_id)} придержан на {round(minutes)} мин ({where})"

    # ------------------------------------------------------------ счёт
    def score(self, side: str) -> dict:
        rt = self.shadow if side == "left" else self.rt
        return score_runtime(rt, self.rt.cfg.tariffs, self._pos[side])

    def payload(self, with_state: bool = True) -> dict:
        if not self.active or self.shadow is None:
            return {"active": False}
        rt = self.rt
        left, right = self.score("left"), self.score("right")
        return {
            "active": True, "scenario_id": rt.scenario.id, "scenario": rt.scenario.title,
            "t": round(rt.engine.t, 1), "running": rt.running, "speed": rt.speed,
            "left": {"title": "Без Бағдара: «кто первый пришёл»", "score": left,
                     "state": self.shadow.state_payload() if with_state else None},
            "right": {"title": "С Бағдаром", "score": right},
            "diff": {"money": round(left["money_total"] - right["money_total"], 1),
                     "delay_min": round(left["delay_min"] - right["delay_min"], 1),
                     "frozen": left["frozen"] - right["frozen"],
                     "passages": right["passages"] - left["passages"]},
            "actions": self.actions[-20:],
        }


def remember_positions(cache: dict, eng) -> None:
    """Запомнить, когда каждый поезд последний раз сдвинулся (сменил станцию или перегон)."""
    for tid, r in eng.rt.items():
        key = (r.status, r.k)
        if cache.get(tid, (None,))[0] != key:
            cache[tid] = (key, eng.t)


def score_runtime(rt, tariffs, cache: dict) -> dict:
    """Счёт одной модели: одинаковые правила для «с Бағдаром» и «без»."""
    eng = rt.engine
    tar = tariffs
    pax = frt = 0.0
    late = 0
    for r in eng.rt.values():
        if r.status == "pending":
            continue
        d = r.rec_delay_s if r.status == "finished" else eng.live_delay(r)
        d = max(0.0, d)
        if r.train.pte_rank <= 3:
            pax += d
        else:
            frt += d
        if d >= 300:
            late += 1
    now = eng.t
    frozen = [eng.number(tid) for tid, r in eng.rt.items()
              if r.status in ("station", "section") and r.k < len(r.train.route) - 1
              and tid in cache and now - cache[tid][1] >= FROZEN_S]
    energy = sum(r.stop_energy_kwh for r in eng.rt.values())
    idle_h = eng.idle_total_s / 3600
    money = {"delay_pax": pax / 60 * tar.delay_min_pax, "delay_freight": frt / 60 * tar.delay_min_freight,
             "energy": energy * tar.kwh, "idle": idle_h * (tar.loco_hour + tar.crew_hour)}
    idx = rt.index.current or {}
    return {
        "delay_pax_min": round(pax / 60, 1), "delay_freight_min": round(frt / 60, 1),
        "delay_min": round((pax + frt) / 60, 1), "late_trains": late,
        "idle_h": round(idle_h, 2), "energy_kwh": round(energy, 1),
        "unplanned_stops": sum(r.unplanned_stops for r in eng.rt.values()),
        "frozen": len(frozen), "frozen_numbers": frozen[:8],
        "passages": len(eng.passages), "finished": sum(1 for r in eng.rt.values() if r.status == "finished"),
        "money": {k: round(v, 1) for k, v in money.items()}, "money_total": round(sum(money.values()), 1),
        "index": idx.get("value"), "index_status": idx.get("status_label"),
    }

