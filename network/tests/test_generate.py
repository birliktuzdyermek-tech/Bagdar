"""Contract and graph invariants for the sourced corridor packages."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from network.generate import LINE_FILE, build_scenario, build_world, load_line
from network.preview import make_svg
from network.schedule import DEFAULT_CLASS_SHARES

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def line() -> dict:
    return load_line(LINE_FILE)


def test_source_chainage_and_coordinates(line: dict) -> None:
    assert line["length_km"] == 834
    assert len(line["stations"]) == 35
    assert sum("osm_node" in s for s in line["stations"]) == 23
    assert [s["km"] for s in line["stations"]] == sorted({s["km"] for s in line["stations"]})
    assert line["stations"][0]["name"] == "Достык"
    assert line["stations"][-1]["name"] == "Мойынты"


@pytest.mark.parametrize("variant,count,tracks", [("single", 24, 1), ("double", 120, 2)])
def test_export_world_contract_and_references(line: dict, variant: str, count: int, tracks: int) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    world = build_world(line, variant=variant, seed=42, count=count)
    schema = json.loads((ROOT / "contracts" / "world.schema.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(world)
    station_by_id = {s["id"]: s for s in world["stations"]}
    section_by_id = {s["id"]: s for s in world["sections"]}
    assert len(station_by_id) == 35
    assert len(section_by_id) == 34
    assert len(world["signals"]) == 68
    assert sum(s["length_km"] for s in world["sections"]) == pytest.approx(834)
    assert world["generation"]["trains_total"] == count
    assert world["generation"]["validated"] is False
    assert world["generation"]["build_ms"] >= 0
    assert all(section["tracks"] == tracks for section in world["sections"])
    for left, right, section in zip(world["stations"], world["stations"][1:], world["sections"]):
        assert (section["a"], section["b"]) == (left["id"], right["id"])
        assert section["length_km"] == pytest.approx(right["km"] - left["km"])
    assert len({s["id"] for s in world["signals"]}) == len(world["signals"])
    assert len({s["id"] for s in world["switches"]}) == len(world["switches"])
    for signal in world["signals"]:
        section = section_by_id[signal["section_id"]]
        assert signal["station_id"] == section["a" if signal["direction"] == 1 else "b"]
    for switch in world["switches"]:
        station = station_by_id[switch["station_id"]]
        assert switch["track_id"] in {track["id"] for track in station["tracks"][1:]}
    for train in world["trains"]:
        assert len(train["sections"]) == len(train["route"]) - 1
        assert len(train["schedule"]) == len(train["route"])
        assert train["route"][0] in station_by_id
        assert all(section_id in section_by_id for section_id in train["sections"])


def test_versions_share_railway_and_seed_is_reproducible(line: dict) -> None:
    single = build_world(line, variant="single", seed=17, count=20)
    double = build_world(line, variant="double", seed=17, count=20)
    same_seed = build_world(line, variant="single", seed=17, count=20)
    assert {k: v for k, v in single.items() if k != "generation"} == {
        k: v for k, v in same_seed.items() if k != "generation"
    }
    assert single["trains"] != build_world(line, variant="single", seed=18, count=20)["trains"]
    assert single["stations"] == double["stations"]
    assert single["trains"] == double["trains"]
    assert [(s["id"], s["a"], s["b"], s["length_km"]) for s in single["sections"]] == [
        (s["id"], s["a"], s["b"], s["length_km"]) for s in double["sections"]
    ]
    assert all({k: v for k, v in a.items() if k != "tracks"} ==
               {k: v for k, v in b.items() if k != "tracks"}
               for a, b in zip(single["sections"], double["sections"]))
    assert "Схема по открытым данным" in make_svg(single, double)


def test_export_scenario_contract(line: dict) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    world = build_world(line, variant="single", seed=42, count=24)
    scenario = build_scenario(world, variant="single", count=24)
    schema = json.loads((ROOT / "contracts" / "scenario.schema.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(scenario)
    assert scenario["seed"] == world["seed"]
    assert scenario["world"]["file"] == "world.single.json"
    assert scenario["traffic"]["class_shares"] == DEFAULT_CLASS_SHARES
