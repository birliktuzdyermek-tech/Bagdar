// Типы контракта берутся из OpenAPI backend (npm run gen:types), здесь только алиасы.
import type { components } from "./schema";

type S = components["schemas"];

export type World = S["WorldOut"];
export type Station = S["StationOut"];
export type Track = S["TrackOut"];
export type Section = S["SectionOut"];
export type Signal = S["SignalOut"];
export type TrainStatic = S["TrainStaticOut"];
export type TrainClass = S["TrainClassOut"];
export type State = S["StateOut"];
export type TrainState = S["TrainStateOut"];
export type SectionState = S["SectionStateOut"];
export type TrackState = S["TrackStateOut"];
export type Metrics = S["MetricsOut"];
export type SimEvent = S["EventOut"];
export type Scenario = S["ScenarioOut"];
export type Plan = S["PlanOut"];
export type ControlIn = S["ControlIn"];
export type LoadIn = S["LoadIn"];
export type DecisionCard = S["DecisionCardOut"];
export type PlannerSummary = S["PlannerSummaryOut"];
export type Conflict = S["ConflictOut"];
export type PlannerInfo = S["PlannerOut"];
export type EventIn = S["EventIn"];
export type IndexState = S["IndexOut"];
export type IndexFactor = S["IndexFactorOut"];
export type IndexPoint = S["IndexPointOut"];
export type IndexHistory = S["IndexHistoryOut"];
export type Variant = S["VariantOut"];
export type CardImpact = S["CardImpactOut"];
export type Recovery = S["RecoveryOut"];
export type Traces = S["TracesOut"];
export type Occupancy = S["OccupancyOut"];
export type Busy = S["BusyOut"];
export type Autonomy = S["AutonomyConfig"];
export type IncidentActive = S["IncidentActiveOut"];
export type Incident = S["IncidentOut"];
export type Incidents = S["IncidentsOut"];
export type Radar = S["RadarOut"];
export type Saturation = S["SaturationOut"];
export type MeterOption = S["MeterOptionOut"];
export type SpeedAdvice = S["SpeedAdviceOut"];
export type HistoryInfo = S["HistoryOut"];
export type HistoryAt = S["HistoryAtOut"];
export type Versus = S["VersusOut"];
export type VersusScore = S["VersusScoreOut"];
export type Settings = S["SettingsOut"];
export type SettingsIn = S["SettingsIn"];

export type HelloMsg = S["HelloMsg"];
export type StreamMsg =
  | HelloMsg
  | { type: "world"; world: World }
  | { type: "events"; reset: boolean; events: SimEvent[] }
  | { type: "decisions"; reset: boolean; cards: DecisionCard[] }
  | State
  | { type: "pong" };
export type Dashboard = S["DashboardOut"];
export type WindowPlan = S["WindowOut"];
export type CrewRisks = S["CrewOut"];
