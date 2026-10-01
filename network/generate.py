"""Build the two Dostyk–Moyynty demonstration worlds from reviewed data.

No external service is used at runtime. Station names/order and approximate
chainage live in data/dostyk_moyynty/line.json; provenance is kept next to it.
The resulting timetables are desired, synthetic timetables, not safety-cleared
plans. The zone planner and independent validator arrive in the next step.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from network.schedule import CLASS_INFO, DEFAULT_CLASS_SHARES, generate_trains

ROOT = Path(__file__).resolve().parents[1]
LINE_FILE = ROOT / "data" / "dostyk_moyynty" / "line.json"
OUT_DIR = LINE_FILE.parent


def load_line(path: Path = LINE_FILE) -> dict:
    line = json.loads(path.read_text(encoding="utf-8"))
    stations = line["stations"]
    if len(stations) < 2 or stations[0]["km"] != 0:
        raise ValueError("The line must begin at km 0 and have at least two stations")
    if abs(stations[-1]["km"] - line["length_km"]) > 1e-6:
        raise ValueError("Last station km must match line length")
    if any(a["km"] >= b["km"] for a, b in zip(stations, stations[1:])):
        raise ValueError("Station chainage must increase strictly")
    if len({s["id"] for s in stations}) != len(stations):
        raise ValueError("Station IDs must be unique")
    return line


def _schematic_positions(raw_stations: list[dict]) -> dict[str, tuple[float, float]]:
    """Interpolate between sourced OSM anchors, then project for a schematic.

    These x/y are display coordinates, not geographic coordinates. In-between
    station positions are approximate and must not be used as map evidence.
    """
    anchors = [s for s in raw_stations if "lat" in s and "lon" in s]
    if len(anchors) < 2 or anchors[0]["id"] != raw_stations[0]["id"] or anchors[-1]["id"] != raw_stations[-1]["id"]:
        raise ValueError("Both endpoints and at least two OSM anchors are required")
    lon_min = min(s["lon"] for s in anchors)
    lon_max = max(s["lon"] for s in anchors)
    lat_min = min(s["lat"] for s in anchors)
    lat_max = max(s["lat"] for s in anchors)
    positions: dict[str, tuple[float, float]] = {}
    for station in raw_stations:
        before = max((s for s in anchors if s["km"] <= station["km"]), key=lambda s: s["km"])
        after = min((s for s in anchors if s["km"] >= station["km"]), key=lambda s: s["km"])
        fraction = 0.0 if before["id"] == after["id"] else (station["km"] - before["km"]) / (after["km"] - before["km"])
        lon = before["lon"] + fraction * (after["lon"] - before["lon"])
        lat = before["lat"] + fraction * (after["lat"] - before["lat"])
        x = 1000 * (lon_max - lon) / (lon_max - lon_min)
        y = 210 - 160 * (lat - lat_min) / (lat_max - lat_min)
        positions[station["id"]] = (round(x, 2), round(y, 2))
    return positions


def _station(raw: dict, xy: tuple[float, float]) -> dict:
    sid = raw["id"]
    kind = raw.get("kind", "loop")
    n_tracks = 6 if kind == "terminal" else 4 if kind in ("station", "junction") else 3
    tracks = [{"id": f"{sid}-t{i}", "name": str(i), "length_m": 1250 if i == 1 else 1150,
               "is_main": i == 1} for i in range(1, n_tracks + 1)]
    return {"id": sid, "name": raw["name"], "kind": kind, "km": raw["km"],
            "x": xy[0], "y": xy[1],
            "zone_id": "dm-z1", "crew_change": kind in ("terminal", "station", "junction"),
            "tracks": tracks}


def build_world(line: dict, *, variant: str, seed: int, count: int,
                class_shares: dict[str, float] | None = None) -> dict:
    started = time.perf_counter()
    if variant not in ("single", "double"):
        raise ValueError("variant must be 'single' or 'double'")
    if count < 0 or seed < 0:
        raise ValueError("count and seed must be nonnegative")
    raw_stations = line["stations"]
    schematic = _schematic_positions(raw_stations)
    stations = [_station(s, schematic[s["id"]]) for s in raw_stations]
    sections = []
    signals = []
    for i, (a, b) in enumerate(zip(stations, stations[1:]), start=1):
        sid = f"dm-s{i:02d}"
        length = round(b["km"] - a["km"], 3)
        if length <= 0:
            raise ValueError(f"Nonpositive section length at {a['name']}")
        sections.append({"id": sid, "a": a["id"], "b": b["id"], "length_km": length,
                         "tracks": 1 if variant == "single" else 2,
                         "signalling": "AB", "blocks": max(2, round(length / 3)),
                         "speed_limit_kmh": 80.0,
                         "gradient_permille": 0.0, "no_stop_uphill": False,
                         "electrified": False, "throat_a": f"{a['id']}:B",
                         "throat_b": f"{b['id']}:A"})
        signals.extend([
            {"id": f"sig-{sid}-o", "section_id": sid, "station_id": a["id"], "direction": 1},
            {"id": f"sig-{sid}-e", "section_id": sid, "station_id": b["id"], "direction": -1},
        ])
    switches = []
    for station in stations:
        for n, track in enumerate(station["tracks"][1:], start=1):
            switches.append({"id": f"sw-{track['id']}", "station_id": station["id"],
                             "track_id": track["id"], "number": 2 * n - 1})
    trains = generate_trains(stations, sections, seed=seed, count=count, class_shares=class_shares)
    classes = [{"key": key, "label": info["label"], "pte_rank": info["pte_rank"],
                "weight": info["weight"], "tolerance_min": info["tolerance_min"]}
               for key, info in CLASS_INFO.items()]
    return {"id": f"dm-{variant}-{seed}", "mode": "network", "seed": seed,
            "name": f"Достык — Мойынты, {'однопутная' if variant == 'single' else 'двухпутная'} модель",
            "version": 1, "scenario_id": f"dm-{variant}", "start_time": 0.0,
            "date": "2026-10-01", "tz": "+05:00",
            "zones": [{"id": "dm-z1", "name": "Достык — Мойынты",
                       "station_ids": [s["id"] for s in stations]}],
            "stations": stations, "sections": sections, "signals": signals,
            "switches": switches, "trains": trains, "classes": classes,
            "generation": {"trains_total": len(trains), "dropped": [],
                           "build_ms": round((time.perf_counter() - started) * 1000, 3),
                           "validated": False}}


def build_scenario(world: dict, *, variant: str, count: int,
                   class_shares: dict[str, float] | None = None) -> dict:
    return {"id": f"dm-{variant}", "title": world["name"],
            "summary": "Схема по открытым данным; длины перегонов, пути, скорость и движение смоделированы. Желаемый график ещё не проверен планировщиком.",
            "mode": "network", "seed": world["seed"], "start_time": "00:00",
            "difficulty": 2 if variant == "single" else 1, "wave": 0,
            "world": {"file": f"world.{variant}.json", "variant": variant},
            "traffic": {"count": count, "class_shares": dict(DEFAULT_CLASS_SHARES if class_shares is None else class_shares)},
            "disruptions": []}


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--single-count", type=int, default=24)
    parser.add_argument("--double-count", type=int, default=120)
    parser.add_argument("--class-shares", type=str, default=None,
                        help='JSON object, e.g. {"freight":0.8,"passenger":0.2}')
    args = parser.parse_args()
    class_shares = json.loads(args.class_shares) if args.class_shares else None
    if class_shares is not None and not isinstance(class_shares, dict):
        parser.error("--class-shares must be a JSON object")
    line = load_line()
    for variant, count in (("single", args.single_count), ("double", args.double_count)):
        world = build_world(line, variant=variant, seed=args.seed, count=count, class_shares=class_shares)
        write_json(OUT_DIR / f"world.{variant}.json", world)
        write_json(OUT_DIR / f"scenario.{variant}.json", build_scenario(world, variant=variant, count=count,
                                                                       class_shares=class_shares))
        print(f"{variant}: {len(world['stations'])} stations, {len(world['sections'])} sections, "
              f"{len(world['trains'])} synthetic trains, {line['length_km']} km")


if __name__ == "__main__":
    main()
