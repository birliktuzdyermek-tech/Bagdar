"""Поезд: статические характеристики и исходное расписание."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class ScheduleStop:
    station_id: str
    arr: float | None        # None на станции отправления
    dep: float | None        # None на конечной
    stop: bool               # плановая остановка (коммерческая или техническая)
    dwell_s: float           # минимальная стоянка
    track_id: str


@dataclass(slots=True)
class Train:
    id: str
    number: str
    cls: str                 # ключ из TRAIN_CLASSES
    pte_rank: int
    direction: int           # +1 нечётное, −1 чётное
    length_m: int
    mass_t: int
    passengers: int
    cargo: list[str]         # perishable | urgent | deadline | dangerous
    traction: str            # electric | diesel
    vmax_kmh: float
    accel: float
    decel: float
    loco_id: str
    crew_id: str
    crew_shift_end: float    # время окончания рабочего времени бригады, с
    route: list[str]         # станции по порядку
    sections: list[str]      # перегоны по порядку
    schedule: list[ScheduleStop] = field(default_factory=list)
    suburban: bool = False
    transfer: bool = False   # у пассажиров есть пересадка на конечной

    @property
    def origin_dep(self) -> float:
        return self.schedule[0].dep or 0.0

    @property
    def final_arr(self) -> float:
        return self.schedule[-1].arr or 0.0
