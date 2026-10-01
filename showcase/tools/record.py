"""Запись настоящего прогона Ядра в формате replay (контракт v1) для Витрины.

Витрина не считает планы и не рисует «как будто»: этот скрипт запускает
SimulationRuntime Ядра с планировщиком, делает реальные шаги Engine и
сохраняет кадры, планы и события. Результат проверяется моделью Replay
из contracts/export.py, затем сжимается в showcase/public/runs/<id>.replay.json.gz
и добавляется строкой в showcase/public/runs/index.json.

Пример (из корня репозитория, зависимости backend/requirements.txt):
    python showcase/tools/record.py --id normal-42 --seed 42 --hours 3
    python showcase/tools/record.py --id butterfly-42 --seed 42 --hours 3 \
        --delay 07:00 t2001 15 "отказ тормозов"   # внешняя команда, как POST /api/events
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "contracts"))

from bagdar.config import load_config, parse_hhmm  # noqa: E402
from bagdar.dto import plan_dto  # noqa: E402
from bagdar.runtime import SimulationRuntime  # noqa: E402
from bagdar.scenarios import load_scenarios  # noqa: E402
from bagdar.versus import empty_plan, remember_positions, score_runtime  # noqa: E402
from export import Replay, index_snapshot  # noqa: E402  контрактная модель из пакета contracts/

RUNS = ROOT / "showcase" / "public" / "runs"


def hhmm(t: float) -> str:
    t = int(t) % 86400
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}"


def record(args: argparse.Namespace) -> dict:
    cfg = load_config()
    if args.no_plan:
        cfg.planner.enabled = False            # тот же поток без Бағдара: «кто первый пришёл»
    rt = SimulationRuntime(cfg, load_scenarios(), planner_sync=True)
    rt.load(args.scenario, args.seed)
    eng = rt.engine
    if args.no_plan:
        eng.apply_plan(empty_plan(eng.t))
    cache: dict = {}
    assert eng is not None and rt.scenario is not None and rt.plan is not None
    assert rt.generation["validated"], "исходный график не прошёл валидатор Ядра"

    delays = sorted(((parse_hhmm(d[0]), d[1], float(d[2]), d[3]) for d in args.delay), key=lambda d: d[0])
    for _, tid, _, _ in delays:
        if tid not in eng.trains:
            raise SystemExit(f"Нет поезда {tid} в мире seed {args.seed}")

    frames = [{"t": eng.t, "state": rt.state_payload(), "index": index_snapshot(rt.index.current)}]
    plans = [{"t": eng.t, "plan": plan_dto(rt.planner.current or rt.plan)}]
    events = rt.events_since(0)
    plan_version = plans[0]["plan"]["version"]
    end = eng.t + args.hours * 3600
    step = round(args.frame / eng.dt)
    t0 = time.perf_counter()
    while eng.t < end - 1e-6:
        # внешние команды применяются в свой момент модели, как кнопка или POST /api/events
        while delays and delays[0][0] <= eng.t:
            _, tid, minutes, reason = delays.pop(0)
            print(f"  {hhmm(eng.t)} внешняя задержка {tid} на {minutes:g} мин: "
                  f"{rt.external_event('train_delay', {'train_id': tid, 'minutes': minutes, 'reason': reason})}")
        rt._advance_steps(step)
        rt.planner.tick()
        rt._flush_events()
        cur = rt.planner.current
        if cur is not None and cur.version != plan_version:
            plan_version = cur.version
            plans.append({"t": eng.t, "plan": plan_dto(cur)})
        frames.append({"t": eng.t, "state": rt.state_payload(), "index": index_snapshot(rt.index.current)})
        remember_positions(cache, eng)
        events.extend(rt.events_since(events[-1]["seq"] if events else 0))
    replay = {
        "schema_version": 1,
        "world": rt.world_payload(),
        "scenario": rt.scenario.model_dump(mode="json"),
        "run_id": rt.run_id,
        "started_at": frames[0]["t"],
        "ended_at": frames[-1]["t"],
        "frame_interval_s": args.frame,
        "plans": plans,
        "frames": frames,
        "events": events,
        "variant": "no_plan" if args.no_plan else "bagdar",
        "pair": args.pair,
        "cards": [c for c in rt.planner.cards],
        "incidents": rt.incidents.payload(),
        "summary": score_runtime(rt, rt.cfg.tariffs, cache),
    }
    Replay.model_validate(replay)
    print(f"  {len(frames)} кадров, {len(plans)} планов, {len(events)} событий, "
          f"{time.perf_counter() - t0:.0f} с счёта")
    return replay


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True, help="имя записи: латиница, цифры, дефис")
    ap.add_argument("--scenario", default="normal")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--hours", type=float, default=3.0)
    ap.add_argument("--frame", type=float, default=20.0, help="шаг кадров, секунды модели")
    ap.add_argument("--delay", nargs=4, action="append", default=[], metavar=("ЧЧ:ММ", "TRAIN", "MIN", "REASON"))
    ap.add_argument("--title", default=None, help="подпись в витрине")
    ap.add_argument("--situation", type=int, default=None, help="номер ситуации 1–17 из BAGDAR_PLAN.md")
    ap.add_argument("--no-plan", action="store_true", help="тот же поток без Бағдара (пустой план, «кто первый пришёл»)")
    ap.add_argument("--pair", default=None, help="id парной записи того же потока (с Бағдаром / без)")
    args = ap.parse_args()

    print(f"Запись {args.id}: сценарий {args.scenario}, seed {args.seed}, {args.hours:g} ч")
    replay = record(args)
    RUNS.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(replay, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path = RUNS / f"{args.id}.replay.json.gz"
    path.write_bytes(gzip.compress(blob, compresslevel=9, mtime=0))
    print(f"  {path.relative_to(ROOT)}: {len(blob) / 1e6:.1f} МБ → {path.stat().st_size / 1e6:.2f} МБ gzip")

    index_path = RUNS / "index.json"
    runs = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    runs = [r for r in runs if r["id"] != args.id]
    sc = replay["scenario"]
    runs.append({
        "id": args.id,
        "file": path.name,
        "title": args.title or sc["title"],
        "situation": args.situation,
        "scenario_id": sc["id"],
        "seed": replay["world"]["seed"],
        "mode": replay["world"]["mode"],
        "from": hhmm(replay["started_at"]),
        "to": hhmm(replay["ended_at"]),
        "injected": [{"at": d[0], "train_id": d[1], "minutes": float(d[2]), "reason": d[3]} for d in args.delay],
        "variant": replay["variant"],
        "pair": args.pair,
        "summary": {k: replay["summary"][k] for k in ("money_total", "delay_min", "frozen", "passages", "index",
                                                      "energy_kwh", "idle_h", "late_trains")},
        "cards": len(replay["cards"]),
        "incidents": [i["title"] for i in replay["incidents"]],
        "recorded_with": "showcase/tools/record.py, SimulationRuntime(planner_sync=True)",
    })
    index_path.write_text(json.dumps(runs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
