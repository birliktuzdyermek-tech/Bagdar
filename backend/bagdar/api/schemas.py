"""Типизированный контракт API (pydantic). Из него строится Swagger
(/docs) и TypeScript-типы фронтенда (frontend/src/api/schema.d.ts).

Время везде — секунды модели от 00:00 01.10.2026 (UTC+5).
Направление: +1 нечётное (от a к b по километражу), −1 чётное.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field
from bagdar.config import IndexThresholds, IndexWeights, TariffConfig

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


class SpeedAdviceOut(BaseModel):
    """Совет машинисту на ближайшем перегоне. Модель относительная, не тяговый расчёт."""
    v_rec_kmh: int = Field(description="Рекомендуемая скорость, не выше лимита")
    v_full_kmh: int = Field(description="Полный ход — лимит перегона с учётом ограничений")
    v_limit_kmh: int
    e_full_kwh: float = Field(description="Условный расход на полном ходу: ход + остановка у входного, кВт·ч")
    e_rec_kwh: float = Field(description="Условный расход по совету, кВт·ч")
    saving_kwh: float
    saving_pct: float
    stop_avoided: bool = Field(description="Совет избавляет от остановки у входного светофора")
    wait_full_s: int = Field(description="Сколько поезд простоял бы, придя на полном ходу")
    text: str


class AdviceSummaryOut(BaseModel):
    trains: int
    slowed: int = Field(description="Скольким поездам советуется ехать медленнее лимита")
    stops_avoided: int
    saving_kwh: float


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
    advice: SpeedAdviceOut | None = Field(None, description="Совет машинисту (только на перегоне)")


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


class ActionOut(BaseModel):
    card_id: str
    kind: Literal["cancel", "choose"]
    left_s: float | None = Field(description="Сколько реальных секунд осталось; null — ждёт выбора без таймера")


class RecoveryOut(BaseModel):
    affected: int = Field(description="Поездов, которые по плану выйдут за допуск по опозданию")
    affected_ids: list[str]
    late_now: int = Field(description="Поездов вне допуска прямо сейчас")
    recovery_at: float | None = Field(description="Когда восстановятся поезда, восстанавливающиеся на горизонте")
    beyond_horizon: int = Field(description="Задетых поездов, не восстанавливающихся на горизонте плана")


class ForecastOut(BaseModel):
    value: float | None
    status: str
    status_label: str


class PlannerSummaryOut(BaseModel):
    version: int
    applied_version: int = Field(description="Версия плана, который сейчас исполняется")
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
    full_auto: bool
    awaiting_choice: bool = Field(description="План ждёт выбора диспетчера по карточке C")
    actions: list[ActionOut] = Field(description="Открытые окна: отмена B, выбор C")
    overrides: int = Field(description="Действующих решений диспетчера, которые план обязан соблюдать")
    recovery: RecoveryOut | None
    forecast: ForecastOut | None = Field(description="Прогноз индекса по действующему плану на час вперёд")


class IndexFactorOut(BaseModel):
    key: Literal["throughput", "punctuality", "track_load", "resource_idle", "conflicts"]
    label: str
    weight: float = Field(description="Вес из конфига")
    weight_eff: float = Field(description="Вес после перенормировки по факторам с данными")
    score: float | None = Field(description="s_k от 0 до 1; null — нет данных")
    available: bool
    value_text: str
    note: str
    lost: float = Field(description="Сколько пунктов индекса теряется на этом факторе")


class IndexOut(BaseModel):
    t: float | None
    value: float | None = Field(description="0–100; null — нет данных ни по одному фактору")
    status: Literal["norm", "warning", "critical", "no_data"]
    status_label: str
    factors: list[IndexFactorOut]
    reasons: list[str] = Field(description="Что сильнее всего тянет индекс вниз")
    missing: list[str]


class IndexPointOut(BaseModel):
    t: float
    value: float | None
    status: str
    f: dict[str, float | None]


class IndexHistoryOut(BaseModel):
    current: IndexOut | None
    forecast: IndexOut | None = Field(description="Индекс по действующему плану на час вперёд")
    history: list[IndexPointOut]


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
    advice: AdviceSummaryOut | None = Field(None, description="Советы скорости по всем поездам на перегонах")
    sections: list[SectionStateOut]
    tracks: list[TrackStateOut]
    throats: list[ThroatStateOut]
    signals: list[SignalStateOut]
    metrics: MetricsOut
    perf: PerfOut
    planner: PlannerSummaryOut
    conflicts: list[ConflictOut]
    index: IndexOut | None
    incidents: list[IncidentActiveOut] = Field(description="Действующие сбои")
    radar: RadarOut | None = Field(None, description="Радар насыщения: тренд и прогноз, когда участок перестанет справляться")
    scenario_next: dict | None = Field(description="Ближайшее событие сценария {t, kind}")


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


class CardImpactOut(BaseModel):
    """Влияние решения: «план» — с решением, «alt» — с альтернативой (прогноз на час, у.е. условные)."""
    delay_min_plan: float
    delay_min_alt: float | None
    energy_kwh_plan: float
    energy_kwh_alt: float | None
    track_load_pct_plan: float
    track_load_pct_alt: float | None
    idle_pct_plan: float | None
    idle_pct_alt: float | None


class VariantOut(BaseModel):
    id: str
    title: str
    solver: str
    valid: bool
    J: float
    J_lex: float
    delta_money: float | None = Field(description="Дороже рекомендации на, у.е.")
    pte_violations: int
    late_pax: int = Field(description="Пассажирских сверх допуска в этом варианте")
    note: str


class DecisionCardOut(BaseModel):
    id: str
    seq: int = 0
    plan_version: int
    t: float
    type: Literal["crossing", "overtake", "track", "hold", "no_plan", "incident"]
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
    alt_reliable: bool = Field(True, description="false — быстрая модель не воспроизводит план, цена альтернативы не оценена")
    note: str | None = None
    wait_min: float | None
    effects: list[CardEffectOut]
    index_before: float | None = Field(description="Прогноз индекса на час с альтернативой")
    index_after: float | None = Field(description="Прогноз индекса на час с решением")
    status: Literal["applied", "pending", "proposed", "cancelled", "chosen", "expired", "superseded"]
    full_auto: bool = True
    impact: CardImpactOut | None = None
    variants: list[VariantOut] = []
    chosen_variant: str | None = None
    choice_card: str | None = Field(None, description="Карточка, где делается выбор за весь пересчёт")
    outcome: str | None = None
    can_cancel: bool = False
    can_choose: bool = False
    incident_id: str | None = Field(None, description="Карточка-разбор инцидента «до / после»")
    report: dict | None = Field(None, description="Разбор инцидента: before, plan, no_change, fifo, tree")


class DecisionsOut(BaseModel):
    run_id: str
    cards: list[DecisionCardOut]


class DecisionActionIn(BaseModel):
    action: Literal["cancel", "choose"]
    variant_id: str | None = None


class ActionResultOut(BaseModel):
    ok: bool
    message: str


class AutonomyIn(BaseModel):
    full_auto: bool


# ------------------------------------------------------- график и Гант
class TraceOut(BaseModel):
    train_id: str
    points: list[list[float]] = Field(description="[[t, км], ...] — факт движения")


class TracesOut(BaseModel):
    t: float
    traces: list[TraceOut]


class BusyOut(BaseModel):
    resource: str = Field(description="Путь станции или перегон")
    train_id: str
    t0: float
    t1: float
    kind: Literal["stand", "pass", "section", "hold", "blocked"]
    source: Literal["fact", "plan", "fault"]
    changed: bool = Field(description="Интервал отличается в другом плане (до/после)")


class OccupancyOut(BaseModel):
    which: Literal["current", "previous"]
    plan_version: int | None
    t: float
    items: list[BusyOut]


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


EventKind = Literal["train_delay", "section_closed", "signal_fault", "track_unavailable", "switch_fault",
                    "speed_restriction", "add_trains", "extra_train", "hold_at_origin"]


class NewTrainIn(BaseModel):
    cls: str = "freight"
    direction: int = 1
    in_min: float | None = Field(None, ge=0, le=600, description="Отправление через N мин модели")
    dep: str | None = Field(None, description="Или время отправления «ЧЧ:ММ»")
    length_m: int | None = None
    mass_t: int | None = None
    from_idx: int | None = None
    to_idx: int | None = None


class EventIn(BaseModel):
    """Внешнее событие или сбой. Какие поля нужны — зависит от type."""
    type: EventKind
    train_id: str | None = Field(None, description="train_delay: поезд")
    train_class: str | None = Field(None, description="train_delay: или класс поезда (выбирается первый на участке)")
    minutes: float | None = Field(None, ge=1, le=1440, description="Задержка или длительность сбоя; нет — неизвестно")
    section_id: str | None = Field(None, description="section_closed, signal_fault, speed_restriction")
    track_id: str | None = Field(None, description="track_unavailable, switch_fault")
    station_id: str | None = Field(None, description="switch_fault: станция (берётся боковой путь)")
    direction: int | None = Field(None, description="signal_fault: одно направление; extra_train: направление")
    kmh: float | None = Field(None, ge=5, le=200, description="speed_restriction")
    count: int | None = Field(None, ge=1, le=60, description="add_trains: сколько поездов")
    within_min: float | None = Field(None, ge=1, le=600, description="add_trains: за сколько минут")
    in_min: float | None = Field(None, ge=0, le=600, description="extra_train: отправление через N мин")
    trains: list[NewTrainIn] | None = Field(None, description="add_trains: явный список поездов")
    train_ids: list[str] | None = Field(None, description="hold_at_origin: какие поезда придержать")
    reason: str | None = None


class RadarOut(BaseModel):
    status: Literal["no_data", "ok", "warning", "critical"]
    eta_s: float | None = Field(description="Через сколько секунд модели участок перестанет справляться")
    text: str
    delay_slope_min_h: float | None
    load_slope_pct_h: float | None
    queue: int
    delay_now_min: float | None = None
    load_now_pct: float | None = None


class MeterOptionOut(BaseModel):
    id: str
    hold: int
    train_ids: list[str]
    numbers: list[str]
    minutes: int
    J: float
    J_lex: float
    stuck: int
    avg_late_min: float
    title: str


class SaturationOut(BaseModel):
    radar: RadarOut | None
    t: float
    horizon_h: int
    options: list[MeterOptionOut]
    best: str | None


class IncidentSummaryOut(BaseModel):
    J: float | None
    J_lex: float | None = None
    delay_min: float | None
    affected: int = Field(description="Задето волной: прибытие позже, чем в плане до события, на 2 мин и больше")
    delay_add_min: float | None = Field(None, description="Сколько поездо-минут добавила волна")
    late_trains: int | None = Field(None, description="Поездов сверх допуска по опозданию")
    recovery_at: float | None
    beyond: int
    forecast: float | None
    pte: int = 0
    plan_version: int | None = None
    solver: str | None = None
    status: str | None = None
    compute_ms: int | None = None
    stuck: int = Field(0, description="Поездов, которых план бросил посреди горизонта (одно правило для всех планов)")
    valid: bool | None = None
    why: str | None = None
    deadlock: bool | None = None
    same: bool | None = Field(None, description="fifo: опубликован порядок «кто первый пришёл» (с защитой от замка)")
    tree: dict | None = None


class DelayTreeOut(BaseModel):
    root: str
    affected: int
    total_wait_min: float
    tree: dict = Field(description="{train_id, number, wait_s, station, children[]}")


class IncidentAfterOut(BaseModel):
    plan: IncidentSummaryOut
    no_change: IncidentSummaryOut | None = Field(description="Если не менять порядок поездов (прежний план)")
    fifo: IncidentSummaryOut | None = Field(description="«Кто первый пришёл, тот первый едет»")
    tree: DelayTreeOut | None = Field(description="Дерево распространения задержки (для опозданий)")


class IncidentOut(BaseModel):
    id: str
    t: float
    kind: EventKind
    level: Literal["A", "B", "C"]
    title: str
    params: dict
    source: Literal["dispatcher", "scenario"]
    resource: str | None
    station_id: str | None
    section_id: str | None
    train_ids: list[str]
    until: float | None
    status: Literal["active", "resolved", "done"]
    resolved_at: float | None
    before: dict | None = Field(description="Состояние в момент сбоя: индекс, прогноз, задето, конфликты плана")
    after: IncidentAfterOut | None
    card_id: str | None


class IncidentActiveOut(BaseModel):
    id: str
    kind: EventKind
    level: Literal["A", "B", "C"]
    title: str
    resource: str | None
    section_id: str | None
    station_id: str | None
    until: float | None
    t: float
    restorable: bool


class IncidentsOut(BaseModel):
    run_id: str
    incidents: list[IncidentOut]
    timeline: list[dict] = Field(description="Запланированные события сценария и таймеры восстановления")


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


class ScenarioEventOut(BaseModel):
    at: str
    type: str
    label: str


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
    situation: int | None = None
    plain: str = Field("", description="Что вы увидите — простыми словами")
    events: list[ScenarioEventOut] = Field(default_factory=list)


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


# ------------------------------------------------------------------ настройки
class SettingsOut(BaseModel):
    weights: IndexWeights
    thresholds: IndexThresholds
    pte_strict: bool
    tariffs: TariffConfig


class SettingsIn(BaseModel):
    """Всё необязательно: меняется только переданное. Индекс пересчитывается сразу."""
    weights: IndexWeights | None = None
    thresholds: IndexThresholds | None = None
    pte_strict: bool | None = None
    tariffs: TariffConfig | None = None
    reset: bool = Field(False, description="Вернуть значения из YAML-конфига")


# ------------------------------------------------------------------ журнал и перемотка
class HistoryMarkOut(BaseModel):
    t: float
    kind: str
    severity: Severity
    message: str


class HistoryWindowOut(BaseModel):
    from_: float = Field(alias="from")
    to: float

    model_config = {"populate_by_name": True}


class HistoryOut(BaseModel):
    path: str = Field(description="Где лежит журнал SQLite (:memory: — в памяти процесса)")
    run_id: str
    events: int
    snapshots: int
    plans: int
    memory_snapshots: int
    window: HistoryWindowOut | None = Field(description="Интервал, доступный для перемотки, секунды модели")
    marks: list[HistoryMarkOut] = Field(description="Важные события для меток на шкале")


class HistoryAtOut(BaseModel):
    t: float = Field(description="Время снимка (последний не позже запрошенного)")
    state: StateOut
    plan: PlanOut | None
    events: list[EventOut]
    cards: list[DecisionCardOut]
    index_history: list[IndexPointOut]


# ------------------------------------------------------------------ человек против Бағдара
class VersusStartIn(BaseModel):
    scenario_id: str | None = None
    seed: int | None = None


class VersusHoldIn(BaseModel):
    train_id: str
    minutes: float = Field(5, ge=1, le=60)


class VersusScoreOut(BaseModel):
    delay_pax_min: float
    delay_freight_min: float
    delay_min: float = Field(description="Накопленная задержка, поездо-минуты")
    late_trains: int = Field(description="Поездов с опозданием 5 мин и больше")
    idle_h: float = Field(description="Простой сверх графика, поездо-часы")
    energy_kwh: float = Field(description="Энергия неплановых остановок, кВт·ч (условно)")
    unplanned_stops: int
    frozen: int = Field(description="Поездов, которые стоят на месте час и дольше")
    frozen_numbers: list[str]
    passages: int = Field(description="Проследований станций с начала прогона")
    finished: int
    money: dict[str, float] = Field(description="Условные деньги по статьям, у.е.")
    money_total: float
    index: float | None
    index_status: str | None


class VersusSideOut(BaseModel):
    title: str
    score: VersusScoreOut
    state: StateOut | None = None


class VersusOut(BaseModel):
    active: bool
    scenario_id: str | None = None
    scenario: str | None = None
    t: float | None = None
    running: bool | None = None
    speed: float | None = None
    left: VersusSideOut | None = None
    right: VersusSideOut | None = None
    diff: dict[str, float] | None = Field(None, description="Разница в пользу Бағдара (слева минус справа)")
    actions: list[dict] = Field(default_factory=list, description="Решения человека-диспетчера слева")



# ------------------------------------------------------------------ «Кто первым?»
class MeetPaxIn(BaseModel):
    cls: Literal["high_speed_passenger", "fast_passenger", "passenger"] = "fast_passenger"
    passengers: int = Field(600, ge=0, le=1500)
    delay_min: float = Field(0, ge=0, le=180, description="Уже опаздывает, мин")
    slack_min: float = Field(3, ge=0, le=60, description="Запас по графику до конечной, мин")
    dwell_min: float = Field(0, ge=0, le=20, description="Плановая стоянка на станции А, 0 — без остановки")
    transfer: bool = False
    trip_left_h: float = Field(3, ge=0.5, le=24)


class MeetFreightIn(BaseModel):
    cls: Literal["express_freight", "freight", "local_freight"] = "freight"
    mass_t: float = Field(5000, ge=500, le=9000)
    cargo: list[Literal["urgent", "perishable", "deadline", "dangerous"]] = Field(default_factory=list)
    delay_min: float = Field(0, ge=0, le=600)
    slack_min: float = Field(20, ge=0, le=180)
    uphill: bool = Field(False, description="Станция Б для грузового на подъёме")
    crew_left_h: float = Field(6, ge=0.5, le=12)
    trip_left_h: float = Field(4, ge=0.5, le=48)


class MeetIn(BaseModel):
    section_km: float = Field(12, ge=4, le=40)
    speed_limit_kmh: float = Field(100, ge=40, le=160)
    gap_min: float = Field(0, ge=-20, le=20, description="> 0 — пассажирский подходит к А позже, чем грузовой к Б")
    pax: MeetPaxIn = MeetPaxIn()
    freight: MeetFreightIn = MeetFreightIn()
    pte_strict: bool | None = Field(None, description="Строгий ПТЭ; не задан — как в настройках сервера")


class MeetSegOut(BaseModel):
    t0: float
    t1: float
    x0: float
    x1: float
    v0: float
    v1: float


class MeetSideOut(BaseModel):
    stopped: bool
    planned_stop: bool
    arr: float
    dep: float
    wait_s: float
    extra_s: float = Field(description="Насколько позже приходит на дальнюю станцию, чем без встречи")
    late_s: float = Field(description="Добавленное опоздание на конечной сверх запаса")
    arr_far: float


class MeetOptionOut(BaseModel):
    id: Literal["pax_first", "freight_first"]
    yield_: Literal["pax", "freight"] = Field(alias="yield")
    motion: dict[str, list[MeetSegOut]]
    pax: MeetSideOut
    freight: MeetSideOut
    kwh: dict[str, float]
    cost: dict[str, float]
    econ: float = Field(description="Цена без штрафа ПТЭ, у.е.")
    total: float = Field(description="Цена со штрафом ПТЭ — по ней Бағдар выбирает")
    pte_excess_min: float
    pax_person_min: float
    freight_ton_h: float
    end_t: float

    model_config = {"populate_by_name": True}


class MeetTrainOut(BaseModel):
    cls: str
    label: str
    length_m: float
    mass_t: float
    v_kmh: float
    passengers: int | None = None
    pte_rank: int
    weight: float = Field(description="Вес минуты задержки, у.е./мин")
    factors: list[tuple[str, float]]
    base_weight: float
    tolerance_min: float
    stop_kwh: float
    brake_s: float
    accel_s: float


class MeetOut(BaseModel):
    params: MeetIn
    geometry: dict[str, float]
    trains: dict[str, MeetTrainOut]
    options: list[MeetOptionOut]
    winner: Literal["pax_first", "freight_first"]
    econ_winner: Literal["pax_first", "freight_first"]
    saving: float
    econ_saving: float
    constants: dict[str, float | bool]
