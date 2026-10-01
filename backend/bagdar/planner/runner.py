"""Очередь пересчётов плана с ограничением частоты.

Триггеры: загрузка сценария, внешнее событие, прогноз конфликта или
отклонение от плана (проверка каждые check_sim_s секунд модели), плановый
сдвиг горизонта (period_sim_s), ручной запрос. Пересчёт не чаще
min_interval_s реального времени; накопленные причины объединяются.
Решатель работает в отдельном потоке (CP-SAT отпускает GIL), снимок
состояния берётся в потоке симуляции, результат применяется там же.
В синхронном режиме (тесты, детерминированные прогоны) расчёт идёт на
месте, а время модели стоит.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor

from bagdar.models.plan import Plan
from bagdar.planner.conflicts import project_conflicts
from bagdar.planner.inputs import build_input
from bagdar.planner.service import Planner, PlanResult

log = logging.getLogger("bagdar.planner")
MIN_SIM_GAP_S = 90   # неэкстренный пересчёт не чаще, чем раз в 90 с модели после применения плана


class PlannerRunner:
    def __init__(self, runtime, sync: bool = False) -> None:
        self.rt = runtime
        self.sync = sync
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bagdar-planner")
        self.planner = Planner(deterministic=sync)
        self.reset(None)

    def reset(self, plan_v0: Plan | None) -> None:
        self.current: Plan | None = plan_v0
        self.previous: Plan | None = None
        self.version = 0
        self.pending: list[str] = []
        self.urgent = False
        self.future: Future | None = None
        self.future_run_id = ""
        self.last_real = 0.0
        self.last_sim = -1e18
        self.last_applied_t = -1e18
        self.history: deque[dict] = deque(maxlen=200)
        self.cards: deque[dict] = deque(maxlen=300)
        self.card_seq = 0
        self.last: PlanResult | None = None
        self.conflicts: list[dict] = []
        self.max_deviation = 0.0
        eng = self.rt.engine
        t = eng.t if eng is not None else 0.0
        cfg = self.rt.cfg.planner
        self.next_period = t + cfg.period_sim_s
        self.next_check = t + cfg.check_sim_s
        if plan_v0 is not None and cfg.enabled:
            self.request("загрузка сценария", urgent=True)

    # ------------------------------------------------------------ запросы
    def request(self, reason: str, urgent: bool = False) -> None:
        if reason not in self.pending:
            self.pending.append(reason)
        self.urgent = self.urgent or urgent

    @property
    def busy(self) -> bool:
        return self.future is not None

    # ------------------------------------------------------------ цикл
    def tick(self) -> None:
        eng = self.rt.engine
        cfg = self.rt.cfg.planner
        if eng is None or not cfg.enabled:
            return
        if eng.t >= self.next_period:
            self.next_period = eng.t + cfg.period_sim_s
            self.request("плановый пересчёт: горизонт сдвинулся")
        if eng.t >= self.next_check and self.current is not None:
            self.next_check = eng.t + cfg.check_sim_s
            self.check()
        if self.future is not None and self.future.done():
            fut, self.future = self.future, None
            try:
                res = fut.result()
            except Exception:  # noqa: BLE001
                log.exception("planner failed")
                self.rt.engine.emit("planner_error", "critical", "Ошибка планировщика — действует прежний план")
                res = None
            if res is not None and self.future_run_id == self.rt.run_id:
                self.apply(res)
        if self.pending and self.future is None:
            if self.sync:
                # детерминированный режим: частота ограничивается временем модели
                ready = self.urgent or eng.t - self.last_sim >= 60
            else:
                # ограничение и по реальному времени, и по времени модели (при ×100 секунда — это 100 с)
                ready = self.urgent or (time.monotonic() - self.last_real >= cfg.min_interval_s
                                        and eng.t - self.last_applied_t >= MIN_SIM_GAP_S)
            if ready:
                self.launch()

    def launch(self) -> None:
        eng = self.rt.engine
        reason = "; ".join(self.pending)
        self.pending, self.urgent = [], False
        self.last_real = time.monotonic()
        self.last_sim = eng.t
        last_s = (self.last.timings["total_ms"] / 1000) if self.last else self.rt.cfg.solver.time_limit_s
        extra = 0.0 if self.sync else 1.5 * last_s * (self.rt.speed if self.rt.running else 0.0)
        inp = build_input(eng, self.rt.cfg, self.current, reason, extra_freeze_s=extra)
        version = self.version + 1
        if self.sync:
            self.apply(self.planner.solve(inp, version))
        else:
            self.future_run_id = self.rt.run_id
            self.future = self.pool.submit(self.planner.solve, inp, version)

    def check(self) -> None:
        """Прогноз конфликтов и отклонений от действующего плана."""
        eng = self.rt.engine
        self.conflicts, self.max_deviation = project_conflicts(eng, self.current)
        if self.conflicts:
            c = self.conflicts[0]
            self.request(f"прогноз конфликта через {max(0, round(c['in_s'] / 60))} мин: {c['message']}")
        elif self.max_deviation > self.rt.cfg.planner.deviation_s:
            self.request(f"отклонение от плана {round(self.max_deviation / 60)} мин")

    # ------------------------------------------------------------ применение
    def apply(self, res: PlanResult) -> None:
        eng = self.rt.engine
        self.version = res.plan.version
        self.previous, self.current = self.current, res.plan
        eng.apply_plan(res.plan)
        self.last_applied_t = eng.t
        self.last = res
        stats = res.stats()
        stats["applied_at"] = round(eng.t, 1)
        stats["lag_s"] = round(eng.t - res.t0, 1)
        self.history.append(stats)
        self.conflicts = []
        cp = res.cp
        names = {"cpsat": "CP-SAT", "greedy": "эвристика", "repair": "прежний порядок", "hold": "удержание"}
        best_heur = min((c.cost.lex for c in res.candidates if c.valid and c.name != "cpsat" and c.cost),
                        default=None)
        gain = ""
        if res.cost is not None and best_heur and best_heur > 0 and res.solver == "cpsat":
            gain = f", на {round((1 - res.cost.lex / best_heur) * 100)} % лучше эвристики"
        j = f"J = {res.cost.total:.0f} у.е." if res.cost else "J —"
        status_txt = {"feasible": "допустим", "delayed": "допустим, есть задержки", "infeasible": "НЕ НАЙДЕН"}
        sev = "critical" if res.status == "infeasible" else "info"
        eng.emit("plan_published", sev,
                 f"План v{self.version}: {names.get(res.solver, res.solver)}, {round(res.timings['total_ms'])} мс, "
                 f"{status_txt[res.status]}, {j}{gain}. Причина: {res.reason}",
                 data={"version": self.version, "solver": res.solver, "status": res.status,
                       "ms": round(res.timings["total_ms"]), "cp_status": cp.status})
        for card in res.cards:
            self.card_seq += 1
            card["seq"] = self.card_seq
            card["full_auto"] = self.rt.cfg.autonomy.full_auto
            self.cards.append(card)
            eng.emit("decision", "warn" if card["level"] == "C" else "info",
                     f"[{card['level']}] {card['action']}", station_id=card.get("station_id"),
                     section_id=card.get("section_id"), train_id=(card["trains"] or [None])[0],
                     data={"card_id": card["id"]})
        log.info("plan v%d solver=%s status=%s total_ms=%.0f cp=%s J=%s cards=%d reason=%s", self.version,
                 res.solver, res.status, res.timings["total_ms"], cp.status,
                 None if res.cost is None else round(res.cost.total), len(res.cards), res.reason)
        if eng.t - res.t0 > self.rt.cfg.solver.freeze_min * 60:
            self.request("план устарел за время расчёта")
        self.rt._mark_planner_update(res)

    # ------------------------------------------------------------ для API
    def summary(self) -> dict:
        last = self.last
        cur = self.current
        return {
            "version": self.version,
            "solver": cur.solver if cur else None,
            "status": cur.status if cur else None,
            "compute_ms": round(last.timings["total_ms"], 1) if last else None,
            "cpsat_ms": round(last.timings.get("cpsat_ms", 0.0), 1) if last else None,
            "cp_status": last.cp.status if last else None,
            "t0": round(last.t0, 1) if last else None,
            "J": round(last.cost.total, 1) if last and last.cost else None,
            "busy": self.busy,
            "pending": list(self.pending),
            "conflicts": len(self.conflicts),
            "max_deviation_s": round(self.max_deviation),
            "reason": last.reason if last else None,
            "late_trains": last.late_trains if last else [],
            "held": cur.held if cur else [],
            "cards_total": self.card_seq,
        }
