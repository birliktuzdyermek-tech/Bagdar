"""Export version 1 contracts and a real, short run of the light simulator.

Run from the repository root with the backend dependencies installed:
    python contracts/export.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from bagdar.api.schemas import EventOut, PlanOut, StateOut, WorldOut  # noqa: E402
from bagdar.config import load_config  # noqa: E402
from bagdar.dto import plan_dto  # noqa: E402
from bagdar.runtime import SimulationRuntime  # noqa: E402
from bagdar.scenarios import Scenario, load_scenarios  # noqa: E402


class IndexSnapshot(BaseModel):
    value: float = Field(ge=0, le=100)
    factors: dict[str, float] = Field(description="Measured factor scores, each between 0 and 1")
    status: str = Field(description="normal, warning or critical")


class ReplayFrame(BaseModel):
    t: float = Field(description="Model seconds at this complete state snapshot")
    state: StateOut
    index: IndexSnapshot | None = Field(description="Measured index at this time; null until the index calculator exists")


class ReplayPlan(BaseModel):
    t: float = Field(description="Model seconds from which this plan applies")
    plan: PlanOut


class Replay(BaseModel):
    schema_version: int = Field(1, description="Contract format version, currently 1")
    world: WorldOut
    scenario: Scenario
    run_id: str
    started_at: float
    ended_at: float
    frame_interval_s: float
    plans: list[ReplayPlan]
    frames: list[ReplayFrame]
    events: list[EventOut]


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    out = ROOT / "contracts"
    write_json(out / "world.schema.json", WorldOut.model_json_schema())
    write_json(out / "scenario.schema.json", Scenario.model_json_schema())
    write_json(out / "replay.schema.json", Replay.model_json_schema())

    runtime = SimulationRuntime(load_config(), load_scenarios())
    runtime.load("normal", 42)
    assert runtime.engine is not None and runtime.scenario is not None
    assert runtime.world is not None and runtime.plan is not None
    assert runtime.generation["validated"]

    world = runtime.world_payload()
    scenario = runtime.scenario.model_dump(mode="json")
    frames = [{"t": runtime.engine.t, "state": runtime.state_payload(), "index": None}]
    plans = [{"t": runtime.engine.t, "plan": plan_dto(runtime.plan)}]
    events = runtime.events_since(0)

    # 10-second complete snapshots over two model minutes. These are real
    # Engine steps, not invented coordinates or an API mock.
    for _ in range(12):
        runtime._advance_steps(round(10 / runtime.engine.dt))
        runtime._flush_events()
        frames.append({"t": runtime.engine.t, "state": runtime.state_payload(), "index": None})
        events.extend(runtime.events_since(events[-1]["seq"] if events else 0))

    replay = {
        "schema_version": 1,
        "world": world,
        "scenario": scenario,
        "run_id": runtime.run_id,
        "started_at": frames[0]["t"],
        "ended_at": frames[-1]["t"],
        "frame_interval_s": 10,
        "plans": plans,
        "frames": frames,
        "events": events,
    }

    WorldOut.model_validate(world)
    Scenario.model_validate(scenario)
    Replay.model_validate(replay)
    write_json(out / "examples" / "world.light.json", world)
    write_json(out / "examples" / "scenario.light.json", scenario)
    write_json(out / "examples" / "replay.light.json", replay)
    print(f"Exported {len(frames)} real frames, {len(events)} events, {len(world['trains'])} trains")


if __name__ == "__main__":
    main()
