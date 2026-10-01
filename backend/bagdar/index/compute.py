"""Формула индекса: пять факторов, каждый s_k от 0 до 1.

    Индекс = 100 × Σ w_k · s_k / Σ w_k      (сумма по факторам, для которых есть данные)

| Фактор                 | s_k                                                        |
|------------------------|------------------------------------------------------------|
| Пропускная способность | min(1, пропущено / запланировано) за скользящее окно       |
| Отклонение от графика  | max(0, 1 − средняя задержка / punctuality_max_delay_min)   |
| Загрузка путей         | 1 до 80 %, дальше линейно до 0 при 100 %                   |
| Простой ресурсов       | 1 − доля времени простоя локомотивов и бригад              |
| Конфликты маршрутов    | max(0, 1 − конфликтов / conflicts_max)                     |

Нет данных (поездов нет, окно ещё не набралось, по графику в окне ничего
не планировалось) — фактор помечается «нет данных» и не участвует в
сумме, веса остальных перенормируются. Это видно в интерфейсе. Если данных
нет ни по одному фактору, индекс не выдумывается: значение None.
Веса и пороги — из конфига, сумма весов не обязана быть 1.
"""
from __future__ import annotations

import math

from bagdar.config import IndexConfig

FACTORS: dict[str, str] = {
    "throughput": "Пропускная способность",
    "punctuality": "Отклонение от графика",
    "track_load": "Загрузка путей",
    "resource_idle": "Простой локомотивов и бригад",
    "conflicts": "Конфликты маршрутов",
}
STATUS_LABEL = {"norm": "Норма", "warning": "Внимание", "critical": "Критично", "no_data": "Нет данных"}
LOAD_KNEE = 0.8


def _num(x: float, nd: int = 1) -> str:
    s = f"{x:.{nd}f}".replace(".", ",")
    return s[:-2] if s.endswith(",0") else s


def _clamp01(x: float) -> float:
    if x is None or math.isnan(x):
        return 0.0
    return min(1.0, max(0.0, x))


def _factor_score(key: str, raw: dict, cfg: IndexConfig) -> tuple[float | None, str, str]:
    """(s_k или None, значение текстом, пояснение/причина)."""
    if raw.get("missing"):
        return None, "нет данных", raw["missing"]
    if key == "throughput":
        passed, planned = raw["passed"], raw["planned"]
        if planned <= 0:
            return None, "нет данных", "по графику в окне нет проследований"
        s = min(1.0, passed / planned)
        return s, f"{passed} из {planned} за {round(raw['window_min'])} мин", \
            f"пропущено {passed} из {planned} плановых проследований станций за {round(raw['window_min'])} мин"
    if key == "punctuality":
        avg_min = raw["avg_delay_s"] / 60
        s = max(0.0, 1.0 - avg_min / max(1e-6, cfg.punctuality_max_delay_min))
        worst = ", ".join(f"{n} (+{round(d / 60)} мин)" for n, d in raw.get("worst", []) if d >= 60)
        txt = f"средняя задержка {_num(avg_min)} мин"
        return s, txt, txt + (f"; больше всех: {worst}" if worst else "")
    if key == "track_load":
        sh = raw["share"]
        s = 1.0 if sh <= LOAD_KNEE else max(0.0, (1.0 - sh) / (1.0 - LOAD_KNEE))
        busiest = ", ".join(raw.get("busiest", []))
        txt = f"занято {round(sh * 100)} % путей"
        note = txt + (" — свыше 80 % теряется запас для приёма" if sh > LOAD_KNEE else "")
        return s, txt, note + (f"; плотнее всего: {busiest}" if busiest and sh > 0.6 else "")
    if key == "resource_idle":
        sh = raw["share"]
        top = ", ".join(f"{n} ({round(d / 60)} мин)" for n, d in raw.get("top", []) if d >= 60)
        txt = f"простой {round(sh * 100)} % времени"
        return 1.0 - _clamp01(sh), txt, \
            f"{txt} за {round(raw.get('window_min', 30))} мин" + (f"; дольше всех стоят: {top}" if top else "")
    if key == "conflicts":
        n = raw["count"]
        s = max(0.0, 1.0 - n / max(1e-6, cfg.conflicts_max))
        parts = []
        if raw.get("projected"):
            parts.append(f"прогноз {raw['projected']}")
        if raw.get("now"):
            parts.append(f"сейчас {raw['now']}")
        txt = f"{n} конфл." + (f" ({', '.join(parts)})" if parts else "")
        first = raw.get("first")
        return s, txt, txt + (f": {first}" if first else "")
    raise KeyError(key)


def score(cfg: IndexConfig, raw: dict[str, dict], t: float | None = None) -> dict:
    weights = cfg.weights.model_dump()
    factors = []
    for key, label in FACTORS.items():
        w = max(0.0, float(weights.get(key, 0.0)))
        s, txt, note = _factor_score(key, raw.get(key, {"missing": "нет данных"}), cfg)
        factors.append({"key": key, "label": label, "weight": w, "score": None if s is None else _clamp01(s),
                        "available": s is not None, "value_text": txt, "note": note})
    wsum = sum(f["weight"] for f in factors if f["available"])
    if wsum <= 0:
        value = None
    else:
        value = 100.0 * sum(f["weight"] * f["score"] for f in factors if f["available"]) / wsum
        value = min(100.0, max(0.0, value))
    for f in factors:
        f["weight_eff"] = round(f["weight"] / wsum, 4) if (f["available"] and wsum > 0) else 0.0
        f["lost"] = round(100.0 * f["weight_eff"] * (1.0 - f["score"]), 1) if f["available"] else 0.0
        if f["score"] is not None:
            f["score"] = round(f["score"], 3)
    th = cfg.thresholds
    # статус — по тому же целому числу, что видит диспетчер (74,6 на экране «75» — это уже «Норма»)
    shown = None if value is None else math.floor(value + 0.5)
    if shown is None:
        status = "no_data"
    elif shown >= th.normal:
        status = "norm"
    elif shown >= th.warning:
        status = "warning"
    else:
        status = "critical"
    worst = sorted((f for f in factors if f["available"] and f["lost"] >= 0.5), key=lambda f: -f["lost"])
    reasons = [f"{f['label']}: {f['note']} (−{_num(f['lost'])} п.)" for f in worst[:3]]
    return {
        "t": None if t is None else round(t, 1),
        "value": None if value is None else round(value, 1),
        "status": status, "status_label": STATUS_LABEL[status],
        "factors": factors, "reasons": reasons,
        "missing": [f["label"] for f in factors if not f["available"]],
    }


# ------------------------------------------------------------------ прогноз по плану
def forecast_raw(world, trains: dict, plan, rules, t0: float, window_s: float = 3600,
                 conflicts: int = 0) -> dict[str, dict]:
    """Те же пять факторов, но посчитанные по будущему плана на window_s вперёд."""
    from bagdar.planner.occupancy import plan_occupancy, track_load_share

    t1 = t0 + window_s
    planned = 0
    for tr in trains.values():
        for sp in tr.schedule[1:]:
            if sp.arr is not None and t0 <= sp.arr < t1:
                planned += 1
    passed = 0
    lates: list[float] = []
    active = 0.0
    idle = 0.0
    for tid, legs in plan.legs.items():
        tr = trains.get(tid)
        if tr is None or not legs:
            continue
        for i, lg in enumerate(legs):
            if t0 <= lg.arr < t1:
                passed += 1
                sa = tr.schedule[lg.k + 1].arr if lg.k + 1 < len(tr.schedule) else None
                if sa is not None:
                    lates.append(max(0.0, lg.arr - sa))
            if i + 1 < len(legs):
                nxt = legs[i + 1]
                sp = tr.schedule[lg.k + 1]
                need = sp.dwell_s if sp.stop else 0.0
                a, b = max(t0, lg.arr + need), min(t1, nxt.dep)
                if b > a:
                    idle += b - a
        a, b = max(t0, legs[0].dep), min(t1, legs[-1].arr)
        if b > a:
            active += b - a
    busy = plan_occupancy(world, trains, plan, rules)
    samples = [t0 + i * 300 for i in range(int(window_s // 300) + 1)]
    load = sum(track_load_share(world, busy, t) for t in samples) / len(samples)
    raw: dict[str, dict] = {
        "throughput": {"passed": passed, "planned": planned, "window_min": window_s / 60},
        "punctuality": ({"avg_delay_s": sum(lates) / len(lates)} if lates
                        else {"missing": "в плане на час вперёд нет прибытий"}),
        "track_load": {"share": load},
        "resource_idle": ({"share": idle / active, "window_min": window_s / 60} if active > 0
                          else {"missing": "в плане на час вперёд нет движения"}),
        "conflicts": {"count": conflicts, "projected": conflicts},
    }
    return raw


def forecast_index(cfg: IndexConfig, world, trains: dict, plan, rules, t0: float, window_s: float = 3600,
                   conflicts: int = 0) -> dict:
    return score(cfg, forecast_raw(world, trains, plan, rules, t0, window_s, conflicts), t0 + window_s)
