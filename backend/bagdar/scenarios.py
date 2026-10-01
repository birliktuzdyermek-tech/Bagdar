"""Сценарии как данные: YAML-файлы в каталоге scenarios/."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from bagdar.config import BACKEND_DIR

SCENARIOS_DIR = Path(os.environ.get("BAGDAR_SCENARIOS", BACKEND_DIR / "scenarios"))


class Disruption(BaseModel):
    at: str                       # "HH:MM" времени симуляции
    type: str
    params: dict[str, Any] = Field(default_factory=dict)


class Scenario(BaseModel):
    id: str
    title: str
    summary: str = ""
    mode: str = "light"
    seed: int = 42
    start_time: str = "06:00"
    difficulty: int = 1
    wave: int = 0
    situation: int | None = None   # номер ситуации из BAGDAR_PLAN.md, раздел 4
    plain: str = ""                # «что вы увидите» простыми словами — для страницы сценариев
    world: dict[str, Any] = Field(default_factory=dict)
    traffic: dict[str, Any] = Field(default_factory=dict)
    disruptions: list[Disruption] = Field(default_factory=list)


def load_scenarios(directory: Path | None = None) -> dict[str, Scenario]:
    d = directory or SCENARIOS_DIR
    out: dict[str, Scenario] = {}
    for p in sorted(d.glob("*.yaml")):
        with open(p, encoding="utf-8") as fh:
            sc = Scenario.model_validate(yaml.safe_load(fh))
        out[sc.id] = sc
    return out
