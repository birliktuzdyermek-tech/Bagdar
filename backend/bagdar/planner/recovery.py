"""Прогноз восстановления графика по действующему плану.

Поезд «задет», если в какой-либо будущей точке плана его опоздание больше
допуска класса. Поезд восстановился в первой точке, после которой он
остаётся в допуске, или когда покинул участок. График восстановится, когда
восстановится последний задетый поезд. Если задетый поезд к концу
горизонта всё ещё вне допуска — он считается отдельно («за горизонтом»), а
время восстановления дают поезда, которые восстанавливаются на горизонте.
"""
from __future__ import annotations

from bagdar.config import BagdarConfig
from bagdar.models.plan import Plan


def recovery(cfg: BagdarConfig, engine, plan: Plan) -> dict:
    now = engine.t
    affected: list[str] = []
    rec_at: float | None = None
    beyond = 0
    late_now = 0
    for rt in engine.active() + [r for r in engine.rt.values() if r.status == "pending"]:
        tr = rt.train
        tol = cfg.tolerance_s(tr.cls)
        if rt.status != "pending" and engine.live_delay(rt) > tol:
            late_now += 1
        legs = [lg for lg in plan.legs.get(tr.id, []) if lg.arr >= now]
        if not legs:
            if rt.status != "pending" and engine.live_delay(rt) > tol and rt.k < len(tr.route) - 1:
                affected.append(tr.id)
                beyond += 1
            continue
        bad_until: float | None = None
        ok_since: float | None = None
        for lg in legs:
            sa = tr.schedule[lg.k + 1].arr if lg.k + 1 < len(tr.schedule) else None
            if sa is None:
                continue
            if lg.arr - sa > tol:
                bad_until = lg.arr
                ok_since = None
            elif bad_until is not None and ok_since is None:
                ok_since = lg.arr
        if bad_until is None:
            continue
        affected.append(tr.id)
        if ok_since is not None:
            t_rec = ok_since
        elif legs[-1].to_id == tr.route[-1]:
            t_rec = legs[-1].arr                   # уходит с участка с опозданием
        else:
            beyond += 1
            continue
        rec_at = t_rec if rec_at is None else max(rec_at, t_rec)
    return {"affected": len(affected), "affected_ids": affected[:30], "late_now": late_now,
            "recovery_at": None if rec_at is None else round(rec_at, 1), "beyond_horizon": beyond}


WAVE_S = 120.0   # сдвиг прибытия, начиная с которого поезд считается задетым волной


def wave(before, after, now: float) -> dict:
    """Волна задержки: поезда, чьё прибытие в последней общей точке сдвинулось позже,
    чем в плане до события, хотя бы на 2 мин; поезда, которые план до события вёл, а новый
    до этой точки не довёл (стоят у закрытого перегона), тоже задеты."""
    ids: list[str] = []
    total = 0.0
    worst = 0.0
    for tid, blegs in before.legs.items():
        bl = {lg.k: lg for lg in blegs if lg.arr >= now}
        if not bl:
            continue
        al = {lg.k: lg for lg in after.legs.get(tid, [])}
        common = sorted(set(bl) & set(al))
        if not common:
            ids.append(tid)
            continue
        k = common[-1]
        d = al[k].arr - bl[k].arr
        if max(bl) > max(al) and max(bl) > k:
            d = max(d, WAVE_S)          # новый план не довёл поезд так далеко, как прежний
        if d >= WAVE_S:
            ids.append(tid)
            total += d
            worst = max(worst, d)
    return {"affected": len(ids), "ids": ids[:40], "delay_add_min": round(total / 60, 1),
            "worst_min": round(worst / 60, 1)}
