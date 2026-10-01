// Типы формата replay, контракт v1 (contracts/replay.schema.json).
// Здесь только поля, которые читает Витрина. Новые необязательные поля
// контракта не ломают чтение: неизвестное просто игнорируется.

export interface Track { id: string; name: string; length_m: number; is_main: boolean }
export interface Station {
  id: string; name: string; kind: string; km: number; x: number; y: number;
  zone_id?: string | null; crew_change?: boolean; tracks: Track[];
}
export interface Section {
  id: string; a: string; b: string; length_km: number; tracks: number; signalling: string;
  blocks?: number; speed_limit_kmh: number; gradient_permille?: number; electrified?: boolean;
}
export interface ScheduleStop { station_id: string; arr: number | null; dep: number | null; stop: boolean; track_id?: string | null }
export interface TrainStatic {
  id: string; number: string; cls: string; cls_label: string; pte_rank: number; direction: number;
  length_m: number; mass_t: number; passengers: number; cargo: string[]; vmax_kmh: number;
  route: string[]; sections: string[]; schedule: ScheduleStop[];
}
export interface TrainClass { key: string; label: string; pte_rank: number; weight: number; tolerance_min: number }
export interface World {
  id: string; mode: string; seed: number; name: string; start_time: number;
  stations: Station[]; sections: Section[]; trains: TrainStatic[]; classes: TrainClass[];
}
export interface Scenario { id: string; title: string; summary: string; mode: string; seed: number; difficulty?: number }

export interface TrainState {
  id: string; status: string; display: string; k: number;
  station_id: string | null; track_id: string | null; section_id: string | null; progress: number | null;
  v_kmh: number; delay_s: number; wait_reason: string | null; next_station_id: string | null;
  stops: number; unplanned_stops: number; stop_energy_kwh: number;
}
export interface SectionState { id: string; status: string; single: boolean; restriction_kmh: number | null; occupants: string[] }
export interface TrackState { id: string; occupant: string | null; reserved: string | null; available: boolean }
export interface Metrics {
  active_trains: number; finished_trains: number; avg_delay_s: number; max_delay_s: number;
  on_time_share: number; waiting_trains: number; unplanned_stops: number; stop_energy_kwh: number;
}
export interface PlannerSummary {
  version: number; solver: string | null; status: string | null; compute_ms: number | null;
  J: number | null; conflicts: number; reason: string | null; held: string[]; cards_total: number;
}
export interface State {
  t: number; trains: TrainState[]; sections: SectionState[]; tracks: TrackState[];
  metrics: Metrics; planner?: PlannerSummary | null;
}
export interface IndexSnapshot { value: number; factors: Record<string, number>; status: string }
export interface Frame { t: number; state: State; index: IndexSnapshot | null }

export interface PlanLeg {
  train_id: string; k: number; section_id: string; from_id: string; to_id: string;
  direction: number; dep: number; arr: number; track_id: string | null; stop: boolean;
}
export interface Plan { version: number; solver: string; status: string; compute_ms: number; legs: PlanLeg[] }
export interface PlanEntry { t: number; plan: Plan }

export interface SimEvent {
  seq: number; t: number; kind: string; severity: "debug" | "info" | "warn" | "critical"; message: string;
  train_id: string | null; station_id: string | null; section_id: string | null; data: Record<string, unknown>;
}

/** Карточка решения Ядра: что сделано, почему, альтернатива и её цена (у. е.). */
export interface DecisionCard {
  id: string; t: number; type: string; level: string; action: string; reason: string; alternative: string;
  cost_plan: number | null; cost_alt: number | null; delta_money: number | null; alt_feasible?: boolean;
  trains: string[]; station_id: string | null; section_id: string | null; status?: string;
  report?: IncidentReport | null; incident_id?: string | null;
}
export interface IncidentSummary {
  J: number | null; J_lex?: number | null; affected: number; delay_add_min?: number | null; late_trains?: number | null;
  recovery_at: number | null; beyond: number; forecast: number | null; pte: number; stuck?: number;
  compute_ms?: number | null; solver?: string | null; valid?: boolean | null; deadlock?: boolean | null;
}
export interface IncidentReport { before?: Record<string, unknown> | null; plan: IncidentSummary; no_change?: IncidentSummary | null; fifo?: IncidentSummary | null }
export interface Incident {
  id: string; t: number; kind: string; level: string; title: string; until: number | null; status: string;
  after?: IncidentReport | null; section_id?: string | null; station_id?: string | null;
}
/** Итоговый счёт прогона: одинаковые правила для «с Бағдаром» и «без». */
export interface RunSummary {
  delay_min: number; delay_pax_min?: number; delay_freight_min?: number; late_trains: number; idle_h: number;
  energy_kwh: number; frozen: number; frozen_numbers?: string[]; passages: number; money_total: number;
  index: number | null; index_status?: string | null;
}

export interface Replay {
  schema_version: number; world: World; scenario: Scenario; run_id: string;
  started_at: number; ended_at: number; frame_interval_s: number;
  plans: PlanEntry[]; frames: Frame[]; events: SimEvent[];
  // необязательные поля контракта v1 (появились позже, старые записи их не содержат)
  variant?: "bagdar" | "no_plan"; pair?: string | null; cards?: DecisionCard[]; incidents?: Incident[];
  summary?: RunSummary | null;
}

/** Строка из public/runs/index.json — список записей, которые знает витрина. */
export interface RunInfo {
  id: string; file: string; title: string; situation: number | null; scenario_id: string;
  seed: number; mode: string; from: string; to: string;
  injected?: { at: string; train_id: string; minutes: number; reason: string }[];
  note?: string;
  variant?: "bagdar" | "no_plan"; pair?: string | null; summary?: Partial<RunSummary>; incidents?: string[];
}
