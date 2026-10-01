"""Подбор времени технологического «окна» на перегоне: когда закрыть перегон на N минут, чтобы потерять меньше.

Классическая задача диспетчера: путейцам нужно окно 60 минут, но «когда» — вопрос на деньги.
Перебираем старты окна в ближайшие часы (шаг 15 мин) и для каждого честно считаем план той же
событийной моделью, что и варианты придержания: с окном против базового плана без окна.
Отчёт по каждому варианту — сколько поездов задето, сколько минут добавилось, цена и застрявшие.
Лучший — минимальная цена с учётом ПТЭ (J_lex). Все цифры условные.
"""
from __future__ import annotations

import copy

from bagdar.planner.economics import plan_cost
from bagdar.planner.forward import run_greedy
from bagdar.planner.inputs import build_input

STEP_S = 15 * 60
LEAD_S = 10 * 60               # окно не раньше чем через 10 минут: путейцам нужно время выйти
EVAL_TAIL_S = 3600             # считать на час после конца окна, чтобы увидеть восстановление


def window_options(engine, cfg, prev_plan, section_id: str, minutes: int, horizon_min: int = 180) -> dict:
    world = engine.world
    sec = world.sections[section_id]
    inp = build_input(engine, cfg, prev_plan, "подбор окна")
    t0 = inp.t0
    dur = minutes * 60
    base_fr = run_greedy(inp)
    base = plan_cost(inp, base_fr.plan)
    base_late = {tid: tc.lateness_end_s for tid, tc in base.per_train.items()}
    out = []
    start = t0 + LEAD_S
    start = (int(start) // STEP_S + 1) * STEP_S           # к круглым четвертям часа
    last = t0 + horizon_min * 60 - dur
    while start <= last:
        x = copy.copy(inp)
        x.closed_sections = dict(inp.closed_sections)
        x.closed_sections[section_id] = (float(start), float(start + dur))
        x.horizon_end = max(inp.horizon_end, start + dur + EVAL_TAIL_S)
        x.reason = "окно"
        fr = run_greedy(x)
        c = plan_cost(x, fr.plan)
        affected = []
        add = 0.0
        for tid, tc in c.per_train.items():
            d = tc.lateness_end_s - base_late.get(tid, 0.0)
            if d > 60:
                affected.append(inp.trains[tid].train.number)
                add += d
        late = sum(1 for tid, tc in c.per_train.items() if tc.lateness_end_s > inp.trains[tid].tol)
        out.append({
            "id": f"w{int(start)}", "start": float(start), "end": float(start + dur),
            "J": round(c.total, 1), "J_lex": round(c.lex, 1), "delta_J": round(c.total - base.total, 1),
            "affected": len(affected), "numbers": affected[:6], "delay_add_min": round(add / 60, 1),
            "late_trains": late, "stuck": len(c.stuck), "pte": len(c.pte_violations), "valid": fr.plan is not None,
        })
        start += STEP_S
    best = min(out, key=lambda o: (o["stuck"] > 0, o["J_lex"])) if out else None
    worst = max(out, key=lambda o: o["J_lex"]) if out else None
    a = world.stations[sec.a].name
    b = world.stations[sec.b].name
    return {
        "section_id": section_id, "section": f"{a} — {b}", "minutes": minutes, "t": round(t0, 1),
        "horizon_min": horizon_min, "baseline": {"J": round(base.total, 1), "J_lex": round(base.lex, 1)},
        "options": out, "best": best["id"] if best else None, "worst": worst["id"] if worst else None,
    }
