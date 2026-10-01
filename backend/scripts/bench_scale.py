"""Замер пересчёта плана на 20, 100 и 1 000 поездов. Результат — docs/BENCHMARK_SCALE.md.

Иерархия как в BAGDAR_PLAN, раздел 3: каждая зона из 20 станций планируется своим
диспетчером, зоны — параллельно. В 07:00 в зоне около 18 поездов: 1 зона ≈ 20 поездов,
6 зон ≈ 100, 55 зон ≈ 1 000.
Зоны независимы (разные seed): передача поездов между зонами по слотам в этом замере
не моделируется. Для каждой зоны: состояние через 60 мин модели, задержка одного
поезда на 15 мин, пересчёт. Подготовка мира в замер времени не входит.

Запуск: python3 scripts/bench_scale.py [--zones 1 6 55] [--workers N]
"""
from __future__ import annotations

import argparse
import os
import random
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def plan_zone(args: tuple[int, str, float]) -> dict:
    """Построить зону по seed, довести до 07:00, задержать поезд и пересчитать. Возвращает замер."""
    seed, solver, limit = args
    from bagdar.config import load_config, parse_hhmm
    from bagdar.core.rules import TimingRules
    from bagdar.generator.timetable import TimetableBuilder
    from bagdar.generator.trains_gen import generate_traffic
    from bagdar.generator.world_gen import generate_world
    from bagdar.planner.forward import run_greedy
    from bagdar.planner.inputs import build_input
    from bagdar.planner.service import Planner, blocked_of
    from bagdar.sim.engine import Engine
    from bagdar.validator import validate_plan

    cfg = load_config()
    cfg.solver.time_limit_s = limit
    cfg.planner.workers = 1                     # зоны и так параллельны — по одному потоку на зону
    world = generate_world("light", seed)
    rules = TimingRules.from_config(cfg.sim)
    tt = TimetableBuilder(world, rules).build(generate_traffic(world, seed))
    eng = Engine(world, tt.trains, tt.plan, cfg, seed, parse_hhmm("06:00"))
    eng.advance(3600)
    st = [r for r in eng.active() if r.status == "station" and r.k < len(r.train.route) - 1]
    if st:
        eng.inject_delay(random.Random(seed).choice(st).train.id, 900, "замер")
    active = len(eng.active())
    t = time.perf_counter()
    inp = build_input(eng, cfg, tt.plan, "замер")
    if solver == "cpsat":
        res = Planner().solve(inp, 1)
        plan, name = res.plan, res.solver
    else:
        plan, name = run_greedy(inp).plan, "greedy"
    ms = (time.perf_counter() - t) * 1000
    trains = {tid: ti.train for tid, ti in inp.trains.items()}
    viol = validate_plan(world, trains, plan, rules, blocked=blocked_of(inp), since=inp.t0, pab=inp.pab)
    return {"seed": seed, "active": active, "in_horizon": len(inp.trains), "ms": ms, "solver": name,
            "valid": not viol}


def run(zones: int, solver: str, workers: int, limit: float) -> dict:
    seeds = [1000 + z for z in range(zones)]
    t = time.perf_counter()
    with ProcessPoolExecutor(max_workers=min(workers, zones)) as ex:
        rows = list(ex.map(plan_zone, [(s, solver, limit) for s in seeds]))
    wall = time.perf_counter() - t
    ms = [r["ms"] for r in rows]
    trains = sum(r["active"] for r in rows)
    par = min(workers, zones)
    return {"zones": zones, "solver": solver, "trains": trains, "pairs": trains * (trains - 1) // 2,
            "zone_median_ms": statistics.median(ms), "zone_max_ms": max(ms), "wall_s": wall,
            "replan_s": max(max(ms), sum(ms) / par) / 1000, "workers": par,
            "valid": all(r["valid"] for r in rows), "solvers": sorted({r["solver"] for r in rows})}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zones", type=int, nargs="+", default=[1, 6, 55])
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--limit", type=float, default=1.5, help="лимит CP-SAT на зону, с")
    args = ap.parse_args()
    out = []
    for z in args.zones:
        for solver in (["cpsat", "greedy"] if z <= 6 else ["greedy"]):
            r = run(z, solver, args.workers, args.limit)
            print(r, flush=True)
            out.append(r)
    lines = ["# Замер на 20, 100 и 1 000 поездов", "",
             f"`python3 scripts/bench_scale.py` — {os.cpu_count()} ядер, процессов: {args.workers}. "
             "Каждая зона (20 станций) планируется своим диспетчером, зоны параллельно. Время зоны — "
             "снимок состояния + план + (у CP-SAT) проверка и карточки. «Пересчёт всех зон» — сколько "
             "занимает пересчёт всех зон на этих процессах (сумма времени зон / число процессов, не меньше "
             "самой долгой зоны). «Прогон замера целиком» — вместе с построением мира и часом симуляции "
             "в каждой зоне, это не время пересчёта.", "",
             "| Зон | Поездов на участках | Пар поездов | Планировщик | Зона, медиана | Зона, макс. | Пересчёт всех зон | Прогон замера целиком | Планы допустимы |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in out:
        lines.append(f"| {r['zones']} | {r['trains']} | {r['pairs']:,} | {r['solver']} (выбран: {'/'.join(r['solvers'])}) | "
                     f"{r['zone_median_ms']:.0f} мс | {r['zone_max_ms']:.0f} мс | {r['replan_s']:.1f} с на {r['workers']} проц. | "
                     f"{r['wall_s']:.1f} с | "
                     f"{'да' if r['valid'] else 'НЕТ'} |".replace(",", " "))
    lines += ["", "Зоны в этом замере независимы: передача поездов между зонами по слотам и супердиспетчер "
              "не моделируются. Ультра-режим — стресс-тест с нагрузкой выше реальной."]
    path = ROOT.parent / "docs" / "BENCHMARK_SCALE.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"→ {path}")


if __name__ == "__main__":
    main()
