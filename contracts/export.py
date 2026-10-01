"""Export version 1 contracts and a real, short run of the light simulator.

Run from the repository root with the backend dependencies installed:
    python contracts/export.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml
from typing import Literal
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from bagdar.api.schemas import (ConflictOut, DecisionCardOut, EventOut, IncidentOut, PlanOut,  # noqa: E402
                                PlannerSummaryOut, StateOut, VersusScoreOut, WorldOut)
from bagdar.config import load_config  # noqa: E402
from bagdar.dto import plan_dto  # noqa: E402
from bagdar.runtime import SimulationRuntime  # noqa: E402
from bagdar.scenarios import Scenario, load_scenarios  # noqa: E402


class IndexSnapshot(BaseModel):
    value: float = Field(ge=0, le=100)
    factors: dict[str, float] = Field(description="Measured factor scores, each between 0 and 1")
    status: str = Field(description="normal, warning or critical")


class ReplayStateOut(StateOut):
    # Fields introduced by the planner are optional in the file format so
    # recordings exported by the first version remain readable.
    planner: PlannerSummaryOut | None = None
    conflicts: list[ConflictOut] = Field(default_factory=list)


class ReplayPlanOut(PlanOut):
    horizon_end: float | None = None
    hold_all: bool = False
    held: list[str] = Field(default_factory=list)


class ReplayFrame(BaseModel):
    t: float = Field(description="Model seconds at this complete state snapshot")
    state: ReplayStateOut
    index: IndexSnapshot | None = Field(description="Measured index at this time; null until the index calculator exists")


class ReplayPlan(BaseModel):
    t: float = Field(description="Model seconds from which this plan applies")
    plan: ReplayPlanOut


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
    # Optional fields added after the first export; old files stay valid.
    variant: Literal["bagdar", "no_plan"] = Field(
        "bagdar", description="bagdar: planner on; no_plan: same flow without a plan, resources first come first served")
    pair: str | None = Field(None, description="Id of the paired run of the same flow (with / without Bağdar)")
    cards: list[DecisionCardOut] = Field(default_factory=list, description="Decision cards with reasons and prices")
    incidents: list[IncidentOut] = Field(default_factory=list, description="Disruptions with before/after report")
    summary: VersusScoreOut | None = Field(None, description="Final score of the run, same rules for both variants")


# Модели наследуют схемы Ядра со ссылками вперёд (from __future__ import annotations):
# достраиваем их в пространстве имён bagdar.api.schemas, где определены все типы.
import bagdar.api.schemas as _core_schemas  # noqa: E402

for _model in (IndexSnapshot, ReplayStateOut, ReplayPlanOut, ReplayFrame, ReplayPlan, Replay):
    _model.model_rebuild(_types_namespace=vars(_core_schemas))


def index_snapshot(current: dict | None) -> dict | None:
    """Index of the core in the replay frame format (status: normal, warning, critical)."""
    if not current or current.get("value") is None:
        return None
    status = {"norm": "normal"}.get(current["status"], current["status"])
    return {"value": round(current["value"], 1), "status": status,
            "factors": {f["key"]: round(f["score"], 3) for f in current["factors"] if f.get("score") is not None}}


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
