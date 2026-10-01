"""Очередь пересчётов плана с ограничением частоты и уровни автономии.

Триггеры: загрузка сценария, внешнее событие, прогноз конфликта или
отклонение от плана (проверка каждые check_sim_s секунд модели), плановый
сдвиг горизонта (period_sim_s), ручной запрос. Пересчёт не чаще
min_interval_s реального времени; накопленные причины объединяются.
Решатель работает в отдельном потоке (CP-SAT отпускает GIL), снимок
состояния берётся в потоке симуляции, результат применяется там же.
В синхронном режиме (тесты, детерминированные прогоны) расчёт идёт на
месте, а время модели стоит.

Уровни автономии (BAGDAR.md, раздел 1):
- A — мелкие правки (путь приёма, сдвиг в пределах запаса): применяются, пишутся в журнал;
- B — смена порядка поездов: применяется сразу, у диспетчера autonomy.b_cancel_s секунд
  на отмену (таймер идёт, только пока симуляция не на паузе, и закрывается, когда поезд
  пары вошёл на перегон);
- C — решение оставляет пассажирский сверх допуска: 2–3 варианта с ценой. В режиме
  «полный авто» сразу применяется лучший, другой можно выбрать в том же окне. Без
  полного авто план не применяется, пока диспетчер не выберет вариант.
Решение диспетчера (отмена или выбор) закрепляется: следующие пересчёты его не
переворачивают, пока поезда пары не вошли на перегон.
"""
from __future__ import annotations

import copy
import logging
import math
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field

from bagdar.index import forecast_index
from bagdar.models.plan import Plan
from bagdar.planner.conflicts import project_conflicts
from bagdar.planner.decisions import CardCtx
from bagdar.planner.economics import plan_cost
from bagdar.planner.forward import run_with_order
from bagdar.planner.inputs import build_input
from bagdar.planner.recovery import recovery
from bagdar.planner.service import Candidate, Planner, PlanResult, Variant
from bagdar.dto import plan_dto

log = logging.getLogger("bagdar.planner")
STALE_REQUESTS = ("прогноз конфликта", "отклонение от плана")
MIN_SIM_GAP_S = 90   # неэкстренный пересчёт не чаще, чем раз в 90 с модели после применения плана
SOLVER_NAMES = {"cpsat": "решатель CP-SAT", "greedy": "быстрая эвристика", "repair": "прежний порядок", "fifo": "«кто первый пришёл»",
                "hold": "удержание",
                "dispatcher": "решение диспетчера"}


class ActionError(Exception):
    """Действие диспетчера невозможно (окно закрыто, поезд уже на перегоне, план недопустим)."""


@dataclass
class Ctl:
    card: dict
    ctx: CardCtx | None
    variants: list[Variant] = field(default_factory=list)
    left_s: float = 0.0               # сколько реальных секунд осталось на действие
    kind: str = "cancel"              # cancel | choose
    proposal: bool = False            # C без полного авто: план ждёт выбора
    plan_t0: float = 0.0


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
        self.future_incidents: list[str] = []
        self.last_real = 0.0
        self.last_sim = -1e18
        self.last_applied_t = -1e18
        self.history: deque[dict] = deque(maxlen=200)
        self.cards: deque[dict] = deque(maxlen=300)
        self.card_seq = 0
        self.last: PlanResult | None = None
        self.conflicts: list[dict] = []
        self.max_deviation = 0.0
        self.ctl: dict[str, Ctl] = {}
        self.proposal: PlanResult | None = None
        self.overrides: dict[frozenset, tuple[str, int]] = {}
        self.forecast: dict | None = None
        self.recovery: dict | None = None
        eng = self.rt.engine
        t = eng.t if eng is not None else 0.0
        cfg = self.rt.cfg.planner
        self.next_period = t + cfg.period_sim_s
        self.next_check = t + cfg.check_sim_s
        if plan_v0 is not None and eng is not None:
            self._refresh_outlook(plan_v0, [])
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
        if self.ctl:
            self._expire_by_movement()
        if self.future is not None and self.future.done():
            fut, self.future = self.future, None
            try:
                res = fut.result()
            except Exception:  # noqa: BLE001
                log.exception("planner failed")
                self.rt.engine.emit("planner_error", "critical", "Ошибка планировщика — действует прежний план")
                res = None
            if res is not None and self.future_run_id == self.rt.run_id:
                res.incident_ids = self.future_incidents
                self.apply(res)
        if self.pending and self.future is None:
            if self.proposal is not None and not self.urgent:
                return          # ждём выбора диспетчера по карточке C — не перебиваем его новыми планами
            if self.sync:
                # детерминированный режим: частота ограничивается временем модели
                ready = self.urgent or eng.t - self.last_sim >= 60
            else:
                # ограничение и по реальному времени, и по времени модели (при ×100 секунда — это 100 с)
                ready = self.urgent or (time.monotonic() - self.last_real >= cfg.min_interval_s
                                        and eng.t - self.last_applied_t >= MIN_SIM_GAP_S)
            if ready:
                self.launch()

    def advance_windows(self, real_dt: float) -> None:
        """Отсчёт окон отмены и выбора — в реальных секундах, только пока симуляция идёт."""
        changed = []
        for cid, c in list(self.ctl.items()):
            if math.isinf(c.left_s):
                continue
            c.left_s -= real_dt
            if c.left_s <= 0:
                self._close(cid, None)
                changed.append(c.card)
        if changed:
            self.rt._cards_updated(changed)

    def launch(self) -> None:
        eng = self.rt.engine
        reason = "; ".join(self.pending)
        self.pending, self.urgent = [], False
        self.last_real = time.monotonic()
        self.last_sim = eng.t
        last_s = (self.last.timings["total_ms"] / 1000) if self.last else self.rt.cfg.solver.time_limit_s
        extra = 0.0 if self.sync else 1.5 * last_s * (self.rt.speed if self.rt.running else 0.0)
        self._prune_overrides()
        inp = build_input(eng, self.rt.cfg, self.current, reason, extra_freeze_s=extra, overrides=self.overrides)
        version = self.version + 1
        incidents = self.rt.incidents.take_waiting()
        if self.sync:
            res = self.planner.solve(inp, version)
            res.incident_ids = incidents
            self.apply(res)
        else:
            self.future_run_id = self.rt.run_id
            self.future_incidents = incidents
            self.future = self.pool.submit(self.planner.solve, inp, version)

    def check(self) -> None:
        """Прогноз конфликтов и отклонений от действующего плана."""
        eng = self.rt.engine
        self.conflicts, self.max_deviation, shifted = project_conflicts(eng, self.current)
        self._refresh_outlook(shifted, self.conflicts)
        if self.proposal is not None:
            return
        if self.conflicts:
            c = self.conflicts[0]
            self.request(f"прогноз конфликта через {max(0, round(c['in_s'] / 60))} мин: {c['message']}")
        elif self.max_deviation > self.rt.cfg.planner.deviation_s:
            self.request(f"отклонение от плана {round(self.max_deviation / 60)} мин")

    def _refresh_outlook(self, plan: Plan, conflicts: list[dict]) -> None:
        """Прогноз индекса на час и восстановление графика по плану."""
        eng = self.rt.engine
        cfg = self.rt.cfg
        try:
            self.forecast = forecast_index(cfg.index, eng.world, eng.trains, plan, eng.rules, eng.t, 3600,
                                           conflicts=len(conflicts))
            self.recovery = recovery(cfg, eng, plan)
        except Exception:  # noqa: BLE001 — прогноз не должен ронять цикл
            log.exception("outlook failed")

    # ------------------------------------------------------------ применение
    def _install(self, plan: Plan) -> None:
        eng = self.rt.engine
        self.previous, self.current = self.current, plan
        eng.apply_plan(plan)
        self.rt.history.add_plan(eng.t, plan, plan_dto(plan))
        self.last_applied_t = eng.t
        self.conflicts = []
        # запросы «прогноз конфликта» и «отклонение» считались по прежнему плану — устарели;
        # если конфликт остался, ближайшая проверка найдёт его уже в новом плане
        self.pending = [p for p in self.pending if not p.startswith(STALE_REQUESTS)]
        self.urgent = self.urgent and bool(self.pending)
        self._refresh_outlook(plan, [])

    def apply(self, res: PlanResult) -> None:
        eng = self.rt.engine
        auto = self.rt.cfg.autonomy
        self.version = res.plan.version
        self.last = res
        if res.incident_ids:
            # разбор инцидента «до / после» — первой карточкой; если у инцидента есть варианты (уровень C),
            # выбор делается в ней, а не в карточках отдельных перестановок
            inc_cards = self.rt.incidents.on_result(res, res.incident_ids)
            main = next((c for c in inc_cards if res.variants.get(c["id"])), None)
            if main is not None:
                for c in res.cards:
                    if res.variants.pop(c["id"], None) is not None or c.get("choice_card"):
                        c["variants"] = []
                        c["choice_card"] = main["id"]
            res.cards = inc_cards + res.cards
        stats = res.stats()
        stats["applied_at"] = round(eng.t, 1)
        stats["lag_s"] = round(eng.t - res.t0, 1)
        c_cards = [c for c in res.cards if c["level"] == "C" and res.variants.get(c["id"])]
        propose = bool(c_cards) and not auto.full_auto
        stats["proposal"] = propose
        self.history.append(stats)
        if self.proposal is not None:
            self._supersede_proposal("заменено новым расчётом")
        names = SOLVER_NAMES
        best_heur = min((c.cost.lex for c in res.candidates if c.valid and c.name != "cpsat" and c.cost),
                        default=None)
        gain = ""
        if res.cost is not None and best_heur and best_heur > res.cost.lex and res.solver == "cpsat":
            gain = f", на {round((1 - res.cost.lex / best_heur) * 100)} % дешевле простого перебора"
        j = f"цена {res.cost.total:,.0f} у.е.".replace(",", " ") if res.cost else "цена не посчитана"
        secs = f"{res.timings['total_ms'] / 1000:.1f} с".replace(".", ",")
        status_txt = {"feasible": "проверен, конфликтов нет", "delayed": "проверен, но есть опоздания",
                      "infeasible": "НЕ НАЙДЕН — поезда удержаны"}
        if propose:
            self.proposal = res
            eng.emit("plan_proposed", "warn",
                     f"План № {self.version} (составлен за {secs}, {names.get(res.solver, res.solver)}) "
                     f"ждёт решения диспетчера: карточек уровня C — {len(c_cards)}. Пока действует план "
                     f"№ {self.current.version if self.current else 0}",
                     data={"version": self.version, "solver": res.solver, "status": res.status})
        else:
            self._install(res.plan)
            sev = "critical" if res.status == "infeasible" else "info"
            eng.emit("plan_published", sev,
                     f"План № {self.version} составлен за {secs} ({names.get(res.solver, res.solver)}): "
                     f"{status_txt[res.status]}, {j}{gain} · причина: {res.reason}",
                     data={"version": self.version, "solver": res.solver, "status": res.status,
                           "ms": round(res.timings["total_ms"]), "cp_status": res.cp.status})
            self._level_a(res)
        win = auto.b_cancel_s
        # лента показывает карточки от новых к старым: нумеруем с конца, чтобы внутри одного пересчёта
        # они шли в порядке значимости — разбор сбоя первым
        for card in reversed(res.cards):
            self.card_seq += 1
            card["seq"] = self.card_seq
            card["full_auto"] = auto.full_auto
            card.setdefault("variants", [])
            card.setdefault("impact", None)
            card["chosen_variant"] = None
            card["outcome"] = None
            card["can_cancel"] = card["can_choose"] = False
            ctx = res.card_ctx.get(card["id"])
            if card["type"] == "no_plan":
                card["status"] = "applied"
            elif propose:
                if card["level"] == "C" and card["variants"]:
                    card["status"] = "pending"
                    card["can_choose"] = True
                    self.ctl[card["id"]] = Ctl(card, ctx, res.variants[card["id"]], math.inf, "choose", True, res.t0)
                else:
                    card["status"] = "proposed"
                    card["outcome"] = (f"решается выбором в карточке {card['choice_card']}" if card.get("choice_card")
                                       else "войдёт в силу вместе с выбором по карточке C")
                    self.ctl[card["id"]] = Ctl(card, ctx, [], math.inf, "wait", True, res.t0)
            elif card["level"] == "C" and card.get("choice_card"):
                card["status"] = "applied"
                card["outcome"] = f"полный авто: применено; варианты — в карточке {card['choice_card']}"
            elif card["level"] == "C" and card["variants"]:
                card["status"] = "applied"
                card["chosen_variant"] = "v1"
                card["can_choose"] = True
                card["outcome"] = "полный авто: применён лучший вариант, другой можно выбрать, пока идёт таймер"
                self.ctl[card["id"]] = Ctl(card, ctx, res.variants[card["id"]], win, "choose", False, res.t0)
            else:
                card["status"] = "applied"
                card["can_cancel"] = ctx is not None
                if ctx is not None:
                    self.ctl[card["id"]] = Ctl(card, ctx, [], win, "cancel", False, res.t0)
            self.cards.append(card)
            lvl = card["level"]
            pref = "требуется выбор: " if card["status"] == "pending" else ""
            eng.emit("decision", "warn" if lvl == "C" else "info", f"[{lvl}] {pref}{card['action']}",
                     station_id=card.get("station_id"), section_id=card.get("section_id"),
                     train_id=(card["trains"] or [None])[0], data={"card_id": card["id"]})
        log.info("plan v%d solver=%s status=%s total_ms=%.0f cp=%s J=%s cards=%d proposal=%s reason=%s",
                 self.version, res.solver, res.status, res.timings["total_ms"], res.cp.status,
                 None if res.cost is None else round(res.cost.total), len(res.cards), propose, res.reason)
        if not propose and eng.t - res.t0 > self.rt.cfg.solver.freeze_min * 60:
            self.request("план устарел за время расчёта")
        self.rt._mark_planner_update(res)

    def _level_a(self, res: PlanResult) -> None:
        """Уровень A: пути приёма и небольшие сдвиги — применены сами, в журнал одной строкой."""
        old, new = self.previous, res.plan
        if old is None or old is new:
            return
        eng = self.rt.engine
        lim = self.rt.cfg.autonomy.a_max_shift_min * 60
        tracks, shifts = set(), set()
        for tid, legs in new.legs.items():
            for lg in legs:
                if (tid, lg.k) in eng.entered:
                    continue
                o = old.leg(tid, lg.k)
                if o is None:
                    continue
                if o.track_id != lg.track_id:
                    tracks.add(eng.trains[tid].number)
                if 30 <= abs(lg.dep - o.dep) <= lim:
                    shifts.add(eng.trains[tid].number)
        if tracks or shifts:
            parts = []
            if tracks:
                parts.append(f"путь приёма изменён у {len(tracks)} п. ({', '.join(sorted(tracks)[:4])})")
            if shifts:
                parts.append(f"отправление сдвинуто в пределах {round(lim / 60)} мин у {len(shifts)} п.")
            eng.emit("decision_a", "debug", "[A] " + "; ".join(parts), data={"tracks": len(tracks),
                                                                             "shifts": len(shifts)})

    # ------------------------------------------------------------ действия диспетчера
    def _pair_entered(self, ctx: CardCtx) -> bool:
        ent = self.rt.engine.entered
        return ctx.first in ent or ctx.second in ent

    def _close(self, card_id: str, status: str | None, outcome: str | None = None) -> None:
        c = self.ctl.pop(card_id, None)
        if c is None:
            return
        card = c.card
        card["can_cancel"] = card["can_choose"] = False
        if status is not None:
            card["status"] = status
        if outcome is not None:
            card["outcome"] = outcome

    def _expire_by_movement(self) -> None:
        changed = []
        for cid, c in list(self.ctl.items()):
            if c.ctx is None or not self._pair_entered(c.ctx):
                continue
            if c.proposal and c.kind == "choose":
                self._close(cid, "expired", "решение не принято вовремя: поезда пошли по прежнему плану")
            elif c.proposal:
                self._close(cid, "expired", "не вступило в силу: по карточке C решение не принято")
            else:
                self._close(cid, None, "окно закрыто: поезд уже на перегоне")
            changed.append(c.card)
        if self.proposal is not None and not any(c.proposal for c in self.ctl.values()):
            self.proposal = None
            self.request("решение по карточке C не принято вовремя")
        if changed:
            self.rt._cards_updated(changed)

    def _supersede_proposal(self, why: str) -> None:
        changed = []
        for cid, c in list(self.ctl.items()):
            if c.proposal:
                self._close(cid, "superseded", why)
                changed.append(c.card)
        self.proposal = None
        if changed:
            self.rt._cards_updated(changed)

    def _pin(self, ctx: CardCtx, plan: Plan, card_id: str) -> None:
        la, lb = plan.leg(*ctx.first), plan.leg(*ctx.second)
        if la is None or lb is None:
            return
        first = ctx.first if la.dep <= lb.dep else ctx.second
        self.overrides[frozenset((ctx.first, ctx.second))] = first

    def _prune_overrides(self) -> None:
        ent = self.rt.engine.entered
        for pair in list(self.overrides):
            if any(x in ent for x in pair):
                del self.overrides[pair]

    def _order_kept(self, ctx: CardCtx, plan: Plan) -> bool:
        la, lb = plan.leg(*ctx.first), plan.leg(*ctx.second)
        return la is not None and lb is not None and la.dep <= lb.dep

    def _install_manual(self, plan: Plan, solver: str, note: str) -> Plan:
        p = copy.copy(plan)
        self.version += 1
        p.version = self.version
        p.created_at = self.rt.engine.t
        p.solver = solver
        p.notes = [note] + list(plan.notes or [])
        self._install(p)
        return p

    def cancel(self, card_id: str) -> str:
        eng = self.rt.engine
        c = self.ctl.get(card_id)
        if c is None or c.kind != "cancel":
            raise ActionError("Отмена недоступна: окно закрыто или решение не уровня B")
        ctx = c.ctx
        if self._pair_entered(ctx):
            self._close(card_id, None, "окно закрыто: поезд уже на перегоне")
            self.rt._cards_updated([c.card])
            raise ActionError("Поздно: поезд пары уже вошёл на перегон")
        cur = self.current
        pair = frozenset((ctx.first, ctx.second))
        if not self._order_kept(ctx, cur):
            self.overrides[pair] = ctx.second
            self._close(card_id, "cancelled", "порядок уже прежний: его вернул следующий пересчёт")
            self.rt._cards_updated([c.card])
            return c.card["outcome"]
        ov = dict(self.overrides)
        ov[pair] = ctx.second
        inp = build_input(eng, self.rt.cfg, cur, "отмена решения диспетчером", overrides=ov)
        fr = run_with_order(inp, cur, swap=(ctx.key, ctx.first, ctx.second))
        cand = self.planner._check(inp, Candidate(name="dispatcher", plan=fr.plan, ms=0.0, held=fr.held,
                                                  deadlock=fr.deadlock))
        if not cand.valid:
            why = cand.violations[0] if cand.violations else "взаимная блокировка"
            raise ActionError(f"Отмена невозможна: прежний порядок сейчас недопустим ({why})")
        la, lb = fr.plan.leg(*ctx.first), fr.plan.leg(*ctx.second)
        if la is None or lb is None or lb.dep >= la.dep:
            lost = ctx.first[0] if la is None else ctx.second[0]
            raise ActionError(f"Отмена невозможна: с прежним порядком поезд {eng.trains[lost].number} не "
                              f"укладывается в горизонт плана — решение Бағдара остаётся в силе")
        # цена отмены: тот же расчёт от текущего состояния с порядком, который был применён
        base = plan_cost(inp, run_with_order(inp, cur, release={ctx.first[0], ctx.second[0]}).plan)
        delta = cand.cost.total - base.total if cand.cost else 0.0
        fr.plan.status = "delayed" if any(
            tc.lateness_end_s > inp.trains[t].tol for t, tc in cand.cost.per_train.items()) else "feasible"
        fr.plan.cost = cand.cost.as_dict()
        fr.plan.horizon_end = inp.horizon_end
        p = self._install_manual(fr.plan, "dispatcher", f"отмена решения {card_id}")
        self.overrides[pair] = ctx.second
        msg = (f"Отменено диспетчером: прежний порядок восстановлен, план v{p.version}, "
               f"J {'+' if delta >= 0 else '−'}{abs(delta):.0f} у.е.")
        self._close(card_id, "cancelled", msg)
        eng.emit("decision_cancelled", "warn", f"Диспетчер отменил решение: {c.card['action']}. {msg}",
                 station_id=c.card.get("station_id"), train_id=ctx.second[0],
                 data={"card_id": card_id, "version": p.version, "delta_J": round(delta, 1)})
        self.rt._cards_updated([c.card])
        self.rt._plan_changed()
        return msg

    def choose(self, card_id: str, variant_id: str) -> str:
        eng = self.rt.engine
        c = self.ctl.get(card_id)
        if c is None or c.kind != "choose":
            raise ActionError("Выбор недоступен: окно закрыто или решение не уровня C")
        v = next((x for x in c.variants if x.id == variant_id), None)
        if v is None:
            raise ActionError(f"Нет варианта {variant_id}")
        if not v.valid:
            raise ActionError(f"Вариант недопустим: {v.note or 'не прошёл проверку'}")
        if c.ctx is not None and self._pair_entered(c.ctx):
            raise ActionError("Поздно: поезд пары уже вошёл на перегон")
        changed = [c.card]
        if c.proposal or variant_id != (c.card.get("chosen_variant") or ""):
            p = self._install_manual(v.plan, v.solver, f"выбор диспетчера {card_id}: {v.id}")
            applied = f"применён план v{p.version}"
        else:
            p = self.current
            applied = "подтверждён действующий план"
        if c.ctx is not None:
            self._pin(c.ctx, p, card_id)
        msg = f"Выбран вариант «{v.title}» ({v.cost.total:.0f} у.е.): {applied}"
        c.card["chosen_variant"] = v.id
        self._close(card_id, "chosen", msg)
        if c.proposal:
            # остальные карточки того же предложения: вступили ли их изменения в силу
            for cid, other in list(self.ctl.items()):
                if not other.proposal:
                    continue
                if other.kind == "choose":
                    self._close(cid, "superseded", f"решено выбором по карточке {card_id}")
                elif other.ctx is not None and self._order_kept(other.ctx, p):
                    other.card["status"] = "applied"
                    other.card["can_cancel"] = True
                    other.card["outcome"] = None
                    other.kind, other.proposal, other.left_s = "cancel", False, self.rt.cfg.autonomy.b_cancel_s
                else:
                    self._close(cid, "superseded", "выбранный вариант этого изменения не содержит")
                changed.append(other.card)
            self.proposal = None
        eng.emit("decision_chosen", "warn", f"Диспетчер: {msg}", station_id=c.card.get("station_id"),
                 data={"card_id": card_id, "variant": v.id, "version": p.version})
        if eng.t - c.plan_t0 > self.rt.cfg.solver.freeze_min * 60:
            self.request("выбор диспетчера: обновить времена плана")
        self.rt._cards_updated(changed)
        self.rt._plan_changed()
        return msg

    def set_full_auto(self, value: bool) -> None:
        self.rt.cfg.autonomy.full_auto = value
        if value and self.proposal is not None:
            # «полный авто»: решения C применяются лучшим вариантом
            first = next((cid for cid, c in self.ctl.items() if c.proposal and c.kind == "choose"), None)
            if first is not None:
                self.choose(first, "v1")

    # ------------------------------------------------------------ для API
    def actions(self) -> list[dict]:
        return [{"card_id": cid, "kind": c.kind, "left_s": None if math.isinf(c.left_s) else round(c.left_s, 1)}
                for cid, c in self.ctl.items() if c.kind in ("cancel", "choose")]

    def summary(self) -> dict:
        last = self.last
        cur = self.current
        fc = self.forecast
        return {
            "version": self.version,
            "applied_version": cur.version if cur else 0,
            "solver": cur.solver if cur else None,
            "status": cur.status if cur else None,
            "compute_ms": round(last.timings["total_ms"], 1) if last else None,
            "cpsat_ms": round(last.timings.get("cpsat_ms", 0.0), 1) if last else None,
            "cp_status": last.cp.status if last else None,
            "t0": round(last.t0, 1) if last else None,
            "J": round(cur.cost["total"], 1) if cur and cur.cost and "total" in cur.cost else
            (round(last.cost.total, 1) if last and last.cost else None),
            "busy": self.busy,
            "pending": list(self.pending),
            "conflicts": len(self.conflicts),
            "max_deviation_s": round(self.max_deviation),
            "reason": last.reason if last else None,
            "late_trains": last.late_trains if last else [],
            "held": cur.held if cur else [],
            "cards_total": self.card_seq,
            "full_auto": self.rt.cfg.autonomy.full_auto,
            "awaiting_choice": self.proposal is not None,
            "actions": self.actions(),
            "overrides": len(self.overrides),
            "recovery": self.recovery,
            "forecast": None if fc is None else {"value": fc["value"], "status": fc["status"],
                                                 "status_label": fc["status_label"]},
        }
