"""Генератор инфраструктуры по seed. Один и тот же seed даёт тот же мир.

Лёгкий режим — один участок (коридор) из 20 раздельных пунктов:
однопутная линия с двухпутными вставками, станции с путями разной длины.
Средний и ультра-режим собираются из таких же коридоров (этапы 8–9).
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass

from bagdar.generator.names import station_names
from bagdar.models.world import Section, Signal, Station, Switch, Track, World, Zone


@dataclass
class CorridorParams:
    n_stations: int = 20
    single_km: tuple[float, float] = (6.5, 10.0)     # однопутные перегоны
    double_km: tuple[float, float] = (12.0, 17.0)    # двухпутные вставки длиннее
    double_track_inserts: int = 7
    intermediate_stations: int = 3
    pab_share: float = 0.08
    two_siding_loop_share: float = 0.5
    short_siding_share: float = 0.25
    electrified: bool = True


def _station_tracks(rng: random.Random, sid: str, kind: str, p: CorridorParams) -> list[Track]:
    tracks: list[Track] = []

    def add(n: int, length: int, main: bool) -> None:
        tracks.append(Track(id=f"{sid}-t{n}", name=str(n), length_m=length, is_main=main))

    if kind == "terminal":
        add(1, 1250, True)
        for n in range(2, 7):
            add(n, rng.choice([950, 1050, 1150, 1250]), False)
    elif kind == "station":
        add(1, 1150, True)
        add(2, rng.choice([1050, 1150]), False)
        for n in (3, 4):
            add(n, rng.choice([750, 850, 950, 1050]), False)
    else:  # разъезд
        add(1, 1100, True)
        short = rng.random() < p.short_siding_share
        add(2, rng.choice([650, 700, 750]) if short else rng.choice([900, 1000, 1100]), False)
        if rng.random() < p.two_siding_loop_share:
            add(3, rng.choice([750, 850, 1050]), False)
    return tracks


def generate_corridor(rng: random.Random, p: CorridorParams, zone_id: str, prefix: str,
                      km0: float = 0.0) -> tuple[list[Station], list[Section]]:
    n = p.n_stations
    names = station_names(rng, n)
    # Промежуточные станции равномерно по участку, остальное — разъезды.
    step = (n - 1) / (p.intermediate_stations + 1)
    station_idx = {round(step * (i + 1)) for i in range(p.intermediate_stations)}
    # Двухпутные вставки: подходы к крупным станциям (через них идёт весь
    # поток) и равномерно по участку. Однопутные перегоны короче — так
    # однопутка не превращается в бутылочное горлышко.
    double: set[int] = set()
    if p.double_track_inserts >= 2:
        double |= {0, n - 2}
    inner = p.double_track_inserts - len(double)
    if inner > 0:
        slots = [round(1 + (n - 4) * (j + 0.5) / inner) for j in range(inner)]
        for c in slots:
            c = max(1, min(n - 3, c + rng.choice([-1, 0, 1])))
            while c in double or c - 1 in double or c + 1 in double:
                c = c + 1 if c + 1 <= n - 3 else 1
            double.add(c)

    stations: list[Station] = []
    km = km0
    for i in range(n):
        sid = f"{prefix}st{i + 1:02d}"
        if i in (0, n - 1):
            kind = "terminal"
        elif i in station_idx:
            kind = "station"
        else:
            kind = "loop"
        if kind == "loop":
            name = f"Разъезд {i + 1}"
        else:
            name = names[i]
        if i > 0:
            km += round(rng.uniform(*(p.double_km if (i - 1) in double else p.single_km)), 1)
        stations.append(Station(
            id=sid, name=name, kind=kind, km=round(km, 1),
            x=round(km, 2), y=round(6 * math.sin(km / 37.0) + rng.uniform(-1.5, 1.5), 2),
            zone_id=zone_id, tracks=_station_tracks(rng, sid, kind, p),
            crew_change=kind != "loop" and (kind == "terminal" or i == n // 2 or i in station_idx),
        ))

    sections: list[Section] = []
    for i in range(n - 1):
        a, b = stations[i], stations[i + 1]
        length = round(b.km - a.km, 1)
        tracks = 2 if i in double else 1
        signalling = "AB" if tracks == 2 or rng.random() >= p.pab_share else "PAB"
        limit = rng.choices([60, 80, 90, 100, 110, 120], weights=[1, 2, 3, 3, 2, 2])[0]
        grad = round(max(-9.0, min(9.0, rng.gauss(0, 4.5))), 1)
        sections.append(Section(
            id=f"{prefix}s{i + 1:02d}", a=a.id, b=b.id, length_km=length, tracks=tracks,
            signalling=signalling,
            blocks=max(2, round(length / 2.0)) if signalling == "AB" else 1,
            speed_limit_kmh=limit, gradient_permille=grad, no_stop_uphill=abs(grad) >= 6.0,
            zone_id=zone_id, throat_a=f"{a.id}:B", throat_b=f"{b.id}:A", electrified=p.electrified,
        ))
    return stations, sections


def _signals_and_switches(stations: list[Station], sections: list[Section]) -> tuple[dict, dict]:
    signals: dict[str, Signal] = {}
    for s in sections:
        for d in (1, -1):
            sig_id = f"sig-{s.id}-{'o' if d > 0 else 'e'}"
            signals[sig_id] = Signal(id=sig_id, section_id=s.id, station_id=s.from_station(d), direction=d)
    switches: dict[str, Switch] = {}
    for st in stations:
        num = 1
        for t in st.tracks:
            if t.is_main:
                continue
            sw_id = f"sw-{t.id}"
            switches[sw_id] = Switch(id=sw_id, station_id=st.id, track_id=t.id, number=num)
            num += 2
    return signals, switches


def generate_world(mode: str, seed: int, corridor: CorridorParams | None = None) -> World:
    rng = random.Random(seed)
    if mode != "light":
        raise ValueError(f"Режим «{mode}» ещё не реализован (этапы 8–9). Доступен: light")
    p = corridor or CorridorParams()
    stations, sections = generate_corridor(rng, p, zone_id="z1", prefix="")
    signals, switches = _signals_and_switches(stations, sections)
    zones = {"z1": Zone(id="z1", name="Участок 1", station_ids=[s.id for s in stations])}
    return World(
        id=f"{mode}-{seed}", mode=mode, seed=seed,
        name=f"Участок {stations[0].name} — {stations[-1].name}",
        stations={s.id: s for s in stations},
        sections={s.id: s for s in sections},
        signals=signals, switches=switches, zones=zones,
    )
