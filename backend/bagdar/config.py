"""Конфигурация: веса, пороги, параметры симулятора.

Загружается из YAML (путь в BAGDAR_CONFIG или config/default.yaml),
валидируется pydantic-моделями и может меняться на лету через API.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = BACKEND_DIR / "config" / "default.yaml"


class IndexWeights(BaseModel):
    throughput: float = 0.30
    punctuality: float = 0.25
    track_load: float = 0.20
    resource_idle: float = 0.15
    conflicts: float = 0.10


class IndexThresholds(BaseModel):
    normal: float = 75
    warning: float = 50


class IndexConfig(BaseModel):
    weights: IndexWeights = IndexWeights()
    thresholds: IndexThresholds = IndexThresholds()
    punctuality_max_delay_min: float = 30
    conflicts_max: float = 10


class PriorityEntry(BaseModel):
    weight: float
    tolerance_min: float


def _default_priority() -> dict[str, PriorityEntry]:
    raw = {
        "extraordinary": (1000, 0),
        "high_speed_passenger": (100, 2),
        "fast_passenger": (70, 3),
        "passenger": (50, 5),
        "express_freight": (30, 15),
        "freight": (10, 30),
        "local_freight": (5, 60),
        "light_engine": (3, 60),
    }
    return {k: PriorityEntry(weight=w, tolerance_min=t) for k, (w, t) in raw.items()}


class CostConfig(BaseModel):
    c_stop: float = 0.5
    c_energy: float = 0.1
    c_idle: float = 2
    c_change: float = 15


class SolverConfig(BaseModel):
    horizon_min: float = 180
    freeze_min: float = 5
    time_limit_s: float = 2
    fallback: Literal["greedy"] = "greedy"


class SimConfig(BaseModel):
    dt_s: float = Field(1.0, gt=0, le=10)
    start_time: str = "06:00"
    tau_cross_s: float = 90
    headway_s: float = 300
    headway_arr_s: float = 180
    throat_s: float = 90
    approach_s: float = 90
    clear_s: float = 60
    prep_s: float = 600
    terminate_s: float = 600
    min_stop_s: float = 30
    recovery_margin: float = 0.07
    max_wait_s: float = 3600
    dwell_jitter_prob: float = 0.25
    dwell_jitter_max_s: float = 90
    origin_delay_prob: float = 0.12
    origin_delay_max_s: float = 300
    broadcast_hz: float = 10


class BagdarConfig(BaseModel):
    mode: Literal["mainline", "lrt"] = "mainline"
    pte_strict: bool = True
    index: IndexConfig = IndexConfig()
    priority: dict[str, PriorityEntry] = Field(default_factory=_default_priority)
    cost: CostConfig = CostConfig()
    solver: SolverConfig = SolverConfig()
    sim: SimConfig = SimConfig()

    def tolerance_s(self, train_class: str) -> float:
        entry = self.priority.get(train_class)
        return (entry.tolerance_min if entry else 30) * 60.0

    def weight(self, train_class: str) -> float:
        entry = self.priority.get(train_class)
        return entry.weight if entry else 10.0


def config_path() -> Path:
    return Path(os.environ.get("BAGDAR_CONFIG", DEFAULT_CONFIG_PATH))


def load_config(path: Path | None = None) -> BagdarConfig:
    p = path or config_path()
    with open(p, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return BagdarConfig.model_validate(data)


def parse_hhmm(value: str) -> float:
    """'06:30' -> секунды от начала суток."""
    parts = [int(x) for x in value.split(":")]
    while len(parts) < 3:
        parts.append(0)
    h, m, s = parts[:3]
    return float(h * 3600 + m * 60 + s)
