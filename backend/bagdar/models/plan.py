"""План движения: для каждого поезда — плечи «станция → перегон → станция»
с временами, путём приёма и признаком остановки. Исходный график —
это план версии 0."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

PlanStatus = Literal["feasible", "delayed", "infeasible"]


@dataclass(slots=True)
class PlanLeg:
    train_id: str
    k: int                 # индекс плеча в маршруте поезда
    section_id: str
    from_id: str
    to_id: str
    direction: int
    dep: float             # вход на перегон (отправление или проход)
    arr: float             # прибытие или проход станции to_id
    track_id: str          # путь приёма на станции to_id
    stop: bool             # останавливается ли поезд на to_id


@dataclass
class Plan:
    version: int
    created_at: float
    solver: str
    status: PlanStatus
    legs: dict[str, list[PlanLeg]]
    origin_track: dict[str, str]
    compute_ms: float = 0.0
    cost: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def leg(self, train_id: str, k: int) -> PlanLeg | None:
        legs = self.legs.get(train_id)
        if not legs:
            return None
        # плечи хранятся по возрастанию k, но список может начинаться не с 0
        first = legs[0].k
        i = k - first
        if 0 <= i < len(legs) and legs[i].k == k:
            return legs[i]
        return None

    def all_legs(self) -> list[PlanLeg]:
        return [leg for legs in self.legs.values() for leg in legs]
