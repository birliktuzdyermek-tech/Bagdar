"""Сводка прогона для дашборда: одна структура — индекс, движение, деньги, планировщик, сбои.

Деньги считаются теми же правилами, что в «Человек против Бағдара» (versus.score_runtime):
минуты задержки × тариф, кВт·ч неплановых остановок × тариф, часы простоя × тариф.
Внутри всё в условных единицах; во что их показывать (₸ по курсу или у.е.) — в тарифах.
"""
from __future__ import annotations

from bagdar.export import report_data
from bagdar.versus import score_runtime


def _downsample(points: list[tuple[float, float]], limit: int = 240) -> list[tuple[float, float]]:
    if len(points) <= limit:
        return points
    step = len(points) / limit
    return [points[int(i * step)] for i in range(limit)] + [points[-1]]


def dashboard_payload(rt, pos_cache: dict) -> dict:
    eng = rt.engine
    tar = rt.cfg.tariffs
    rep = report_data(rt)
    score = score_runtime(rt, tar, pos_cache)
    vals = [v for _, v in rep["index_history"]]
    cards = rt.planner.cards
    by_type: dict[str, int] = {}
    for c in cards:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1
    plans = rt.planner.history
    cp = sum(1 for h in plans if h.get("solver") == "cpsat")
    delayed = []
    for r in eng.rt.values():
        if r.status in ("station", "section"):
            d = eng.live_delay(r)
            if d >= 60:
                delayed.append({"id": r.train.id, "number": r.train.number, "cls": r.train.cls,
                                "delay_min": round(d / 60, 1), "passengers": r.train.passengers})
    delayed.sort(key=lambda x: -x["delay_min"])
    versus = None
    if rt.versus.active:
        v = rt.versus.payload(with_state=False)
        versus = {"left_total": v["left"]["score"]["money_total"], "right_total": v["right"]["score"]["money_total"],
                  "diff": v["diff"], "left": v["left"]["score"], "right": v["right"]["score"]}
    hours = (eng.t - eng.start_time) / 3600
    money = score["money"]
    per_hour = {k: (val / hours if hours > 0.05 else 0.0) for k, val in money.items()}
    return {
        "run": {"run_id": rt.run_id, "scenario_id": rep["scenario_id"], "scenario": rep["scenario"], "seed": eng.seed,
                "start_t": eng.start_time, "t": eng.t, "hours": round(hours, 2), "trains_total": len(rt.trains),
                "running": rt.running, "speed": rt.speed},
        "index": {"value": rep["index"], "status_label": rep["index_status"], "min": rep["index_min"],
                  "avg": round(sum(vals) / len(vals), 1) if vals else None,
                  "history": _downsample(rep["index_history"])},
        "traffic": {"active": rep["active"], "finished": score["finished"], "passages": score["passages"],
                    "on_time_share": rep["on_time"], "avg_delay_min": rep["avg_delay_min"],
                    "max_delay_min": rep["max_delay_min"], "late_trains": score["late_trains"],
                    "frozen": score["frozen"], "frozen_numbers": score["frozen_numbers"],
                    "delay_pax_min": score["delay_pax_min"], "delay_freight_min": score["delay_freight_min"],
                    "unplanned_stops": score["unplanned_stops"], "energy_kwh": score["energy_kwh"],
                    "idle_h": score["idle_h"]},
        "money": {"by": money, "total": score["money_total"], "per_hour": {k: round(v, 1) for k, v in per_hour.items()},
                  "currency": tar.currency, "per_unit": tar.tenge_per_unit,
                  "tariffs": {"kwh": tar.kwh, "loco_hour": tar.loco_hour, "crew_hour": tar.crew_hour,
                              "delay_min_pax": tar.delay_min_pax, "delay_min_freight": tar.delay_min_freight}},
        "planner": {"plans": rep["plans"], "replan_avg_s": rep["replan_avg_s"], "replan_max_s": rep["replan_max_s"],
                    "cards": rep["cards"], "levels": rep["levels"], "by_type": by_type,
                    "cpsat_share": round(cp / len(plans), 2) if plans else None,
                    "overrides": len(rt.planner.overrides)},
        "incidents": rep["incidents"],
        "top_delayed": delayed[:6],
        "versus": versus,
    }
