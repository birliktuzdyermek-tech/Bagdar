"""Карточки решений: что изменилось в плане, почему, какая была альтернатива
и насколько она хуже.

Решение — это смена порядка двух поездов на перегоне относительно прошлого
плана: перенос скрещения или обгон. Альтернатива оценивается честно, тем
же событийным планировщиком: берётся новый план, у этой пары
возвращается прежний порядок, всё остальное пересчитывается. Разница
целевой функции J и есть «на сколько альтернатива хуже».
"""
from __future__ import annotations

from dataclasses import dataclass

from bagdar.core.classes import TRAIN_CLASSES
from bagdar.index.compute import forecast_raw, score
from bagdar.models.plan import Plan, PlanLeg
from bagdar.planner.economics import CostBreakdown, plan_cost, section_sequences
from bagdar.planner.forward import run_with_order
from bagdar.planner.inputs import PlanningInput

MAX_FLIPS = 8


@dataclass
class CardCtx:
    """Внутреннее к карточке: какая пара, в каком порядке, план альтернативы."""
    key: tuple[str, int]
    first: tuple[str, int]        # идёт первым по новому плану
    second: tuple[str, int]
    alt_plan: Plan | None
    alt_cost: CostBreakdown | None


def _flips(inp: PlanningInput, old: Plan, new: Plan) -> list[tuple[tuple[str, int], PlanLeg, PlanLeg]]:
    """Пары, чей порядок на перегоне поменялся: (ключ перегона, первый по новому плану, второй)."""
    old_seq = section_sequences(old, inp.world, inp.entered)
    out = []
    for key, legs in section_sequences(new, inp.world, inp.entered).items():
        ol = old_seq.get(key)
        if not ol:
            continue
        opos = {(x.train_id, x.k): i for i, x in enumerate(ol)}
        common = [x for x in legs if (x.train_id, x.k) in opos]
        for i, a in enumerate(common):
            for b in common[i + 1:]:
                if a.train_id != b.train_id and opos[(a.train_id, a.k)] > opos[(b.train_id, b.k)]:
                    out.append((key, a, b))
    out.sort(key=lambda f: min(f[1].dep, f[2].dep))
    return out


def _name(inp: PlanningInput, tid: str) -> str:
    tr = inp.trains[tid].train
    label = TRAIN_CLASSES[tr.cls].label.split()[0]
    return f"{label} {tr.number}"


def _station(inp: PlanningInput, sid: str) -> str:
    return inp.world.stations[sid].name


def _track_name(inp: PlanningInput, track_id: str | None) -> str:
    if not track_id:
        return "—"
    st = inp.world.stations[track_id.split("-")[0]]
    t = next((x for x in st.tracks if x.id == track_id), None)
    return f"{t.name}-й путь" if t else track_id


def _wait_at(plan: Plan, tid: str, k: int, inp: PlanningInput) -> float:
    """Сколько поезд ждёт на станции перед плечом k."""
    leg = plan.leg(tid, k)
    if leg is None:
        return 0.0
    prev = plan.leg(tid, k - 1)
    ti = inp.trains[tid]
    arr = prev.arr if prev is not None else (inp.t0 if ti.phase in ("station", "pending") else leg.dep)
    need = 0.0
    li = ti.legs[k - 1] if k >= 1 else None
    if li is not None and li.planned_stop_next:
        need = li.dwell_next
    return max(0.0, leg.dep - arr - need)


def _mins(v: float) -> str:
    return f"{v:.1f}".replace(".", ",").replace(",0", "")


def _pair_cost(c: CostBreakdown, tids: list[str]) -> float:
    return sum((c.per_train[t].delay + c.per_train[t].stops + c.per_train[t].idle) for t in tids if t in c.per_train)


def _impact(inp: PlanningInput, plan: Plan, cost: CostBreakdown) -> tuple[dict, dict]:
    trains = {tid: ti.train for tid, ti in inp.trains.items()}
    raw = forecast_raw(inp.world, trains, plan, inp.rules, inp.t0)
    idx = score(inp.cfg.index, raw, inp.t0 + 3600)
    m = {
        "delay_min": round(sum(c.lateness_end_s for c in cost.per_train.values()) / 60, 1),
        "energy_kwh": round(sum(c.stop_kwh for c in cost.per_train.values()), 1),
        "track_load_pct": round(raw["track_load"]["share"] * 100, 1),
        "idle_pct": round(raw["resource_idle"]["share"] * 100, 1) if "share" in raw["resource_idle"] else None,
    }
    return m, idx


def build_cards(inp: PlanningInput, old: Plan | None, new: Plan, version: int,
                max_cards: int = 5) -> tuple[list[dict], dict[str, CardCtx]]:
    if old is None:
        return [], {}
    flips = _flips(inp, old, new)
    if not flips:
        return [], {}
    cards: list[dict] = []
    ctx: dict[str, CardCtx] = {}
    seen_pairs: set[tuple[str, str]] = set()
    exact = plan_cost(inp, new)          # опубликованный план — то, что увидит и исполнит диспетчер
    for key, a, b in flips[:MAX_FLIPS]:
        pair = tuple(sorted((a.train_id, b.train_id)))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        rel = {a.train_id, b.train_id}
        base = run_with_order(inp, new, release=rel)
        base_cost = plan_cost(inp, base.plan)
        mismatch = _mismatch(inp, new, base, rel)
        if mismatch:
            # быстрая модель не воспроизводит опубликованный план для этой пары — сравнивать
            # с её альтернативой нечестно: цифры были бы артефактом модели, а не ценой решения
            card = _describe(inp, key, a, b, new, base, exact, base, None, False, version, len(cards))
            card.update(_unreliable(inp, card, exact, mismatch))
            ctx[card["id"]] = CardCtx(key=key, first=(a.train_id, a.k), second=(b.train_id, b.k),
                                      alt_plan=None, alt_cost=None)
            m_plan, idx_plan = _impact(inp, new, exact)
            card["impact"] = {**{f"{k}_plan": v for k, v in m_plan.items()}, **{f"{k}_alt": None for k in m_plan}}
            card["index_after"] = idx_plan["value"]
            cards.append(card)
            continue
        alt = run_with_order(inp, new, swap=(key, (a.train_id, a.k), (b.train_id, b.k)), release=rel)
        alt_ok = not alt.deadlock and not (set(alt.held) - set(base.held))
        alt_cost = plan_cost(inp, alt.plan) if alt_ok else None
        card = _describe(inp, key, a, b, new, base, base_cost, alt, alt_cost, alt_ok, version, len(cards))
        m_plan, idx_plan = _impact(inp, base.plan, base_cost)
        impact = {f"{k}_plan": v for k, v in m_plan.items()}
        impact.update({f"{k}_alt": None for k in m_plan})
        card["index_after"] = idx_plan["value"]
        if alt_ok and alt_cost is not None:
            m_alt, idx_alt = _impact(inp, alt.plan, alt_cost)
            impact.update({f"{k}_alt": v for k, v in m_alt.items()})
            card["index_before"] = idx_alt["value"]
        card["impact"] = impact
        ctx[card["id"]] = CardCtx(key=key, first=(a.train_id, a.k), second=(b.train_id, b.k),
                                  alt_plan=alt.plan if alt_ok else None, alt_cost=alt_cost)
        if card.get("delta_money") is not None and card["delta_money"] < -1 and card["alt_pte_violations"] == 0:
            # альтернатива дешевле — решение держится ограничением плана, говорим это прямо
            card["note"] = ("по оценке альтернатива дешевле: решение удержано заморозкой ближайших минут "
                            "или ограничением горизонта; при следующем пересчёте может измениться")
        cards.append(card)
    # сначала решения с недопустимой альтернативой, затем по цене альтернативы, неоценённые — в конце
    cards.sort(key=lambda c: (0, 0.0) if (c["delta_cost"] is None and c.get("alt_reliable", True))
               else (2, 0.0) if c["delta_cost"] is None else (1, -c["delta_cost"]))
    cards = cards[:max_cards]
    return cards, {c["id"]: ctx[c["id"]] for c in cards}


MISMATCH_S = 300.0   # расхождение опоздания поезда пары между планом и быстрой моделью, после которого оценка не верна


def _mismatch(inp: PlanningInput, new: Plan, base, rel: set[str]) -> list[tuple[str, str, float, float]]:
    """Где быстрая модель расходится с опубликованным планом: сравниваются прибытия поезда пары
    в последней точке, которая есть в обоих планах (хвост за обрезанным горизонтом не в счёт).
    Возвращает [(поезд, станция, опоздание в плане, опоздание в модели), ...]."""
    out = []
    for t in sorted(rel):
        le = {lg.k: lg for lg in new.legs.get(t, [])}
        lb = {lg.k: lg for lg in base.plan.legs.get(t, [])}
        common = sorted(set(le) & set(lb))
        tr = inp.trains[t].train
        if not common:
            if le:
                out.append((t, le[min(le)].to_id, 0.0, float("nan")))
            continue
        k = common[-1]
        sa = tr.schedule[k + 1].arr
        stuck = t in base.held and max(lb) < max(le)
        if abs(le[k].arr - lb[k].arr) > MISMATCH_S or stuck:
            ref = sa if sa is not None else le[k].arr
            out.append((t, le[k].to_id, le[k].arr - ref, float("nan") if stuck else lb[k].arr - ref))
    return out


def _late_txt(sec: float) -> str:
    if sec != sec:   # NaN — модель поезд дальше не довела
        return "дальше не доведён"
    return f"{'+' if sec >= 0 else '−'}{_mins(abs(sec) / 60)} мин"


def _unreliable(inp: PlanningInput, card: dict, exact: CostBreakdown, mismatch) -> dict:
    parts = [f"{inp.trains[t].train.number} на ст. {_station(inp, sid)}: в плане {_late_txt(le)}, в модели оценки "
             f"{_late_txt(lb)}" for t, sid, le, lb in mismatch]
    effects = []
    for e in card["effects"]:
        pe = exact.per_train.get(e["train_id"])
        effects.append({**e, "delay_plan_min": round((pe.lateness_end_s if pe else 0) / 60, 1),
                        "stops_plan": pe.unplanned_stops if pe else 0, "delay_alt_min": None, "stops_alt": None})
    level = "B"
    for e in effects:
        ti = inp.trains[e["train_id"]]
        if ti.rank <= 3 and e["delay_plan_min"] * 60 > ti.tol:
            level = "C"
    weights = card["reason"].split(". Веса: ")[-1]
    return {
        "reason": ("Порядок выбран решателем как лучший по J всего плана. Точную цену альтернативы быстрая "
                   "модель оценки дать не может: она не воспроизводит этот план для пары (" + "; ".join(parts)
                   + "). Веса: " + weights),
        "effects": effects, "level": level, "alt_feasible": False, "alt_reliable": False,
        "cost_alt": None, "delta_cost": None, "delta_money": None, "alt_pte_violations": 0, "note": None,
    }


def _describe(inp, key, a: PlanLeg, b: PlanLeg, new: Plan, base, base_cost: CostBreakdown, alt, alt_cost,
              alt_ok: bool, version: int, n: int) -> dict:
    sec = inp.world.sections[key[0]]
    x, y = a.train_id, b.train_id          # x идёт первым по новому плану, y ждёт
    tx, ty = inp.trains[x], inp.trains[y]
    opposing = a.direction != b.direction
    wait_station = sec.from_station(b.direction)
    y_arr_leg = new.leg(y, b.k - 1)
    y_track = y_arr_leg.track_id if y_arr_leg is not None else (
        ty.track or new.origin_track.get(y) or ty.origin_track or "")
    wait_y = _wait_at(base.plan, y, b.k, inp)
    if opposing:
        kind = "crossing"
        alt_station = sec.from_station(a.direction)
        action = (f"{_name(inp, y)} принять на {_track_name(inp, y_track)} ст. {_station(inp, wait_station)} "
                  f"и пропустить {_name(inp, x)}: скрещение здесь")
        wait_x_alt = _wait_at(alt.plan, x, a.k, inp) if alt_ok else 0.0
        wait_txt = (f" ≈{round(wait_x_alt / 60)} мин" if wait_x_alt >= 60 else " без долгой стоянки") if alt_ok else ""
        alternative = (f"{_name(inp, x)} ждёт на ст. {_station(inp, alt_station)}{wait_txt}, "
                       f"{_name(inp, y)} проходит первым")
    else:
        kind = "overtake"
        action = (f"{_name(inp, y)} принять на {_track_name(inp, y_track)} ст. {_station(inp, wait_station)} "
                  f"и пропустить {_name(inp, x)} (обгон)")
        alternative = f"{_name(inp, x)} идёт вслед за {_name(inp, y)} без обгона"
    effects = []
    for t in (x, y):
        pb = base_cost.per_train.get(t)
        pa = alt_cost.per_train.get(t) if alt_cost else None
        effects.append({
            "train_id": t, "number": inp.trains[t].train.number,
            "delay_plan_min": round((pb.lateness_end_s if pb else 0) / 60, 1),
            "delay_alt_min": round((pa.lateness_end_s if pa else 0) / 60, 1) if pa else None,
            "stops_plan": pb.unplanned_stops if pb else 0,
            "stops_alt": pa.unplanned_stops if pa else None,
            "weight": round(inp.trains[t].w, 1),
        })
    cost_plan = _pair_cost(base_cost, [x, y])
    delta = None
    cost_alt = None
    pte_extra = 0
    if alt_ok and alt_cost is not None:
        delta = round(alt_cost.lex - base_cost.lex, 1)
        money = alt_cost.total - base_cost.total
        pte_extra = len(alt_cost.pte_violations) - len(base_cost.pte_violations)
        cost_alt = _pair_cost(alt_cost, [x, y])
        parts = []
        for e in effects:
            seg = f"{e['number']}: опоздание {_mins(e['delay_plan_min'])} → {_mins(e['delay_alt_min'])} мин"
            if e["stops_alt"] is not None and e["stops_alt"] > e["stops_plan"]:
                seg += f", +{e['stops_alt'] - e['stops_plan']} лишн. остановка"
            parts.append(seg)
        knock = money - (cost_alt - cost_plan)
        verdict = "дороже" if money >= 0 else "дешевле"
        reason = (f"Альтернатива {verdict} на {abs(money):.0f} у.е. (у.е. условные). В альтернативе " + "; ".join(parts)
                  + (f"; влияние на остальные поезда {knock:+.0f} у.е" if abs(knock) >= 1 else ""))
        if pte_extra > 0:
            reason += f". Кроме того, альтернатива нарушает ПТЭ: старший поезд выходит за допуск ({pte_extra} случ.)"
    else:
        reason = "Альтернатива недопустима: возникает взаимная блокировка или поезду негде встать"
    factors = []
    for t in (x, y):
        ti = inp.trains[t]
        f = ", ".join(lbl for lbl, _ in ti.factors[:2])
        factors.append(f"{ti.train.number} — вес {ti.w:.0f} у.е./мин" + (f" ({f})" if f else ""))
    reason += ". Веса: " + "; ".join(factors) + "."
    level = "B"
    for t, e in zip((x, y), effects):
        ti = inp.trains[t]
        if ti.rank <= 3 and e["delay_plan_min"] * 60 > ti.tol and (
                e["delay_alt_min"] is None or e["delay_plan_min"] > e["delay_alt_min"] + 1):
            level = "C"   # решение оставляет пассажирский сверх допуска — нужен выбор диспетчера
    return {
        "id": f"d-{version:04d}-{n}", "plan_version": version, "t": round(inp.t0, 1), "type": kind,
        "level": level, "station_id": wait_station, "station": _station(inp, wait_station), "section_id": sec.id,
        "trains": [x, y], "action": action, "reason": reason, "alternative": alternative,
        "cost_plan": round(cost_plan, 1), "cost_alt": None if cost_alt is None else round(cost_alt, 1),
        "delta_cost": delta, "delta_money": None if cost_alt is None else round(money, 1),
        "alt_pte_violations": max(0, pte_extra),
        "alt_feasible": alt_ok, "wait_min": round(wait_y / 60, 1), "effects": effects,
        "index_before": None, "index_after": None, "status": "applied", "alt_reliable": True,
    }
