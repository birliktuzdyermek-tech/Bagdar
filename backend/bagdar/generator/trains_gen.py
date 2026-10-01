"""Генерация состава поездов на сутки по seed.

Нумерация по сетке РЖД/КТЖ: нечётные номера — нечётное направление (+1),
чётные — чётное. Скоростные 701+, скорые 1+, пассажирские 301+,
пригородные 6001+, ускоренные грузовые 1001+, грузовые 2001+,
сборные 3401+, локомотивы резервом 4001+.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from bagdar.core.classes import TRAIN_CLASSES
from bagdar.models.world import World


@dataclass
class TrafficParams:
    high_speed: int = 2
    fast: int = 6
    passenger: int = 4
    suburban: int = 6
    express_freight: int = 14
    freight: int = 60
    local_freight: int = 6
    light_engine: int = 6
    day_start_h: float = 0.0
    day_end_h: float = 24.0
    peak_start_h: float = 3.5        # окно повышенной плотности (под демо 06:00–12:00)
    peak_end_h: float = 13.0
    peak_share: float = 0.6          # доля грузовых, желающих ехать в пиковое окно


@dataclass
class TrainSpec:
    """Желаемый поезд до построения графика."""
    id: str
    number: str
    cls: str
    direction: int
    route: list[str]
    desired_dep: float
    dwell: dict[int, float]         # индекс станции маршрута -> плановая стоянка, с
    length_m: int
    mass_t: int
    passengers: int
    cargo: list[str]
    traction: str
    loco_id: str
    crew_id: str
    crew_hours: float
    suburban: bool = False
    transfer: bool = False
    fixed_time: bool = False        # для сценариев: время задано жёстко
    extra: dict = field(default_factory=dict)


class _Numbers:
    BASE = {"high_speed_passenger": 701, "fast_passenger": 1, "passenger": 301, "suburban": 6001,
            "express_freight": 1001, "freight": 2001, "local_freight": 3401, "light_engine": 4001,
            "extraordinary": 9001}

    def __init__(self) -> None:
        self.next = {k: {1: v if v % 2 == 1 else v + 1, -1: v + 1 if v % 2 == 1 else v}
                     for k, v in self.BASE.items()}

    def take(self, key: str, direction: int) -> int:
        n = self.next[key][direction]
        self.next[key][direction] = n + 2
        return n


def _line_order(world: World) -> list[str]:
    return [s.id for s in sorted(world.stations.values(), key=lambda s: s.km)]


def generate_traffic(world: World, seed: int, p: TrafficParams | None = None) -> list[TrainSpec]:
    p = p or TrafficParams()
    rng = random.Random(seed * 7919 + 17)
    line = _line_order(world)
    n = len(line)
    kinds = {sid: world.stations[sid].kind for sid in line}
    numbers = _Numbers()
    specs: list[TrainSpec] = []
    t0, t1 = p.day_start_h * 3600, p.day_end_h * 3600

    def route_for(direction: int, i0: int, i1: int) -> list[str]:
        seg = line[i0:i1 + 1]
        return seg if direction > 0 else list(reversed(seg))

    def spread(count: int, jitter_min: float, align: int = 1) -> list[float]:
        if count <= 0:
            return []
        span = (t1 - t0) / count
        out = []
        for i in range(count):
            t = t0 + span * (i + rng.uniform(0.15, 0.85)) + rng.uniform(-jitter_min, jitter_min) * 60
            t = max(t0, min(t1 - 60, t))
            out.append(round(t / (60 * align)) * 60 * align)
        return out

    loco_seq = {"electric": 100, "diesel": 300}

    def make(cls_key: str, num_key: str, direction: int, route: list[str], dep: float,
             dwell: dict[int, float], **kw) -> None:
        number = numbers.take(num_key, direction)
        traction = kw.pop("traction", "electric")
        loco_seq[traction] += rng.randint(1, 9)
        loco = ("KZ8A-" if traction == "electric" and cls_key in ("freight", "express_freight", "local_freight")
                else "KZ4A-" if traction == "electric" else "TE33A-") + f"{loco_seq[traction]:04d}"
        crew_hours = kw.pop("crew_hours", rng.uniform(6.0, 11.0))
        specs.append(TrainSpec(
            id=f"t{number}", number=str(number), cls=cls_key, direction=direction, route=route,
            desired_dep=dep, dwell=dwell, loco_id=loco, crew_id=f"Б-{rng.randint(1000, 9999)}",
            crew_hours=crew_hours, traction=traction, **kw))

    def stops_at(route: list[str], which: set[str], dwell_range: tuple[float, float]) -> dict[int, float]:
        out = {}
        for i, sid in enumerate(route[1:-1], start=1):
            if kinds[sid] in which:
                out[i] = round(rng.uniform(*dwell_range) / 30) * 30
        return out

    # Пассажирские
    for cls_key, count, which, dwell, pax in [
        ("high_speed_passenger", p.high_speed, {"junction"}, (120, 120), (300, 500)),
        ("fast_passenger", p.fast, {"station", "junction"}, (120, 180), (400, 800)),
        ("passenger", p.passenger, {"station", "junction"}, (120, 300), (200, 600)),
    ]:
        for i, dep in enumerate(spread(count, 20, align=5)):
            d = 1 if i % 2 == 0 else -1
            route = route_for(d, 0, n - 1)
            dw = stops_at(route, which, dwell)
            if cls_key == "high_speed_passenger":
                mid = len(route) // 2
                dw = {mid: 120}
            make(cls_key, cls_key, d, route, dep, dw,
                 length_m=rng.choice([300, 350, 400, 450, 500]),
                 mass_t=rng.randint(600, 1200), passengers=rng.randint(*pax), cargo=[],
                 transfer=rng.random() < 0.3)

    # Пригородные: от конечной до промежуточной станции, остановки везде
    mid_stations = [i for i, sid in enumerate(line) if kinds[sid] == "station"]
    for i, dep in enumerate(spread(p.suburban, 15, align=5)):
        d = 1 if i % 2 == 0 else -1
        turn = rng.choice(mid_stations) if mid_stations else n // 2
        route = route_for(d, 0, turn) if d > 0 else route_for(d, turn, n - 1)
        dw = {j: 60 for j in range(1, len(route) - 1)}
        make("passenger", "suburban", d, route, dep, dw,
             length_m=rng.choice([200, 250, 300]), mass_t=rng.randint(400, 700),
             passengers=rng.randint(150, 900), cargo=[], suburban=True)

    def freight_times(count: int) -> list[tuple[float, int]]:
        """Грузовые идут пакетами по 2–3 поезда в одну сторону (пакетный график
        однопутной линии с автоблокировкой), направления пакетов чередуются."""
        groups: list[int] = []
        left = count
        while left > 0:
            g = min(left, rng.choice([2, 2, 3]))
            groups.append(g)
            left -= g
        peak_groups = round(len(groups) * p.peak_share)
        starts: list[float] = []
        span_p = (p.peak_end_h - p.peak_start_h) * 3600 / max(1, peak_groups)
        for i in range(peak_groups):
            starts.append(p.peak_start_h * 3600 + span_p * (i + rng.uniform(0.1, 0.9)))
        rest = len(groups) - peak_groups
        span_o = (24 - (p.peak_end_h - p.peak_start_h)) * 3600 / max(1, rest)
        for i in range(rest):
            starts.append((p.peak_end_h * 3600 + span_o * (i + rng.uniform(0.1, 0.9))) % 86400)
        starts.sort()
        out: list[tuple[float, int]] = []
        d0 = 1 if rng.random() < 0.5 else -1
        for gi, (g, t) in enumerate(zip(groups, starts)):
            d = d0 if gi % 2 == 0 else -d0
            for j in range(g):
                out.append((round((t + j * rng.uniform(420, 600)) / 60) * 60, d))
        return out

    # Грузовые
    for cls_key, count in [("express_freight", p.express_freight), ("freight", p.freight)]:
        for dep, d in freight_times(count):
            route = route_for(d, 0, n - 1)
            dw: dict[int, float] = {}
            if cls_key == "freight" and rng.random() < 0.4:
                crew_st = [j for j, sid in enumerate(route[1:-1], start=1) if world.stations[sid].crew_change]
                if crew_st:
                    dw[rng.choice(crew_st)] = round(rng.uniform(900, 1500) / 60) * 60
            cargo = []
            if cls_key == "express_freight":
                cargo.append("urgent")
                if rng.random() < 0.4:
                    cargo.append("perishable")
            else:
                if rng.random() < 0.15:
                    cargo.append("dangerous")
                if rng.random() < 0.12:
                    cargo.append("deadline")
            length = rng.choice([550, 650, 750, 850, 950, 1050]) if cls_key == "freight" else rng.choice([500, 600, 700, 800])
            mass = rng.randint(3500, 6500) if cls_key == "freight" else rng.randint(2200, 4000)
            make(cls_key, cls_key, d, route, dep, dw, length_m=length, mass_t=mass, passengers=0,
                 cargo=cargo, crew_hours=rng.uniform(3.0, 10.0))

    # Сборные: короткие маршруты с работой на станциях
    for i, dep in enumerate(spread(p.local_freight, 30)):
        d = 1 if i % 2 == 0 else -1
        a = rng.randint(0, n // 2)
        b = rng.randint(a + 5, n - 1)
        route = route_for(d, a, b)
        dw = stops_at(route, {"station"}, (600, 1200))
        make("local_freight", "local_freight", d, route, dep, dw, length_m=rng.choice([350, 450, 550]),
             mass_t=rng.randint(1500, 3000), passengers=0, cargo=[], traction="diesel")

    # Локомотивы резервом
    for i, dep in enumerate(spread(p.light_engine, 30)):
        d = 1 if rng.random() < 0.5 else -1
        a = rng.randint(0, n // 3)
        b = rng.randint(n // 2, n - 1)
        make("light_engine", "light_engine", d, route_for(d, a, b), dep, {}, length_m=40,
             mass_t=rng.randint(130, 200), passengers=0, cargo=[])

    assert all(s.cls in TRAIN_CLASSES for s in specs)
    return specs
