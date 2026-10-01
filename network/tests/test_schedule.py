"""Checks for synthetic desired traffic, independent of the Core package."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from network.schedule import CLASS_INFO, generate_trains


def _corridor() -> tuple[list[dict], list[dict]]:
    stations = [
        {
            "id": f"st{i}",
            "km": i * 20.0,
            "kind": "terminal" if i in (0, 3) else "station",
            "crew_change": i == 2,
            "tracks": [
                {"id": f"st{i}-t1", "length_m": 1200, "is_main": True},
                {"id": f"st{i}-t2", "length_m": 1100, "is_main": False},
            ],
        }
        for i in range(4)
    ]
    sections = [
        {
            "id": f"sec{i}",
            "a": f"st{i}",
            "b": f"st{i + 1}",
            "length_km": 20.0,
            "speed_limit_kmh": 90.0,
            "electrified": True,
        }
        for i in range(3)
    ]
    return stations, sections


def test_seed_reproducibility_and_sensitivity() -> None:
    stations, sections = _corridor()
    same_a = generate_trains(stations, sections, seed=42, count=120)
    same_b = generate_trains(stations, sections, seed=42, count=120)
    other = generate_trains(stations, sections, seed=43, count=120)
    assert same_a == same_b
    assert same_a != other


@pytest.mark.parametrize("count", [20, 120, 1000])
def test_count_class_mix_and_numbers(count: int) -> None:
    stations, sections = _corridor()
    shares = {"passenger": 0.25, "freight": 0.75}
    trains = generate_trains(stations, sections, seed=7, count=count, class_shares=shares)
    assert len(trains) == count
    assert Counter(train["cls"] for train in trains) == {"passenger": count // 4, "freight": count * 3 // 4}
    assert len({train["id"] for train in trains}) == count
    assert len({train["number"] for train in trains}) == count
    for train in trains:
        assert int(train["number"]) % 2 == (1 if train["direction"] == 1 else 0)
        assert train["pte_rank"] == CLASS_INFO[train["cls"]]["pte_rank"]


def test_route_schedule_section_and_track_consistency() -> None:
    stations, sections = _corridor()
    trains = generate_trains(stations, sections, seed=9, count=20)
    station_by_id = {station["id"]: station for station in stations}
    section_by_id = {section["id"]: section for section in sections}
    for train in trains:
        expected_route = [station["id"] for station in stations]
        if train["direction"] == -1:
            expected_route.reverse()
        assert train["route"] == expected_route
        assert len(train["sections"]) == len(train["route"]) - 1
        assert [stop["station_id"] for stop in train["schedule"]] == train["route"]
        assert train["schedule"][0]["arr"] is None
        assert train["schedule"][-1]["dep"] is None
        for i, section_id in enumerate(train["sections"]):
            section = section_by_id[section_id]
            assert {section["a"], section["b"]} == {train["route"][i], train["route"][i + 1]}
            assert train["schedule"][i]["dep"] < train["schedule"][i + 1]["arr"]
        for stop in train["schedule"]:
            station = station_by_id[stop["station_id"]]
            track = next(track for track in station["tracks"] if track["id"] == stop["track_id"])
            assert track["length_m"] >= train["length_m"]
            if stop["arr"] is not None and stop["dep"] is not None:
                assert stop["dep"] - stop["arr"] == pytest.approx(stop["dwell_s"])
                assert stop["stop"] is (stop["dwell_s"] > 0)
        assert train["crew_shift_end"] > train["schedule"][-1]["arr"]


def test_trains_match_world_contract() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    stations, sections = _corridor()
    trains = generate_trains(stations, sections, seed=5, count=20)
    root = Path(__file__).resolve().parents[2]
    schema = json.loads((root / "contracts" / "world.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator({"$defs": schema["$defs"], "$ref": "#/$defs/TrainStaticOut"})
    for train in trains:
        validator.validate(train)


def test_rejects_invalid_inputs() -> None:
    stations, sections = _corridor()
    with pytest.raises(ValueError, match="Unknown train classes"):
        generate_trains(stations, sections, seed=1, count=20, class_shares={"alien": 1})
    with pytest.raises(ValueError, match="No section"):
        generate_trains(stations, sections[:-1], seed=1, count=20)
    with pytest.raises(ValueError, match="non-negative"):
        generate_trains(stations, sections, seed=1, count=-1)
