import type {
  Autonomy,
  ControlIn,
  EventIn,
  IndexHistory,
  Incidents,
  Saturation,
  LoadIn,
  Occupancy,
  Plan,
  PlannerInfo,
  PlannerSummary,
  Scenario,
  HistoryAt,
  HistoryInfo,
  Versus,
  Settings,
  SettingsIn,
  Traces, Dashboard, WindowPlan, CrewRisks } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* тело без JSON */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  control: (body: ControlIn) => request<{ running: boolean; speed: number; t: number }>("/api/sim/control", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  load: (body: LoadIn) => request<{ world_version: number; seed: number }>("/api/sim/load", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  scenarios: () => request<Scenario[]>("/api/scenarios"),
  plan: (which: "current" | "previous" | "projected" = "current") => request<Plan>(`/api/plan?which=${which}`),
  occupancy: (which: "current" | "previous", tFrom: number, tTo: number, at?: number) =>
    request<Occupancy>(`/api/occupancy?which=${which}&t_from=${tFrom}&t_to=${tTo}${at != null ? `&at=${at}` : ""}`),
  history: () => request<HistoryInfo>("/api/history"),
  versus: (withState = true) => request<Versus>(`/api/versus?state=${withState}`),
  versusStart: (scenarioId: string, seed?: number) => request<Versus>("/api/versus/start", {
    method: "POST", body: JSON.stringify({ scenario_id: scenarioId, seed: seed ?? null }),
  }),
  versusStop: () => request<Versus>("/api/versus/stop", { method: "POST" }),
  versusHold: (trainId: string, minutes = 5) => request<{ ok: boolean; message: string }>("/api/versus/hold", {
    method: "POST", body: JSON.stringify({ train_id: trainId, minutes }),
  }),
  historyAt: (t: number) => request<HistoryAt>(`/api/history/at?t=${t}`),
  traces: (since: number) => request<Traces>(`/api/traces?since=${since}`),
  index: (since?: number) => request<IndexHistory>(`/api/index${since != null ? `?since=${since}` : ""}`),
  decision: (cardId: string, action: "cancel" | "choose", variantId?: string) =>
    request<{ ok: boolean; message: string }>(`/api/decisions/${encodeURIComponent(cardId)}/action`, {
      method: "POST",
      body: JSON.stringify({ action, variant_id: variantId ?? null }),
    }),
  incidents: () => request<Incidents>("/api/incidents"),
  restore: (id: string) => request<{ ok: boolean; message: string }>(`/api/incidents/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  }),
  saturation: () => request<Saturation>("/api/saturation"),
  settings: () => request<Settings>("/api/settings"),
  dashboard: () => request<Dashboard>("/api/dashboard"),
  window: (sectionId: string, minutes: number) => request<WindowPlan>(`/api/window?section_id=${encodeURIComponent(sectionId)}&minutes=${minutes}`),
  windowSchedule: (sectionId: string, start: number, minutes: number) => request<{ ok: boolean; message: string }>("/api/window/schedule", {
    method: "POST", body: JSON.stringify({ section_id: sectionId, start, minutes }),
  }),
  crew: () => request<CrewRisks>("/api/crew"),
  saveSettings: (body: SettingsIn) => request<Settings>("/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }),
  autonomy: (fullAuto: boolean) => request<Autonomy>("/api/autonomy", {
    method: "POST",
    body: JSON.stringify({ full_auto: fullAuto }),
  }),
  planner: () => request<PlannerInfo>("/api/planner"),
  replan: () => request<PlannerSummary>("/api/plan/replan", { method: "POST" }),
  event: (body: EventIn) => request<{ ok: boolean; message: string }>("/api/events", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
