"""Ответ на «тихое насыщение»: придержать несколько грузовых на станциях отправления.

Варианты сравниваются честно — той же событийной моделью на 4 часа вперёд
(дальше горизонта плана, потому что насыщение — процесс долгий): «ничего не
делать», «придержать 2 грузовых на 30 мин», «придержать 4». Придерживаются
самые малоценные грузовые (минимальный вес задержки), которым по графику
отправляться в ближайшие полтора часа и которые ещё не вышли на участок.
"""
from __future__ import annotations

import copy

from bagdar.planner.economics import plan_cost
from bagdar.planner.forward import run_greedy
from bagdar.planner.inputs import _earliest, build_input

EVAL_HORIZON_S = 4 * 3600
HOLD_MIN = 30


def metering_options(engine, cfg, prev_plan) -> dict:
    inp = build_input(engine, cfg, prev_plan, "оценка придержания")
    t0 = inp.t0
    cands = sorted((ti for ti in inp.trains.values()
                    if ti.phase == "pending" and ti.train.pte_rank >= 4 and ti.origin_dep <= t0 + 5400),
                   key=lambda ti: (ti.w, ti.origin_dep))
    out = []
    for k in (0, 2, 4):
        if k > len(cands):
            break
        x = copy.copy(inp)
        x.trains = dict(inp.trains)
        x.horizon_end = t0 + EVAL_HORIZON_S
        ids = []
        for ti in cands[:k]:
            t2 = copy.copy(ti)
            t2.t_ready = max(ti.t_ready, t0) + HOLD_MIN * 60
            t2.earliest_dep = _earliest(t2, t0)
            x.trains[ti.id] = t2
            ids.append(ti.id)
        fr = run_greedy(x)
        c = plan_cost(x, fr.plan)
        lat = [tc.lateness_end_s for tc in c.per_train.values()]
        out.append({"id": f"m{k}", "hold": k, "train_ids": ids,
                    "numbers": [inp.trains[i].train.number for i in ids], "minutes": HOLD_MIN if k else 0,
                    "J": round(c.total, 1), "J_lex": round(c.lex, 1), "stuck": len(c.stuck),
                    "avg_late_min": round(sum(lat) / len(lat) / 60, 1) if lat else 0.0,
                    "title": "Ничего не делать" if k == 0 else
                    f"Придержать {k} грузовых на станциях отправления на {HOLD_MIN} мин"})
    best = min(out, key=lambda o: o["J_lex"]) if out else None
    return {"t": round(t0, 1), "horizon_h": EVAL_HORIZON_S // 3600, "options": out,
            "best": best["id"] if best else None}
