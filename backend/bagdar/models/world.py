"""Статическая модель инфраструктуры: раздельные пункты, пути, горловины,
перегоны, сигналы, стрелки, зоны диспетчеров."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

StationKind = Literal["terminal", "station", "loop", "junction"]


@dataclass(slots=True)
class Track:
    id: str
    name: str
    length_m: int
    is_main: bool


@dataclass(slots=True)
class Station:
    id: str
    name: str
    kind: StationKind
    km: float
    x: float
    y: float
    zone_id: str
    tracks: list[Track]
    crew_change: bool = False

    def track(self, track_id: str) -> Track:
        for t in self.tracks:
            if t.id == track_id:
                return t
        raise KeyError(track_id)


@dataclass(slots=True)
class Section:
    """Перегон между раздельными пунктами a и b (a — меньший километр).

    Направление +1 — от a к b (нечётное), −1 — от b к a (чётное).
    gradient_permille задан для направления +1 (положительный — подъём).
    """
    id: str
    a: str
    b: str
    length_km: float
    tracks: int
    signalling: Literal["AB", "PAB"]
    blocks: int
    speed_limit_kmh: float
    gradient_permille: float
    no_stop_uphill: bool
    zone_id: str
    throat_a: str      # горловина станции a, к которой примыкает перегон
    throat_b: str
    electrified: bool = True

    @property
    def length_m(self) -> float:
        return self.length_km * 1000.0

    def gradient_for(self, direction: int) -> float:
        return self.gradient_permille if direction > 0 else -self.gradient_permille

    def from_station(self, direction: int) -> str:
        return self.a if direction > 0 else self.b

    def to_station(self, direction: int) -> str:
        return self.b if direction > 0 else self.a

    def departure_throat(self, direction: int) -> str:
        return self.throat_a if direction > 0 else self.throat_b

    def arrival_throat(self, direction: int) -> str:
        return self.throat_b if direction > 0 else self.throat_a


@dataclass(slots=True)
class Signal:
    """Выходной светофор: разрешает отправление со станции на перегон."""
    id: str
    section_id: str
    station_id: str
    direction: int


@dataclass(slots=True)
class Switch:
    """Стрелка, ведущая на боковой путь. Неисправность выводит путь из работы."""
    id: str
    station_id: str
    track_id: str
    number: int


@dataclass(slots=True)
class Zone:
    id: str
    name: str
    station_ids: list[str]


@dataclass
class World:
    id: str
    mode: str
    seed: int
    name: str
    stations: dict[str, Station]
    sections: dict[str, Section]
    signals: dict[str, Signal]
    switches: dict[str, Switch]
    zones: dict[str, Zone]
    _adj: dict[tuple[str, str], str] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self._adj = {}
        for s in self.sections.values():
            self._adj[(s.a, s.b)] = s.id
            self._adj[(s.b, s.a)] = s.id

    def section_between(self, u: str, v: str) -> Section:
        return self.sections[self._adj[(u, v)]]

    def direction(self, section: Section, from_station: str) -> int:
        return 1 if section.a == from_station else -1

    def neighbors(self, station_id: str) -> list[str]:
        return [v for (u, v) in self._adj if u == station_id]

    def exit_signal(self, section_id: str, direction: int) -> str:
        return f"sig-{section_id}-{'o' if direction > 0 else 'e'}"
