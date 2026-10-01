import type {
  Autonomy,
  ControlIn,
  EventIn,
  IndexHistory,
  LoadIn,
  Occupancy,
  Plan,
  PlannerInfo,
  PlannerSummary,
  Scenario,
  Traces,
} from "./types";

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
  occupancy: (which: "current" | "previous", tFrom: number, tTo: number) =>
    request<Occupancy>(`/api/occupancy?which=${which}&t_from=${tFrom}&t_to=${tTo}`),
  traces: (since: number) => request<Traces>(`/api/traces?since=${since}`),
  index: (since?: number) => request<IndexHistory>(`/api/index${since != null ? `?since=${since}` : ""}`),
  decision: (cardId: string, action: "cancel" | "choose", variantId?: string) =>
    request<{ ok: boolean; message: string }>(`/api/decisions/${encodeURIComponent(cardId)}/action`, {
      method: "POST",
      body: JSON.stringify({ action, variant_id: variantId ?? null }),
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
