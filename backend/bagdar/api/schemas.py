"""Типизированный контракт API (pydantic). Из него строится Swagger
(/docs) и TypeScript-типы фронтенда (frontend/src/api/schema.d.ts).

Время везде — секунды модели от 00:00 01.10.2026 (UTC+5).
Направление: +1 нечётное (от a к b по километражу), −1 чётное.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["debug", "info", "warn", "critical"]


# ----------------------------------------------------------------- мир
class TrackOut(BaseModel):
    id: str
    name: str
    length_m: int
    is_main: bool


class StationOut(BaseModel):
    id: str
    name: str
    kind: Literal["terminal", "station", "loop", "junction"]
    km: float
    x: float
    y: float
    zone_id: str
    crew_change: bool
    tracks: list[TrackOut]


class SectionOut(BaseModel):
    id: str
    a: str
    b: str
    length_km: float
    tracks: int = Field(description="1 — однопутный, 2 — двухпутный")
    signalling: Literal["AB", "PAB"]
    blocks: int
    speed_limit_kmh: float
    gradient_permille: float = Field(description="Уклон в направлении a→b, ‰; плюс — подъём")
    no_stop_uphill: bool
    electrified: bool
    throat_a: str
    throat_b: str


class SignalOut(BaseModel):
    id: str
    section_id: str
    station_id: str
    direction: int


class SwitchOut(BaseModel):
    id: str
    station_id: str
    track_id: str
    number: int


class ZoneOut(BaseModel):
    id: str
    name: str
    station_ids: list[str]


class ScheduleStopOut(BaseModel):
    station_id: str
    arr: float | None
    dep: float | None
    stop: bool
    dwell_s: float | None
    track_id: str


class TrainStaticOut(BaseModel):
    id: str
    number: str
    cls: str
    cls_label: str
    pte_rank: int = Field(description="0 — внеочередной, 1..5 — очерёдность по ПТЭ")
    direction: int
    length_m: int
    mass_t: int
    passengers: int
    cargo: list[str]
    traction: Literal["electric", "diesel"]
    vmax_kmh: float
    loco_id: str
    crew_id: str
    crew_shift_end: float | None
    route: list[str]
    sections: list[str]
    suburban: bool
    transfer: bool
    schedule: list[ScheduleStopOut]


class TrainClassOut(BaseModel):
    key: str
    label: str
    pte_rank: int
    weight: float
    tolerance_min: float


class GenerationOut(BaseModel):
    trains_total: int
    dropped: list[str]
    build_ms: float
    validated: bool


class WorldOut(BaseModel):
    id: str
    mode: str
    seed: int
    name: str
    version: int
    scenario_id: str
    start_time: float
    date: str
    tz: str
    zones: list[ZoneOut]
    stations: list[StationOut]
    sections: list[SectionOut]
    signals: list[SignalOut]
    switches: list[SwitchOut]
    trains: list[TrainStaticOut]
    classes: list[TrainClassOut]
    generation: GenerationOut


# --------------------------------------------------------------- состояние
TrainStatus = Literal["pending", "station", "section", "finished"]
TrainDisplay = Literal["ready", "dwell", "held", "terminated", "running", "braking", "stopped",
                       "pending", "finished"]


class TrainStateOut(BaseModel):
    id: str
    status: TrainStatus
    display: TrainDisplay
    k: int
    station_id: str | None
    track_id: str | None
    section_id: str | None
    progress: float | None = Field(description="Положение на перегоне 0..1 от станции a к b")
    v_kmh: float
    v_target_kmh: float
    delay_s: int
    wait_reason: str | None
    dest_track: str | None
    through: bool
    next_station_id: str | None
    crew_left_s: int
    stops: int
    unplanned_stops: int
    stop_energy_kwh: float


class SectionStateOut(BaseModel):
    id: str
    status: Literal["open", "restricted", "closed"]
    single: bool
    restriction_kmh: float | None
    occupants: list[str]
    dir: int


class TrackStateOut(BaseModel):
    id: str
    occupant: str | None
    reserved: str | None
    available: bool


class ThroatStateOut(BaseModel):
    id: str
    holder: str | None


class SignalStateOut(BaseModel):
    id: str
    state: Literal["open", "closed", "fault"]


class MetricsOut(BaseModel):
    active_trains: int
    finished_trains: int
    avg_delay_s: float
    max_delay_s: float
    on_time_share: float
    waiting_trains: int
    unplanned_stops: int
    stop_energy_kwh: float


class PerfOut(BaseModel):
    step_us: float
    tick_ms: float
    steps_per_s: float
    load_ms: float


class PlannerSummaryOut(BaseModel):
    version: int
    solver: str | None
    status: Literal["feasible", "delayed", "infeasible"] | None
    compute_ms: float | None = Field(description="Время последнего пересчёта целиком, мс")
    cpsat_ms: float | None
    cp_status: str | None
    t0: float | None
    J: float | None = Field(description="Целевая функция плана, у.е. (условные)")
    busy: bool
    pending: list[str]
    conflicts: int
    max_deviation_s: int
    reason: str | None
    late_trains: list[str]
    held: list[str]
    cards_total: int


class ConflictOut(BaseModel):
    kind: str
    resource: str
    trains: list[str]
    t: float
    in_s: int
    message: str


class StateOut(BaseModel):
    type: Literal["state"] = "state"
    run_id: str
    world_version: int
    seq: int
    tick: int
    t: float
    running: bool
    speed: float
    trains: list[TrainStateOut]
    sections: list[SectionStateOut]
    tracks: list[TrackStateOut]
    throats: list[ThroatStateOut]
    signals: list[SignalStateOut]
    metrics: MetricsOut
    perf: PerfOut
    planner: PlannerSummaryOut
    conflicts: list[ConflictOut]


# ------------------------------------------------------------------- план
class PlanLegOut(BaseModel):
    train_id: str
    k: int
    section_id: str
    from_id: str
    to_id: str
    direction: int
    dep: float
    arr: float
    track_id: str
    stop: bool


class PlanOut(BaseModel):
    version: int
    created_at: float
    solver: str
    status: Literal["feasible", "delayed", "infeasible"]
    compute_ms: float
    notes: list[str]
    cost: dict[str, float]
    horizon_end: float
    hold_all: bool
    held: list[str]
    legs: list[PlanLegOut]


class CardEffectOut(BaseModel):
    train_id: str
    number: str
    delay_plan_min: float
    delay_alt_min: float | None
    stops_plan: int
    stops_alt: int | None
    weight: float


class DecisionCardOut(BaseModel):
    id: str
    seq: int = 0
    plan_version: int
    t: float
    type: Literal["crossing", "overtake", "track", "hold", "no_plan"]
    level: Literal["A", "B", "C"] = Field(description="A — авто, B — авто с уведомлением, C — нужен выбор")
    station_id: str | None
    station: str | None
    section_id: str | None
    trains: list[str]
    action: str
    reason: str
    alternative: str
    cost_plan: float | None
    cost_alt: float | None
    delta_cost: float | None = Field(description="На сколько альтернатива хуже с учётом слоя ПТЭ (для ранжирования)")
    delta_money: float | None = Field(None, description="На сколько альтернатива дороже, у.е. (условные)")
    alt_pte_violations: int = 0
    alt_feasible: bool
    note: str | None = None
    wait_min: float | None
    effects: list[CardEffectOut]
    index_before: float | None
    index_after: float | None
    status: str
    full_auto: bool = True


class DecisionsOut(BaseModel):
    run_id: str
    cards: list[DecisionCardOut]


class CandidateOut(BaseModel):
    name: str
    ms: float
    valid: bool
    J: float | None
    J_lex: float | None
    pte_violations: int
    violations: list[str]
    held: list[str]
    deadlock: bool


class SolveStatsOut(BaseModel):
    version: int
    t0: float
    status: str
    solver: str
    reason: str
    J: dict | None
    candidates: list[CandidateOut]
    cpsat: dict
    cp_notes: list[str]
    timings: dict[str, float]
    held: list[str]
    late_trains: list[str]
    cards: int
    applied_at: float | None = None
    lag_s: float | None = None


class PlannerOut(BaseModel):
    summary: PlannerSummaryOut
    history: list[SolveStatsOut]


class EventIn(BaseModel):
    type: Literal["train_delay"]
    train_id: str | None = None
    minutes: float | None = Field(None, ge=1, le=240)
    reason: str | None = None


class EventAck(BaseModel):
    ok: bool
    message: str


# ------------------------------------------------------------------ события
class EventOut(BaseModel):
    seq: int
    t: float
    kind: str
    severity: Severity
    message: str
    train_id: str | None
    station_id: str | None
    section_id: str | None
    data: dict


class EventsOut(BaseModel):
    run_id: str
    events: list[EventOut]


# --------------------------------------------------------------- управление
class ControlIn(BaseModel):
    action: Literal["start", "pause", "speed", "step", "reset"]
    speed: float | None = Field(None, ge=1, le=100)
    step_s: float | None = Field(None, gt=0, le=3600, description="Шаг в секундах модели (по умолчанию 60)")


class ControlOut(BaseModel):
    running: bool
    speed: float
    t: float
    run_id: str


class LoadIn(BaseModel):
    scenario_id: str | None = None
    seed: int | None = Field(None, ge=0, le=2**31 - 1)


class LoadOut(BaseModel):
    world_version: int
    run_id: str
    scenario_id: str
    seed: int
    trains_total: int
    load_ms: float


class ScenarioOut(BaseModel):
    id: str
    title: str
    summary: str
    mode: str
    seed: int
    start_time: str
    difficulty: int
    wave: int
    disruptions: int


class HealthOut(BaseModel):
    status: Literal["ok"]
    version: str
    world_loaded: bool


# -------------------------------------------------------- сообщения потока
class HelloMsg(BaseModel):
    type: Literal["hello"] = "hello"
    protocol: int
    run_id: str
    world_version: int


class WorldMsg(BaseModel):
    type: Literal["world"] = "world"
    world: WorldOut


class EventsMsg(BaseModel):
    type: Literal["events"] = "events"
    reset: bool = Field(description="true — заменить ленту, false — дописать")
    events: list[EventOut]


class DecisionsMsg(BaseModel):
    type: Literal["decisions"] = "decisions"
    reset: bool
    cards: list[DecisionCardOut]


class StreamSchema(BaseModel):
    """Документация WebSocket /api/stream. Сервер шлёт hello, затем world (если версия
    мира у клиента устарела), events и state; дальше state с частотой broadcast_hz и
    events по мере появления. Переподключение: /api/stream?world_version=N&last_seq=M&run_id=R."""
    hello: HelloMsg
    world: WorldMsg
    events: EventsMsg
    state: StateOut
    decisions: DecisionsMsg
