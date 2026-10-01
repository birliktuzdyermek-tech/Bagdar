"""Категории поездов по ПТЭ и их тяговые характеристики (условные)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TrainClass:
    key: str
    label: str
    pte_rank: int      # 0 — внеочередной, 1..5 — очерёдность по ПТЭ
    vmax_kmh: float
    accel: float       # м/с², разгон на площадке
    decel: float       # м/с², служебное торможение
    freight: bool


TRAIN_CLASSES: dict[str, TrainClass] = {
    c.key: c
    for c in [
        TrainClass("extraordinary", "Внеочередной", 0, 100, 0.35, 0.50, False),
        TrainClass("high_speed_passenger", "Скоростной пассажирский", 1, 160, 0.45, 0.60, False),
        TrainClass("fast_passenger", "Скорый пассажирский", 2, 120, 0.35, 0.50, False),
        TrainClass("passenger", "Пассажирский", 3, 100, 0.35, 0.50, False),
        TrainClass("express_freight", "Ускоренный грузовой", 4, 90, 0.15, 0.35, True),
        TrainClass("freight", "Грузовой", 5, 80, 0.10, 0.30, True),
        TrainClass("local_freight", "Сборный грузовой", 5, 70, 0.12, 0.30, True),
        TrainClass("light_engine", "Локомотив резервом", 5, 100, 0.40, 0.50, False),
    ]
}
