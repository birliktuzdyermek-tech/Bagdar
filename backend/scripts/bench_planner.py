"""Замер времени пересчёта плана. Результат — таблица в docs/BENCHMARK.md.

Сейчас — лёгкий режим (участок, ~20 поездов одновременно, ~30 в горизонте 3 ч).
Средний (100–150) и ультра (до 1 000) добавятся на этапах 8–9.
Запуск: python3 scripts/bench_planner.py
"""
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from conftest import START, build  # noqa: E402

from bagdar.config import load_config  # noqa: E402
from bagdar.planner.economics import (EXTRA_PENALTY, PTE_PENALTY_PER_MIN, STUCK_MARGIN_S,  # noqa: E402
                                      STUCK_PENALTY)
from bagdar.planner.inputs import build_input  # noqa: E402
from bagdar.planner.service import Planner  # noqa: E402
from bagdar.sim.engine import Engine  # noqa: E402

cfg = load_config()
rows = []


def _n(x: float) -> str:
    return f"{x:,.0f}".replace(",", " ")


for seed in (42, 7, 1):
    world, tt = build(seed, cfg)
    eng = Engine(world, tt.trains, tt.plan, cfg, seed, START)
    rnd = random.Random(seed)
    prev = tt.plan
    for step in range(3):
        eng.advance(1200)
        st = [rt for rt in eng.active() if rt.status == "station" and rt.k < len(rt.train.route) - 1]
        delayed = rnd.choice(st)
        eng.inject_delay(delayed.train.id, 900, "замер")
        t = time.perf_counter()
        inp = build_input(eng, cfg, prev, "замер")
        input_ms = (time.perf_counter() - t) * 1000
        res = Planner().solve(inp, step + 1)
        eng.apply_plan(res.plan)
        prev = res.plan
        heur = min(c.cost.lex for c in res.candidates if c.name != "cpsat" and c.valid)
        rows.append({
            "seed": seed, "t": f"{int(eng.t // 3600):02d}:{int(eng.t % 3600 // 60):02d}",
            "active": len(eng.active()), "in_horizon": res.cp.trains, "legs": res.cp.legs,
            "order_vars": res.cp.order_vars, "input_ms": input_ms, "greedy_ms": res.timings["greedy_ms"],
            "cpsat_ms": res.timings["cpsat_ms"], "total_ms": res.timings["total_ms"], "cp": res.cp.status,
            "solver": res.solver, "J_heur": heur, "J": res.cost.lex if res.cost else float("nan"),
            "stuck": len(res.cost.stuck) if res.cost else 0,
            "stuck_heur": min(len(c.cost.stuck) for c in res.candidates if c.name != "cpsat" and c.valid),
        })
        print(rows[-1])

lines = ["# Замер времени пересчёта плана", "",
         f"Лимит CP-SAT: {cfg.solver.time_limit_s} с, потоков: {cfg.planner.workers}, горизонт "
         f"{cfg.solver.horizon_min:g} мин. Каждый замер — после внешней задержки поезда на 15 мин.", "",
         "| seed | время | на участке | в горизонте | плеч | переменных порядка | снимок, мс | эвристика, мс | CP-SAT, мс | всего, мс | CP-SAT | выбран | J эвристики | J плана | застряло в плане |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
for r in rows:
    lines.append(f"| {r['seed']} | {r['t']} | {r['active']} | {r['in_horizon']} | {r['legs']} | {r['order_vars']} | "
                 f"{r['input_ms']:.0f} | {r['greedy_ms']:.0f} | {r['cpsat_ms']:.0f} | {r['total_ms']:.0f} | {r['cp']} | "
                 f"{r['solver']} | {r['J_heur']:.0f} | {r['J']:.0f} | {r['stuck']} |")
gain = [1 - r["J"] / r["J_heur"] for r in rows if r["J_heur"] > 0]
lines += ["", f"Медиана времени пересчёта: {statistics.median(r['total_ms'] for r in rows):.0f} мс, "
          f"эвристика: {statistics.median(r['greedy_ms'] for r in rows):.0f} мс. "
          f"Выигрыш плана над лучшей эвристикой по J (с учётом слоёв 1–2): медиана {statistics.median(gain) * 100:.0f} %.",
          "", f"J — условные у.е., включает лексикографические штрафы: внеочередной не первым "
          f"({_n(EXTRA_PENALTY)}), застрявший поезд ({_n(STUCK_PENALTY)}), превышение ПТЭ "
          f"({_n(PTE_PENALTY_PER_MIN)} за минуту). «Застряло» — поезда, которых план бросил посреди горизонта: "
          f"маршрут продолжается, перегон открыт, до конца горизонта больше {STUCK_MARGIN_S / 3600:.0f} ч "
          f"(в том числе готовый к отправлению поезд, которого план не отправляет вовсе)."]
out = ROOT.parent / "docs" / "BENCHMARK.md"
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"→ {out}")
