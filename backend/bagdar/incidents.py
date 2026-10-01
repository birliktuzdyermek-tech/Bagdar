"""Нештатные ситуации: сбои, их таймеры, сценарии и разбор «до / после».

Что делает система после любого события (BAGDAR.md, раздел 8):
1. фиксирует исходное состояние (индекс, прогноз восстановления, план);
2. применяет сбой к модели и сразу показывает, какие операции действующего
   плана теперь конфликтуют (радар конфликтов);
3. запускает пересчёт плана вне очереди;
4. сравнивает новый план с прежним: сколько поездов задето, когда график
   восстановится, сколько стоило бы «ничего не менять в порядке» и
   «кто первый пришёл, тот первый едет»;
5. выдаёт карточку инцидента с уровнем автономии по таблице раздела 8; для
   уровня C — 2–3 варианта с ценой.

Сбой с длительностью восстанавливается сам по таймеру модели; любой можно
снять раньше вручную. Сценарий — это список таких событий по времени.
"""
from __future__ import annotations

import logging
import random
from dataclasses import asdict, dataclass, field

from bagdar.config import parse_hhmm
from bagdar.core.classes import TRAIN_CLASSES
from bagdar.generator.extra_trains import make_trains
from bagdar.index import forecast_index
from bagdar.index.compute import forecast_raw
from bagdar.planner.conflicts import project_conflicts
from bagdar.planner.economics import plan_cost
from bagdar.planner.forward import run_fifo
from bagdar.planner.propagation import delay_tree
from bagdar.planner.recovery import recovery, wave

log = logging.getLogger("bagdar.incidents")

KINDS = {
    "train_delay": "Опоздание поезда",
    "crew_short": "Бригада на исходе",
    "section_closed": "Закрытие перегона",
    "signal_fault": "Неисправность светофора",
    "track_unavailable": "Путь недоступен",
    "switch_fault": "Неисправность стрелки",
    "speed_restriction": "Ограничение скорости",
    "add_trains": "Рост потока поездов",
    "extra_train": "Внеочередной поезд",
    "hold_at_origin": "Придержание на станциях отправления",
}
RESTORABLE = {"section_closed", "signal_fault", "track_unavailable", "switch_fault", "speed_restriction"}


@dataclass
class Incident:
    id: str
    t: float
    kind: str
    level: str
    title: str
    params: dict
    source: str = "dispatcher"            # dispatcher | scenario
    resource: str | None = None
    station_id: str | None = None
    section_id: str | None = None
    train_ids: list[str] = field(default_factory=list)
    until: float | None = None
    status: str = "active"                # active | resolved | done
    resolved_at: float | None = None
    before: dict | None = None
    after: dict | None = None
    card_id: str | None = None
    prev_plan: object | None = field(default=None, repr=False)   # план до события — база для «волны»

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("prev_plan", None)
        return d


def _lower1(text: str) -> str:
    """Первая буква строчная, аббревиатуры (CP-SAT) не трогаются."""
    return text if not text or text[:2].isupper() else text[0].lower() + text[1:]


def _sentence(text: str) -> str:
    """Предложение с заглавной буквы и ровно одной точкой в конце (без «у.е..»)."""
    text = text.strip().rstrip(";, ")
    if not text:
        return ""
    i = next((j for j, ch in enumerate(text) if ch.isalnum()), 0)    # после кавычек «, но не после цифры
    text = text[:i] + text[i].upper() + text[i + 1:]
    return text if text.endswith(".") else text + "."


def _min(x: float | None) -> str:
    if x is None:
        return "неизвестный срок"
    return f"{round(x)} мин"


class IncidentManager:
    def __init__(self, runtime) -> None:
        self.rt = runtime
        self.reset(None)

    # ------------------------------------------------------------ жизненный цикл
    def reset(self, scenario) -> None:
        self.items: list[Incident] = []
        self.seq = 0
        self.tseq = 0
        self.timeline: list[tuple[float, int, str, dict, str]] = []
        self.waiting: list[str] = []
        if scenario is not None:
            for d in scenario.disruptions:
                self.schedule(parse_hhmm(d.at), d.type, dict(d.params), "scenario")

    def schedule(self, t: float, kind: str, params: dict, source: str) -> None:
        self.tseq += 1
        self.timeline.append((t, self.tseq, kind, params, source))
        self.timeline.sort(key=lambda x: (x[0], x[1]))

    def next_at(self) -> float | None:
        return self.timeline[0][0] if self.timeline else None

    def tick(self) -> None:
        eng = self.rt.engine
        while self.timeline and self.timeline[0][0] <= eng.t:
            _, _, kind, params, source = self.timeline.pop(0)
            try:
                if kind == "restore":
                    self.restore(params["incident_id"], auto=True)
                else:
                    self.apply(kind, params, source)
            except (ValueError, KeyError) as e:
                eng.emit("incident_error", "warn", f"Событие сценария «{KINDS.get(kind, kind)}» не применено: {e}")

    def take_waiting(self) -> list[str]:
        out, self.waiting = self.waiting, []
        return out

    def get(self, inc_id: str) -> Incident | None:
        return next((i for i in self.items if i.id == inc_id), None)

    def active(self) -> list[Incident]:
        return [i for i in self.items if i.status == "active"]

    # ------------------------------------------------------------ применение
    def _new(self, kind: str, level: str, title: str, params: dict, source: str, **kw) -> Incident:
        self.seq += 1
        inc = Incident(id=f"inc-{self.seq:02d}", t=round(self.rt.engine.t, 1), kind=kind, level=level, title=title,
                       params=params, source=source, **kw)
        self.items.append(inc)
        return inc

    def _section(self, params: dict) -> str:
        sid = params.get("section_id")
        if sid not in self.rt.engine.world.sections:
            raise ValueError(f"Нет перегона {sid}")
        return sid

    def _sec_name(self, sid: str) -> str:
        w = self.rt.engine.world
        sec = w.sections[sid]
        return f"{w.stations[sec.a].name} — {w.stations[sec.b].name}"

    def _pick_train(self, params: dict) -> str:
        eng = self.rt.engine
        tid = params.get("train_id")
        if tid:
            return tid
        cls = params.get("train_class")
        nth = int(params.get("nth", 0))
        cand = [rt for rt in eng.active() if rt.k < len(rt.train.route) - 1 and
                (cls is None or rt.train.cls == cls or (cls == "passenger_any" and rt.train.pte_rank <= 3))]
        cand.sort(key=lambda rt: rt.train.id)
        if not cand:
            raise ValueError(f"на участке нет поезда класса {cls}")
        return cand[min(nth, len(cand) - 1)].train.id

    def _pick_track(self, params: dict) -> str:
        eng = self.rt.engine
        if params.get("track_id"):
            if params["track_id"] not in eng.il.tracks:
                raise ValueError(f"Нет пути {params['track_id']}")
            return params["track_id"]
        sid = params.get("station_id")
        st = eng.world.stations.get(sid)
        if st is None:
            raise ValueError(f"Нет станции {sid}")
        side = sorted((t for t in st.tracks if not t.is_main), key=lambda t: -t.length_m)
        if not side:
            raise ValueError(f"На ст. {st.name} нет боковых путей")
        return side[0].id

    def apply(self, kind: str, params: dict, source: str = "dispatcher") -> tuple[str, Incident]:
        eng = self.rt.engine
        now = eng.t
        minutes = params.get("minutes")
        minutes = None if minutes in (None, "", "unknown") else float(minutes)
        until = None if minutes is None else now + minutes * 60
        reason = params.get("reason") or ""
        if kind == "train_delay":
            tid = self._pick_train(params)
            m = float(params.get("minutes", 10))
            if not (1 <= m <= 240):
                raise ValueError("Задержка — от 1 до 240 мин")
            where = eng.inject_delay(tid, m * 60, reason or "внешнее событие")
            num = eng.trains[tid].number
            inc = self._new(kind, "A" if m <= 10 else "B", f"Опоздание поезда {num} на {round(m)} мин", params,
                            source, resource=tid, train_ids=[tid])
            msg = f"Поезд {num}: {where}"
        elif kind == "crew_short":
            tid = self._pick_train(params)
            m = float(params.get("minutes", 40))
            if not (5 <= m <= 600):
                raise ValueError("Остаток смены — от 5 до 600 мин")
            tr = eng.trains[tid]
            tr.crew_shift_end = now + m * 60
            inc = self._new(kind, "B", f"Бригаде поезда {tr.number} осталось {round(m)} мин смены", params, source,
                            resource=tid, train_ids=[tid])
            msg = (f"Поезд {tr.number}: у бригады осталось {round(m)} мин. Бағдар проверит по плану, доедет ли она "
                   f"до пункта смены, и поднимет приоритет поезда")
        elif kind == "section_closed":
            sid = self._section(params)
            if eng.il.sections[sid].status == "closed":
                raise ValueError(f"Перегон {self._sec_name(sid)} уже закрыт")
            eng.close_section(sid, until)
            inc = self._new(kind, "C", f"Закрыт перегон {self._sec_name(sid)} на {_min(minutes)}", params, source,
                            resource=sid, section_id=sid, until=until)
            msg = inc.title
        elif kind == "signal_fault":
            sid = self._section(params)
            d = params.get("direction")
            eng.set_signal_fault(sid, True, None if d is None else int(d))
            inc = self._new(kind, "B", f"Неисправен светофор на перегоне {self._sec_name(sid)}: движение как при "
                            f"ПАБ, не выше 40 км/ч, {_min(minutes)}", params, source, resource=sid, section_id=sid,
                            until=until)
            msg = inc.title
        elif kind in ("track_unavailable", "switch_fault"):
            trk = self._pick_track(params)
            if not eng.il.tracks[trk].available:
                raise ValueError(f"Путь {trk} уже недоступен")
            eng.set_track_available(trk, False)
            st = eng.world.stations[trk.split("-")[0]]
            tname = next(t.name for t in st.tracks if t.id == trk)
            what = "Неисправна стрелка: " if kind == "switch_fault" else ""
            inc = self._new(kind, "B", f"{what}путь {tname} ст. {st.name} недоступен на {_min(minutes)}", params,
                            source, resource=trk, station_id=st.id, until=until)
            msg = inc.title
        elif kind == "speed_restriction":
            sid = self._section(params)
            kmh = float(params.get("kmh", 40))
            eng.set_speed_restriction(sid, kmh)
            inc = self._new(kind, "B", f"Ограничение {round(kmh)} км/ч на перегоне {self._sec_name(sid)}, "
                            f"{_min(minutes)}", params, source, resource=sid, section_id=sid, until=until)
            msg = inc.title
        elif kind == "hold_at_origin":
            ids = list(params.get("train_ids") or [])
            m = float(params.get("minutes", 30))
            held = []
            for tid in ids:
                rt = eng.rt.get(tid)
                if rt is None or rt.status != "pending":
                    continue
                eng.inject_delay(tid, m * 60, reason or "придержание при насыщении участка")
                held.append(eng.trains[tid].number)
            if not held:
                raise ValueError("Нет поездов, которые ещё не вышли на участок")
            inc = self._new(kind, "B", f"Придержано {len(held)} грузовых на станциях отправления на "
                            f"{round(m)} мин ({', '.join(held)})", params, source, train_ids=ids)
            msg = inc.title
        elif kind in ("add_trains", "extra_train"):
            trains = self._make_trains(kind, params)
            self.rt.add_trains(trains)
            nums = ", ".join(t.number for t in trains[:6]) + ("…" if len(trains) > 6 else "")
            if kind == "extra_train":
                title = f"Внеочередной поезд {trains[0].number} ({TRAIN_CLASSES[trains[0].cls].label.lower()})"
            else:
                title = f"Рост потока: +{len(trains)} п. ({nums})"
            inc = self._new(kind, "B", title, params, source, train_ids=[t.id for t in trains])
            msg = title
        else:
            raise ValueError(f"Неизвестный тип события «{kind}»")
        if inc.until is not None and kind in RESTORABLE:
            self.schedule(inc.until, "restore", {"incident_id": inc.id}, "timer")
        self._snapshot_before(inc)
        sev = "critical" if inc.level == "C" else "warn"
        eng.emit("incident", sev, f"[{inc.level}] {inc.title}" + (f" ({reason})" if reason else ""),
                 section_id=inc.section_id, station_id=inc.station_id,
                 train_id=inc.train_ids[0] if inc.train_ids else None,
                 data={"incident_id": inc.id, "kind": kind, "until": inc.until})
        self.waiting.append(inc.id)
        self.rt.planner.request(f"{KINDS[kind].lower()}: {inc.title}", urgent=True)
        log.info("incident %s %s level=%s source=%s", inc.id, inc.title, inc.level, source)
        return msg, inc

    def _make_trains(self, kind: str, params: dict) -> list:
        eng = self.rt.engine
        now = eng.t
        rnd = random.Random(eng.seed * 31 + self.seq * 7 + 3)
        items = []
        if kind == "extra_train":
            items.append({"cls": "extraordinary", "direction": int(params.get("direction", 1)),
                          "dep": now + float(params.get("in_min", 5)) * 60})
        elif params.get("trains"):
            for it in params["trains"]:
                it = dict(it)
                if "dep" in it and isinstance(it["dep"], str):
                    it["dep"] = parse_hhmm(it["dep"])
                else:
                    it["dep"] = now + float(it.pop("in_min", 5)) * 60
                items.append(it)
        else:
            count = int(params.get("count", 6))
            within = float(params.get("within_min", 30))
            if not (1 <= count <= 60):
                raise ValueError("Рост потока — от 1 до 60 поездов")
            share = float(params.get("express_share", 0.2))
            for i in range(count):
                items.append({"cls": "express_freight" if rnd.random() < share else "freight",
                              "direction": 1 if i % 2 == 0 else -1,
                              "dep": now + 300 + within * 60 * (i + rnd.uniform(0.1, 0.9)) / count})
        return make_trains(eng.world, eng.rules, list(eng.trains.values()), items, rnd.randint(1, 10 ** 6))

    def restore(self, inc_id: str, auto: bool = False) -> str:
        eng = self.rt.engine
        inc = self.get(inc_id)
        if inc is None:
            raise ValueError(f"Нет инцидента {inc_id}")
        if inc.status != "active" or inc.kind not in RESTORABLE:
            raise ValueError("Этот инцидент нельзя снять: он не действует или разовый")
        if inc.kind == "section_closed":
            eng.open_section(inc.resource)
            what = f"Перегон {self._sec_name(inc.resource)} открыт"
        elif inc.kind == "signal_fault":
            eng.set_signal_fault(inc.resource, False)
            what = f"Светофор на перегоне {self._sec_name(inc.resource)} исправен"
        elif inc.kind == "speed_restriction":
            eng.set_speed_restriction(inc.resource, None)
            what = f"Ограничение скорости на перегоне {self._sec_name(inc.resource)} снято"
        else:
            eng.set_track_available(inc.resource, True)
            what = f"Путь {inc.resource} снова доступен"
        inc.status = "resolved"
        inc.resolved_at = round(eng.t, 1)
        self.timeline = [x for x in self.timeline if not (x[2] == "restore" and x[3].get("incident_id") == inc_id)]
        eng.emit("incident_resolved", "info", f"{what} ({'по таймеру' if auto else 'вручную'})",
                 section_id=inc.section_id, station_id=inc.station_id, data={"incident_id": inc.id})
        self.rt.planner.request(f"восстановление: {what}", urgent=True)
        return what

    # ------------------------------------------------------------ до / после
    def _snapshot_before(self, inc: Incident) -> None:
        rt = self.rt
        eng = rt.engine
        P = rt.planner
        conflicts, _, _ = project_conflicts(eng, P.current) if P.current is not None else ([], 0, None)
        cur = P.current
        inc.prev_plan = cur
        inc.before = {
            "index": None if rt.index.current is None else rt.index.current.get("value"),
            "forecast": None if P.forecast is None else P.forecast.get("value"),
            "affected": None if P.recovery is None else P.recovery.get("affected"),
            "recovery_at": None if P.recovery is None else P.recovery.get("recovery_at"),
            "plan_version": cur.version if cur else 0,
            "J": cur.cost.get("total") if cur and cur.cost else None,
            "conflicts": len(conflicts),
            "first_conflict": conflicts[0]["message"] if conflicts else None,
        }

    def _summary(self, plan, cost, res, prev=None) -> dict:
        eng = self.rt.engine
        rec = recovery(self.rt.cfg, eng, plan)
        wv = wave(prev, plan, eng.t) if prev is not None else None
        fc = forecast_index(self.rt.cfg.index, eng.world, eng.trains, plan, eng.rules, eng.t)
        late = sum(c.lateness_end_s for c in cost.per_train.values()) / 60 if cost else None
        return {"J": None if cost is None else round(cost.total, 1),
                "J_lex": None if cost is None else round(cost.lex, 1),
                "delay_min": None if late is None else round(late, 1),
                "affected": wv["affected"] if wv else rec["affected"], "recovery_at": rec["recovery_at"],
                "beyond": rec["beyond_horizon"], "late_trains": rec["affected"],
                "delay_add_min": wv["delay_add_min"] if wv else None,
                "forecast": fc["value"], "pte": len(cost.pte_violations) if cost else 0,
                "stuck": len(cost.stuck) if cost else 0}

    def on_result(self, res, ids: list[str]) -> list[dict]:
        """Разбор после пересчёта: карточка инцидента. Возвращает новые карточки."""
        cards = []
        for n, inc_id in enumerate(ids):
            inc = self.get(inc_id)
            if inc is None or res.solver == "hold" and res.inp is None:
                continue
            try:
                cards.append(self._card(inc, res, n))
            except Exception:  # noqa: BLE001 — разбор не должен ронять применение плана
                log.exception("incident report failed")
        return cards

    def _card(self, inc: Incident, res, n: int) -> dict:
        from bagdar.planner.service import Variant
        eng = self.rt.engine
        inp = res.inp
        prev = inc.prev_plan
        after = self._summary(res.plan, res.cost, res, prev)
        after.update({"plan_version": res.plan.version, "solver": res.solver, "status": res.status,
                      "compute_ms": round(res.timings["total_ms"])})
        repair = next((c for c in res.candidates if c.name == "repair"), None)
        no_change = None
        if repair is not None and repair.plan is not None and repair.cost is not None:
            no_change = self._summary(repair.plan, repair.cost, res, prev)
            no_change["valid"] = repair.valid
            no_change["why"] = (repair.violations[0] if repair.violations else
                                ("взаимная блокировка" if repair.deadlock else None))
        fifo = None
        if inp is not None:
            # эталон «без Бағдара»: без приоритетов, придержаний и правила «на две станции вперёд»
            fr = run_fifo(inp)
            fifo = self._summary(fr.plan, plan_cost(inp, fr.plan), res, prev)
            fifo["deadlock"] = fr.deadlock
            fifo["same"] = res.solver == "fifo"
            if inc.kind == "train_delay" and inc.train_ids:
                fifo["tree"] = delay_tree(inp, fr.plan, inc.train_ids[0])
        tree = delay_tree(inp, res.plan, inc.train_ids[0]) if (inp is not None and inc.kind == "train_delay"
                                                                and inc.train_ids) else None
        inc.after = {"plan": after, "no_change": no_change, "fifo": fifo, "tree": tree}
        inc.prev_plan = None
        if inc.kind not in RESTORABLE:
            inc.status = "done"

        def rec_txt(s: dict) -> str:
            parts = [f"задето {s['affected']} п." + (f" (+{s['delay_add_min']:.0f} поездо-мин)"
                                                     if s.get("delay_add_min") else "")]
            if s.get("late_trains"):
                parts.append(f"сверх допуска {s['late_trains']}")
            if s.get("pte"):
                parts.append(f"нарушений ПТЭ {s['pte']}")
            if s.get("stuck"):
                parts.append(f"застряло в плане {s['stuck']} п.")
            return ", ".join(parts)

        def cost_txt(s: dict, base: dict | None = None) -> str:
            if s.get("J_lex") is None:
                return ""
            txt = f"цена {s['J_lex']:.0f} у.е."
            if base is not None and base.get("J_lex") is not None:
                d = s["J_lex"] - base["J_lex"]
                txt += f" ({'+' if d >= 0 else '−'}{abs(d):.0f})"
            return txt

        parts = [f"После пересчёта: {rec_txt(after)}; {cost_txt(after)}"]
        if after["recovery_at"] is not None:
            parts.append(f"график восстановится через {max(1, round((after['recovery_at'] - eng.t) / 60))} мин"
                         + (f", {after['beyond']} п. — за горизонтом 3 ч" if after["beyond"] else ""))
        if no_change is not None:
            if no_change["valid"]:
                parts.append(f"Без перестройки порядка: {rec_txt(no_change)}; {cost_txt(no_change, after)}")
            else:
                parts.append(f"Прежний порядок недопустим: {no_change['why']}")
        if fifo is not None and fifo.get("same"):
            parts.append("Лучшим оказался порядок «кто первый пришёл» с защитой от замка: перестановки по "
                         "приоритетам здесь выигрыша не дают")
        if fifo is not None:
            parts.append("«Кто первый пришёл»: " + ("взаимная блокировка, " if fifo["deadlock"] else "")
                         + f"{rec_txt(fifo)}; {cost_txt(fifo, after)}")
        if tree is not None:
            parts.append(f"Дерево задержки: задето {tree['affected']} п."
                         + (f", без Бағдара — {fifo['tree']['affected']}" if fifo and fifo.get("tree") else ""))
        parts.append("Цена — J с учётом нарушений ПТЭ, у.е. условные")
        reason = " ".join(_sentence(x) for x in parts if x)
        alternative = "Ничего не менять в порядке поездов: поезда ждут в прежней очерёдности"
        version = res.plan.version
        card = {
            "id": f"d-{version:04d}-i{n}", "plan_version": version, "t": round(eng.t, 1), "type": "incident",
            "level": inc.level, "station_id": inc.station_id, "station": None, "section_id": inc.section_id,
            "trains": list(inc.train_ids[:4]), "action": f"{inc.title}: план № {version} перестроен за "
            + f"{res.timings['total_ms'] / 1000:.1f} с".replace(".", ","),
            "reason": reason, "alternative": alternative,
            "cost_plan": after["J_lex"], "cost_alt": no_change["J_lex"] if no_change and no_change["valid"] else None,
            "delta_cost": None, "delta_money": (round(no_change["J_lex"] - after["J_lex"], 1)
                                                if no_change and no_change["valid"] and after["J_lex"] is not None
                                                else None),
            "alt_pte_violations": 0, "alt_feasible": bool(no_change and no_change["valid"]), "alt_reliable": True,
            "wait_min": None, "effects": [], "index_before": inc.before.get("forecast") if inc.before else None,
            "index_after": after["forecast"], "status": "applied", "note": None, "incident_id": inc.id,
            "impact": self._impact(res, repair),
        }
        if inc.level == "C" and res.cost is not None:
            variants = []
            best = next((c for c in res.candidates if c.name == res.solver), None)
            titles = {"repair": "Поезда ждут в прежнем порядке (без перестройки)",
                      "greedy": "Очередь по классу и весу поездов",
                      "cpsat": "Оптимизация CP-SAT",
                      "fifo": "«Кто первый пришёл» без приоритетов, с защитой от замка"}
            if best is not None and best.plan is not None:
                variants.append(Variant("v1", "Рекомендация Бағдара: " + _lower1(titles.get(best.name, best.name)),
                                        best.name, best.plan, best.cost, True,
                                        self._late_pax(inp, best.cost)))
            for c in res.candidates:
                if len(variants) >= 3 or c is best or not c.valid or c.plan is None or c.cost is None:
                    continue
                variants.append(Variant(f"v{len(variants) + 1}", titles.get(c.name, c.name), c.name, c.plan,
                                        c.cost, True, self._late_pax(inp, c.cost)))
            if len(variants) >= 2:
                res.variants[card["id"]] = variants
                card["variants"] = [v.public(res.cost) for v in variants]
                for v, pub in zip(variants, card["variants"]):
                    s = self._summary(v.plan, v.cost, res, prev)
                    pub["note"] = (f"задето {s['affected']} п., задержка {s['delay_min']:.0f} поездо-мин, "
                                   f"индекс через час {round(s['forecast']) if s['forecast'] is not None else '—'}")
        card["report"] = {"before": inc.before, **inc.after}
        inc.card_id = card["id"]
        return card

    @staticmethod
    def _late_pax(inp, cost) -> int:
        if inp is None or cost is None:
            return 0
        return sum(1 for tid, tc in cost.per_train.items()
                   if tid in inp.trains and inp.trains[tid].rank <= 3 and tc.lateness_end_s > inp.trains[tid].tol)

    def _impact(self, res, repair) -> dict | None:
        inp = res.inp
        if inp is None or res.cost is None:
            return None
        trains = {tid: ti.train for tid, ti in inp.trains.items()}

        def m(plan, cost):
            raw = forecast_raw(inp.world, trains, plan, inp.rules, inp.t0)
            return {"delay_min": round(sum(c.lateness_end_s for c in cost.per_train.values()) / 60, 1),
                    "energy_kwh": round(sum(c.stop_kwh for c in cost.per_train.values()), 1),
                    "track_load_pct": round(raw["track_load"]["share"] * 100, 1),
                    "idle_pct": round(raw["resource_idle"]["share"] * 100, 1) if "share" in raw["resource_idle"]
                    else None}
        a = m(res.plan, res.cost)
        out = {f"{k}_plan": v for k, v in a.items()}
        if repair is not None and repair.valid and repair.plan is not None and repair.cost is not None:
            b = m(repair.plan, repair.cost)
            out.update({f"{k}_alt": v for k, v in b.items()})
        else:
            out.update({f"{k}_alt": None for k in a})
        return out

    # ------------------------------------------------------------ для API
    def payload(self) -> list[dict]:
        return [i.to_dict() for i in self.items[-50:]]

    def active_payload(self) -> list[dict]:
        return [{"id": i.id, "kind": i.kind, "level": i.level, "title": i.title, "resource": i.resource,
                 "section_id": i.section_id, "station_id": i.station_id, "until": i.until, "t": i.t,
                 "restorable": i.kind in RESTORABLE}
                for i in self.items if i.status == "active"]
