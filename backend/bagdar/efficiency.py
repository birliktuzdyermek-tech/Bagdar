"""Индекс эффективности участка (раздел 10 docs/BAGDAR.md).

Одно число от 0 до 100: Индекс = 100 × Σ вес_k × s_k / Σ вес_k, где s_k от 0 до 1.
Веса и пороги берутся из конфига (index.*), поэтому меняются без пересборки.

Расчёт не хранит состояния: всё берётся из движка и журнала событий на текущий
момент модели. Поэтому индекс можно запросить в любой момент, и он не влияет
на ход симуляции.

Как считается каждый фактор в прототипе:
- throughput — из поездов, которые по плану уже должны были дойти до конечной
  (после начала прогона), доля дошедших;
- punctuality — max(0, 1 − средняя задержка / punctuality_max_delay_min);
- track_load — занятые и закреплённые станционные пути; до 80 % s = 1,
  дальше линейно до 0 при 100 %;
- resource_idle — 1 − доля поездов на участке, которые сейчас ждут
  (стоят не по графику: локомотив и бригада простаивают);
- conflicts — ожидания ресурса дольше 2 мин (события train_held) за последний
  час модели; max(0, 1 − число / conflicts_max).
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from bagdar.config import BagdarConfig
from bagdar.sim.engine import Engine
from bagdar.sim.events import SimEvent

CONFLICT_WINDOW_S = 3600.0
TRACK_LOAD_KNEE = 0.8

LABELS = {
    "throughput": "Пропускная способность",
    "punctuality": "Отклонение от графика",
    "track_load": "Загрузка путей",
    "resource_idle": "Простой ресурсов",
    "conflicts": "Конфликты маршрутов",
}

Level = Literal["normal", "warning", "critical"]


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _throughput(eng: Engine) -> tuple[float, str, dict]:
    now, start = eng.t, eng.start_time
    planned = done = 0
    for tid, legs in eng.ex.plan.legs.items():
        if not legs:
            continue
        arr = legs[-1].arr
        if not (start < arr <= now):
            continue
        planned += 1
        rt = eng.rt[tid]
        arrived = rt.status == "finished" or (rt.status == "station" and rt.k == len(rt.train.route) - 1)
        done += arrived
    score = done / planned if planned else 1.0
    detail = f"дошли {done} из {planned} по плану" if planned else "по плану ещё никто не должен был дойти"
    return _clamp(score), detail, {"done": done, "planned": planned}


def _punctuality(eng: Engine, cfg: BagdarConfig, avg_delay_s: float) -> tuple[float, str, dict]:
    limit_s = cfg.index.punctuality_max_delay_min * 60.0
    score = 1.0 - avg_delay_s / limit_s if limit_s > 0 else 1.0
    detail = f"средняя задержка {avg_delay_s / 60:.1f} мин (ноль баллов при {cfg.index.punctuality_max_delay_min:g} мин)"
    return _clamp(score), detail, {"avg_delay_s": round(avg_delay_s, 1), "limit_s": limit_s}


def _track_load(eng: Engine) -> tuple[float, str, dict]:
    tracks = [t for t in eng.il.tracks.values() if t.available]
    busy = sum(1 for t in tracks if t.occupant is not None or t.reserved is not None)
    load = busy / len(tracks) if tracks else 0.0
    score = 1.0 if load <= TRACK_LOAD_KNEE else (1.0 - load) / (1.0 - TRACK_LOAD_KNEE)
    detail = f"занято или закреплено {busy} из {len(tracks)} путей ({load:.0%})"
    return _clamp(score), detail, {"busy": busy, "total": len(tracks), "load": round(load, 3)}


def _resource_idle(eng: Engine) -> tuple[float, str, dict]:
    act = eng.active()
    waiting = sum(1 for rt in act if rt.wait_reason)
    share = waiting / len(act) if act else 0.0
    detail = f"ждут {waiting} из {len(act)} поездов на участке"
    return _clamp(1.0 - share), detail, {"waiting": waiting, "active": len(act)}


def _conflicts(eng: Engine, cfg: BagdarConfig, events: Iterable[SimEvent]) -> tuple[float, str, dict]:
    since = eng.t - CONFLICT_WINDOW_S
    n = sum(1 for e in events if e.kind == "train_held" and e.t >= since)
    cap = cfg.index.conflicts_max
    score = 1.0 - n / cap if cap > 0 else 1.0
    detail = f"{n} ожиданий ресурса дольше 2 мин за последний час (ноль баллов при {cap:g})"
    return _clamp(score), detail, {"count": n, "window_s": CONFLICT_WINDOW_S}


def level_for(value: float, cfg: BagdarConfig) -> Level:
    th = cfg.index.thresholds
    if value >= th.normal:
        return "normal"
    if value >= th.warning:
        return "warning"
    return "critical"


def compute_index(eng: Engine, cfg: BagdarConfig, events: Iterable[SimEvent]) -> dict:
    """Индекс эффективности на текущий момент модели (контракт: schemas.IndexOut)."""
    metrics = eng.metrics()
    raw = {
        "throughput": _throughput(eng),
        "punctuality": _punctuality(eng, cfg, metrics["avg_delay_s"]),
        "track_load": _track_load(eng),
        "resource_idle": _resource_idle(eng),
        "conflicts": _conflicts(eng, cfg, events),
    }
    weights = cfg.index.weights.model_dump()
    total_w = sum(weights[k] for k in raw) or 1.0
    factors = []
    for key, (score, detail, data) in raw.items():
        w = weights[key] / total_w
        factors.append({
            "key": key, "label": LABELS[key], "score": round(score, 3), "weight": round(w, 4),
            "points": round(100 * w * score, 1), "loss": round(100 * w * (1 - score), 1),
            "detail": detail, "data": data,
        })
    value = round(sum(100 * f["weight"] * f["score"] for f in factors), 1)
    drag = [f["key"] for f in sorted(factors, key=lambda f: -f["loss"]) if f["loss"] >= 0.5][:2]
    return {"t": round(eng.t, 1), "value": value, "level": level_for(value, cfg),
            "thresholds": cfg.index.thresholds.model_dump(), "factors": factors, "drag": drag}
