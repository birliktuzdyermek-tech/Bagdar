"""Deterministic *desired* traffic for a corridor in the world contract.

Times are model seconds from midnight. The output is deliberately not a
conflict-free dispatch plan: the network planner must reserve resources and
validate any resulting plan before it can be presented as safe.

This module has no dependency on the Core implementation.
"""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence


# Contract metadata, in the same order as contracts/examples/world.light.json.
CLASS_INFO: dict[str, dict[str, str | int | float]] = {
    "extraordinary": {"label": "Внеочередной", "pte_rank": 0, "weight": 1000.0, "tolerance_min": 0.0},
    "high_speed_passenger": {"label": "Скоростной пассажирский", "pte_rank": 1, "weight": 100.0, "tolerance_min": 2.0},
    "fast_passenger": {"label": "Скорый пассажирский", "pte_rank": 2, "weight": 70.0, "tolerance_min": 3.0},
    "passenger": {"label": "Пассажирский", "pte_rank": 3, "weight": 50.0, "tolerance_min": 5.0},
    "express_freight": {"label": "Ускоренный грузовой", "pte_rank": 4, "weight": 30.0, "tolerance_min": 15.0},
    "freight": {"label": "Грузовой", "pte_rank": 5, "weight": 10.0, "tolerance_min": 30.0},
    "local_freight": {"label": "Сборный грузовой", "pte_rank": 5, "weight": 5.0, "tolerance_min": 60.0},
    "light_engine": {"label": "Локомотив резервом", "pte_rank": 5, "weight": 3.0, "tolerance_min": 60.0},
}

DEFAULT_CLASS_SHARES: dict[str, float] = {
    "fast_passenger": 0.05,
    "passenger": 0.10,
    "express_freight": 0.15,
    "freight": 0.65,
    "local_freight": 0.05,
}

_V_MAX = {
    "extraordinary": 100.0,
    "high_speed_passenger": 160.0,
    "fast_passenger": 120.0,
    "passenger": 100.0,
    "express_freight": 90.0,
    "freight": 80.0,
    "local_freight": 70.0,
    "light_engine": 100.0,
}
_NUMBER_BASE = {
    "extraordinary": 9001,
    "high_speed_passenger": 701,
    "fast_passenger": 1,
    "passenger": 301,
    "express_freight": 1001,
    "freight": 2001,
    "local_freight": 3401,
    "light_engine": 4001,
}
_FREIGHT = {"express_freight", "freight", "local_freight"}
_PASSENGER = {"high_speed_passenger", "fast_passenger", "passenger"}


def _class_counts(count: int, shares: Mapping[str, float]) -> list[str]:
    """Allocate an exact count by largest remainders, in stable class order."""
    unknown = set(shares) - CLASS_INFO.keys()
    if unknown:
        raise ValueError(f"Unknown train classes: {', '.join(sorted(unknown))}")
    if not shares or any(not math.isfinite(v) or v < 0 for v in shares.values()):
        raise ValueError("Class shares must be finite, non-negative numbers")
    total = sum(shares.values())
    if total <= 0:
        raise ValueError("At least one class share must be positive")

    exact = {key: count * shares.get(key, 0.0) / total for key in CLASS_INFO}
    quantities = {key: math.floor(value) for key, value in exact.items()}
    left = count - sum(quantities.values())
    class_order = list(CLASS_INFO)
    remainders = sorted(class_order, key=lambda key: (-(exact[key] - quantities[key]), class_order.index(key)))
    for key in remainders[:left]:
        quantities[key] += 1
    return [key for key in class_order for _ in range(quantities[key])]


def _profile(cls: str, rng: random.Random, max_length: int) -> tuple[int, int, int, list[str]]:
    """Synthetic consist dimensions and load; no real commercial data."""
    if cls in _FREIGHT:
        nominal = rng.choice((700, 800, 900, 1000)) if cls != "local_freight" else rng.choice((350, 450, 550))
        length = min(nominal, max_length)
        mass = int(round(length * rng.uniform(3.0, 4.6)))
        cargo = ["urgent"] if cls == "express_freight" else []
        if rng.random() < 0.08:
            cargo.append("dangerous")
        return length, mass, 0, cargo
    if cls == "light_engine":
        return min(40, max_length), rng.randint(130, 200), 0, []
    if cls == "extraordinary":
        return min(rng.choice((100, 150, 200)), max_length), rng.randint(200, 450), 0, []
    nominal = rng.choice((220, 260, 300, 350))
    length = min(nominal, max_length)
    return length, int(round(length * rng.uniform(1.5, 2.4))), rng.randint(180, 650), []


def _track_id(station: Mapping, length_m: int, stopping: bool) -> str:
    tracks = [track for track in station["tracks"] if track["length_m"] >= length_m]
    if not tracks:
        raise ValueError(f"No track fits train at station {station['id']}")
    # Through movements favour a main track; planned stops favour a siding.
    tracks.sort(key=lambda track: (track["is_main"] == stopping, track["id"]))
    return tracks[0]["id"]


def generate_trains(
    stations: Sequence[Mapping],
    sections: Sequence[Mapping],
    *,
    seed: int,
    count: int,
    class_shares: Mapping[str, float] | None = None,
) -> list[dict]:
    """Return ``count`` world-contract trains for a connected linear corridor.

    ``stations`` may be passed in any order; their strictly increasing ``km``
    values define the line. One section must connect each adjacent station
    pair. Every train runs end to end, with half in each direction. Departure
    wishes are spread over a synthetic day. Arrivals may extend past 24:00.
    These wishes can conflict, especially on a single track or at high load.
    """
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("seed must be an integer")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ValueError("count must be a non-negative integer")
    shares = DEFAULT_CLASS_SHARES if class_shares is None else class_shares
    classes = _class_counts(count, shares)
    if count == 0:
        return []

    line = sorted(stations, key=lambda station: station["km"])
    if len(line) < 2:
        raise ValueError("At least two stations are required")
    if len({station["id"] for station in line}) != len(line):
        raise ValueError("Station IDs must be unique")
    if any(a["km"] >= b["km"] for a, b in zip(line, line[1:])):
        raise ValueError("Station km values must be strictly increasing")
    if any(not station.get("tracks") for station in line):
        raise ValueError("Every station needs at least one track")
    max_length = min(max(int(track["length_m"]) for track in station["tracks"]) for station in line)
    if max_length < 40:
        raise ValueError("Every station must fit a train of at least 40 m")

    by_pair: dict[frozenset[str], Mapping] = {}
    for section in sorted(sections, key=lambda item: item["id"]):
        by_pair.setdefault(frozenset((section["a"], section["b"])), section)
    forward_sections = []
    for left, right in zip(line, line[1:]):
        section = by_pair.get(frozenset((left["id"], right["id"])))
        if section is None:
            raise ValueError(f"No section between {left['id']} and {right['id']}")
        if section["length_km"] <= 0 or section["speed_limit_kmh"] <= 0:
            raise ValueError(f"Section {section['id']} needs positive length and speed")
        forward_sections.append(section)

    rng = random.Random(seed)
    rng.shuffle(classes)
    numbers_next = {key: {1: base, -1: base + 1} for key, base in _NUMBER_BASE.items()}
    used_numbers: set[int] = set()
    output: list[dict] = []
    electrified = all(section.get("electrified", False) for section in forward_sections)

    for i, cls in enumerate(classes):
        direction = 1 if i % 2 == 0 else -1
        route_stations = line if direction == 1 else list(reversed(line))
        route_sections = forward_sections if direction == 1 else list(reversed(forward_sections))
        number = numbers_next[cls][direction]
        while number in used_numbers:
            number += 2
        numbers_next[cls][direction] = number + 2
        used_numbers.add(number)

        length, mass, passengers, cargo = _profile(cls, rng, max_length)
        # A jittered regular grid leaves both directions represented throughout
        # the day. Values beyond midnight are valid model seconds in the contract.
        departure = round((i + rng.uniform(0.15, 0.85)) * 86400 / count, 1)
        schedule: list[dict] = []
        current = departure
        for pos, station in enumerate(route_stations):
            first = pos == 0
            last = pos == len(route_stations) - 1
            if first:
                arrival = None
                dwell = 0.0
                stopping = True
                next_departure = current
            else:
                section = route_sections[pos - 1]
                speed = min(_V_MAX[cls], float(section["speed_limit_kmh"]))
                # A fixed allowance represents acceleration and braking; this
                # desired running time is deliberately not a physical solver.
                current = round(current + section["length_km"] * 3600 / speed + 90, 1)
                arrival = current
                if last:
                    stopping = True
                    dwell = 0.0
                    next_departure = None
                else:
                    stopping = (cls in _PASSENGER and station.get("kind") != "loop") or (
                        cls in _FREIGHT and station.get("crew_change", False)
                    )
                    dwell = float(rng.choice((120, 180, 240))) if stopping else 0.0
                    next_departure = round(current + dwell, 1)
            schedule.append({
                "station_id": station["id"],
                "arr": arrival,
                "dep": next_departure,
                "stop": stopping,
                "dwell_s": dwell,
                "track_id": _track_id(station, length, stopping),
            })
            if next_departure is not None:
                current = next_departure

        output.append({
            "id": f"t{number}",
            "number": str(number),
            "cls": cls,
            "cls_label": CLASS_INFO[cls]["label"],
            "pte_rank": CLASS_INFO[cls]["pte_rank"],
            "direction": direction,
            "length_m": length,
            "mass_t": mass,
            "passengers": passengers,
            "cargo": cargo,
            "traction": "electric" if electrified else "diesel",
            "vmax_kmh": _V_MAX[cls],
            "loco_id": f"{'KZ8A' if cls in _FREIGHT else 'KZ4A'}-{number:05d}" if electrified else f"TE33A-{number:05d}",
            "crew_id": f"Б-{number:05d}",
            "crew_shift_end": max(schedule[-1]["arr"] + 3600, departure + 8 * 3600),
            "route": [station["id"] for station in route_stations],
            "sections": [section["id"] for section in route_sections],
            "suburban": False,
            "transfer": False,
            "schedule": schedule,
        })
    return output
