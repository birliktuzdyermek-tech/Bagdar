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

export type HelloMsg = S["HelloMsg"];
export type StreamMsg =
  | HelloMsg
  | { type: "world"; world: World }
  | { type: "events"; reset: boolean; events: SimEvent[] }
  | State
  | { type: "pong" };
