"""Прикладной слой: владеет миром и движком, крутит цикл симуляции,
рассылает обновления подписчикам потока.

Модель идёт фиксированным шагом dt. Реальное время только решает, сколько
шагов выполнить: при ускорении ×k за реальную секунду выполняется k/dt
шагов. Состояние клиентам уходит с ограниченной частотой (broadcast_hz),
события — сразу, пачками.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field, fields
from typing import Any

from bagdar import dto
from bagdar.config import BagdarConfig, parse_hhmm
from bagdar.core.rules import TimingRules
from bagdar.generator.timetable import TimetableBuilder
from bagdar.generator.trains_gen import TrafficParams, generate_traffic
from bagdar.generator.world_gen import CorridorParams, generate_world
from bagdar.index import IndexTracker
from bagdar.models.plan import Plan
from bagdar.models.train import Train
from bagdar.models.world import World
from bagdar.planner.occupancy import fact_occupancy, plan_occupancy
from bagdar.planner.runner import ActionError, PlannerRunner
from bagdar.scenarios import Scenario
from bagdar.sim.engine import Engine
from bagdar.sim.events import SimEvent
from bagdar.validator import validate_plan

log = logging.getLogger("bagdar.runtime")

SPEEDS = (1, 2, 5, 10, 30, 60, 100)
MAX_STEPS_PER_TICK = 400          # защита от «спирали смерти» при подвисании
EVENT_BUFFER = 20000


@dataclass(eq=False)
class Subscriber:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=256))
    overflowed: bool = False


def _apply_overrides(obj: Any, overrides: dict[str, Any]) -> Any:
    names = {f.name for f in fields(obj)}
    for k, v in overrides.items():
        if k not in names:
            raise ValueError(f"Неизвестный параметр «{k}» для {type(obj).__name__}")
        setattr(obj, k, tuple(v) if isinstance(getattr(obj, k), tuple) else v)
    return obj


class SimulationRuntime:
    def __init__(self, cfg: BagdarConfig, scenarios: dict[str, Scenario], planner_sync: bool = False) -> None:
        self.cfg = cfg
        self.scenarios = scenarios
        self.scenario: Scenario | None = None
        self.world: World | None = None
        self.trains: list[Train] = []
        self.plan: Plan | None = None
        self.engine: Engine | None = None
        self.generation: dict = {}
        self.running = False
        self.speed: float = 30
        self.world_version = 0
        self.run_id = ""
        self.events: deque[SimEvent] = deque(maxlen=EVENT_BUFFER)
        self.subscribers: set[Subscriber] = set()
        self._task: asyncio.Task | None = None
        self._acc = 0.0
        self._dirty = True
        self.perf = {"step_us": 0.0, "tick_ms": 0.0, "steps_per_s": 0.0, "load_ms": 0.0}
        self._world_payload: dict | None = None
        self.planner = PlannerRunner(self, sync=planner_sync)
        self.index = IndexTracker(cfg)

    # ------------------------------------------------------------ загрузка мира
    def load(self, scenario_id: str | None = None, seed: int | None = None) -> None:
        started = time.perf_counter()
        sc = self.scenarios[scenario_id] if scenario_id else (self.scenario or self.scenarios["normal"])
        seed = sc.seed if seed is None else seed
        corridor = _apply_overrides(CorridorParams(), sc.world)
        traffic = _apply_overrides(TrafficParams(), sc.traffic)
        world = generate_world(sc.mode, seed, corridor)
        rules = TimingRules.from_config(self.cfg.sim)
        tt = TimetableBuilder(world, rules).build(generate_traffic(world, seed, traffic))
        violations = validate_plan(world, {t.id: t for t in tt.trains}, tt.plan, rules)
        if violations:
            # исходный график обязан быть бесконфликтным; если нет — это ошибка генератора
            raise RuntimeError(f"Исходный график не прошёл проверку: {violations[0].message}")
        start = parse_hhmm(sc.start_time)
        self.scenario = sc
        self.world, self.trains, self.plan = world, tt.trains, tt.plan
        self.engine = Engine(world, tt.trains, tt.plan, self.cfg, seed, start)
        self.generation = {"trains_total": len(tt.trains), "dropped": tt.dropped,
                           "build_ms": round(tt.build_ms, 1), "validated": True}
        self.world_version += 1
        self.run_id = uuid.uuid4().hex[:12]
        self.events.clear()
        self.running = False
        self._acc = 0.0
        self._world_payload = None
        self.perf["load_ms"] = round((time.perf_counter() - started) * 1000, 1)
        ev = self.engine.emit("scenario_loaded", "info",
                              f"Загружен сценарий «{sc.title}», seed {seed}: {len(tt.trains)} поездов в графике")
        log.info("load scenario=%s seed=%s trains=%d dropped=%d build_ms=%.0f total_ms=%.0f",
                 sc.id, seed, len(tt.trains), len(tt.dropped), tt.build_ms, self.perf["load_ms"])
        self.planner.reset(tt.plan)
        self.index.reset(self.engine)
        self.index.update([])
        self._flush_events()
        self._broadcast({"type": "world", "world": self.world_payload()})
        self._broadcast({"type": "events", "reset": True, "events": [ev.to_dict()]})
        self._broadcast({"type": "decisions", "reset": True, "cards": []})
        self._broadcast_state()
        if self.planner.sync:
            self.planner.tick()

    # ----------------------------------------------------------------- управление
    def control(self, action: str, speed: float | None = None, step_s: float | None = None) -> None:
        assert self.engine is not None
        if action == "start":
            self.running = True
        elif action == "pause":
            self.running = False
        elif action == "speed":
            if speed is None or not (1 <= speed <= 100):
                raise ValueError("Ускорение должно быть от 1 до 100")
            self.speed = float(speed)
        elif action == "step":
            self.running = False
            seconds = step_s if step_s is not None else 60.0
            self._advance_steps(max(1, int(round(seconds / self.engine.dt))))
            self.planner.tick()
            self.index.update(self.planner.conflicts)
        elif action == "reset":
            self.load(self.scenario.id if self.scenario else None, self.engine.seed)
            return
        else:
            raise ValueError(f"Неизвестное действие {action}")
        self.engine.emit("sim_control", "debug", self._control_text(action), data={"action": action,
                         "speed": self.speed})
        self._flush_events()
        self._broadcast_state()

    def _control_text(self, action: str) -> str:
        return {"start": "Симуляция запущена", "pause": "Симуляция на паузе",
                "speed": f"Ускорение ×{self.speed:g}", "step": "Шаг симуляции"}.get(action, action)

    # ---------------------------------------------------------------- цикл
    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="bagdar-sim-loop")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        last = time.monotonic()
        next_state = last
        while True:
            await asyncio.sleep(0.02)
            now = time.monotonic()
            real_dt = min(now - last, 0.25)
            last = now
            if self.engine is None:
                continue
            if self.running:
                self._acc += real_dt * self.speed
                steps = int(self._acc // self.engine.dt)
                if steps > MAX_STEPS_PER_TICK:
                    steps = MAX_STEPS_PER_TICK
                    self._acc = 0.0
                else:
                    self._acc -= steps * self.engine.dt
                if steps:
                    self._advance_steps(steps)
                    self.perf["steps_per_s"] = round(steps / max(real_dt, 1e-3), 1)
            self.planner.tick()
            self.planner.advance_windows(real_dt if self.running else 0.0)
            self.index.update(self.planner.conflicts)
            self._flush_events()
            hz = self.cfg.sim.broadcast_hz
            if (self.running or self._dirty) and now >= next_state:
                self._broadcast_state()
                next_state = now + 1.0 / hz

    def _advance_steps(self, steps: int) -> None:
        assert self.engine is not None
        t0 = time.perf_counter()
        for _ in range(steps):
            self.engine.step()
            if self.planner.sync:
                self.planner.tick()
                if self.engine.t >= self.index.next_sample:
                    self.index.update(self.planner.conflicts)
        el = time.perf_counter() - t0
        self.perf["step_us"] = round(el / steps * 1e6, 1)
        self.perf["tick_ms"] = round(el * 1000, 2)
        self._dirty = True

    # ------------------------------------------------------------- снимки
    def world_payload(self) -> dict:
        assert self.world is not None and self.engine is not None and self.scenario is not None
        if self._world_payload is None:
            self._world_payload = dto.world_dto(
                self.world, self.trains, self.cfg, version=self.world_version, scenario_id=self.scenario.id,
                start_time=self.engine.start_time, generation=self.generation)
        return self._world_payload

    def state_payload(self) -> dict:
        assert self.engine is not None
        st = dto.state_dto(self.engine, running=self.running, speed=self.speed, run_id=self.run_id,
                           world_version=self.world_version, perf=dict(self.perf))
        st["planner"] = self.planner.summary()
        st["conflicts"] = list(self.planner.conflicts)
        st["index"] = self.index.current
        return st

    # ------------------------------------------------------- график и Гант
    def traces_since(self, since: float) -> dict:
        assert self.engine is not None
        eng = self.engine
        out = []
        for tid in eng.order:
            pts = [[p[0], p[1]] for p in eng.rt[tid].trace if p[0] > since]
            if pts:
                out.append({"train_id": tid, "points": pts})
        return {"t": round(eng.t, 1), "traces": out}

    def occupancy(self, which: str, t_from: float | None, t_to: float | None) -> dict:
        """Занятость путей и перегонов: факт до текущего момента, дальше — план (действующий или предыдущий)."""
        assert self.engine is not None
        eng = self.engine
        now = eng.t
        t_from = now - 1800 if t_from is None else t_from
        t_to = now + 9000 if t_to is None else t_to
        plan = self.planner.current if which == "current" else self.planner.previous
        other = self.planner.previous if which == "current" else self.planner.current
        items = [{"resource": b.resource, "train_id": b.train_id, "t0": round(max(b.t0, t_from), 1),
                  "t1": round(min(b.t1, now), 1), "kind": b.kind, "source": "fact", "changed": False}
                 for b in fact_occupancy(eng, t_from) if b.t0 < now]
        if plan is not None:
            trains = eng.trains
            ref: dict[tuple[str, str], list] = {}
            if other is not None:
                for o in plan_occupancy(eng.world, trains, other, eng.rules):
                    ref.setdefault((o.resource, o.train_id), []).append(o)
            for b in plan_occupancy(eng.world, trains, plan, eng.rules):
                if b.t1 <= now or b.t0 >= t_to:
                    continue
                changed = other is not None and not any(
                    abs(o.t0 - b.t0) < 120 and abs(o.t1 - b.t1) < 120 for o in ref.get((b.resource, b.train_id), []))
                items.append({"resource": b.resource, "train_id": b.train_id, "t0": round(max(b.t0, now), 1),
                              "t1": round(min(b.t1, t_to), 1), "kind": b.kind, "source": "plan", "changed": changed})
        return {"which": which, "plan_version": None if plan is None else plan.version, "t": round(now, 1),
                "items": items}

    def index_payload(self, since: float | None) -> dict:
        return {"current": self.index.current, "forecast": self.planner.forecast,
                "history": self.index.history_since(since)}

    # ------------------------------------------------------------- внешние события
    def external_event(self, kind: str, params: dict) -> str:
        assert self.engine is not None
        if kind == "train_delay":
            tid = params.get("train_id")
            minutes = float(params.get("minutes", 10))
            if not tid or not (1 <= minutes <= 240):
                raise ValueError("Нужны train_id и minutes от 1 до 240")
            where = self.engine.inject_delay(tid, minutes * 60, params.get("reason") or "внешнее событие")
            self.planner.request(f"задержка поезда {self.engine.trains[tid].number} на {round(minutes)} мин",
                                 urgent=True)
            msg = f"Поезд {self.engine.trains[tid].number}: {where}"
        else:
            raise ValueError(f"Тип события «{kind}» пока не поддерживается (сбои — этап 4)")
        self._flush_events()
        self._broadcast_state()
        if self.planner.sync:
            self.planner.tick()
        return msg

    def _mark_planner_update(self, res) -> None:
        self._dirty = True
        self._broadcast({"type": "decisions", "reset": False, "cards": res.cards})

    def _cards_updated(self, cards: list[dict]) -> None:
        self._dirty = True
        self._broadcast({"type": "decisions", "reset": False, "cards": cards})

    def _plan_changed(self) -> None:
        self._dirty = True
        self.index.update(self.planner.conflicts)
        self._flush_events()

    # ------------------------------------------------------------- действия диспетчера
    def decision_action(self, card_id: str, action: str, variant_id: str | None = None) -> str:
        assert self.engine is not None
        try:
            if action == "cancel":
                msg = self.planner.cancel(card_id)
            elif action == "choose":
                if not variant_id:
                    raise ActionError("Нужен variant_id")
                msg = self.planner.choose(card_id, variant_id)
            else:
                raise ActionError(f"Неизвестное действие {action}")
        finally:
            self._flush_events()
        self._broadcast_state()
        return msg

    def set_autonomy(self, full_auto: bool) -> dict:
        assert self.engine is not None
        if self.cfg.autonomy.full_auto != full_auto:
            self.engine.emit("autonomy", "info", "Режим «полный авто» " + ("включён: A и B применяются сразу, "
                             "C — лучшим вариантом" if full_auto else "выключен: решения C ждут выбора диспетчера"),
                             data={"full_auto": full_auto})
            self.planner.set_full_auto(full_auto)
        self._flush_events()
        self._broadcast_state()
        return self.cfg.autonomy.model_dump()

    def events_since(self, seq: int, limit: int = 2000, min_severity: str = "debug") -> list[dict]:
        order = {"debug": 0, "info": 1, "warn": 2, "critical": 3}
        lvl = order.get(min_severity, 0)
        out = [e.to_dict() for e in self.events if e.seq > seq and order[e.severity] >= lvl]
        return out[-limit:]

    # ------------------------------------------------------------- рассылка
    def subscribe(self) -> Subscriber:
        sub = Subscriber()
        self.subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self.subscribers.discard(sub)

    def _flush_events(self) -> None:
        if self.engine is None:
            return
        evs = self.engine.drain_events()
        if not evs:
            return
        self.events.extend(evs)
        for e in evs:
            if e.severity in ("warn", "critical"):
                log.info("event %s t=%.0f %s", e.kind, e.t, e.message)
        self._broadcast({"type": "events", "reset": False, "events": [e.to_dict() for e in evs]})

    def _broadcast_state(self) -> None:
        if self.engine is None:
            return
        self._dirty = False
        self._broadcast(self.state_payload())

    def _broadcast(self, msg: dict) -> None:
        if not self.subscribers:
            return
        text = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
        for sub in list(self.subscribers):
            try:
                sub.queue.put_nowait(text)
            except asyncio.QueueFull:
                # медленный клиент: очищаем очередь и просим полную пересинхронизацию
                sub.overflowed = True
                while not sub.queue.empty():
                    sub.queue.get_nowait()
