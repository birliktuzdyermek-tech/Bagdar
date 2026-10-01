import type { ControlIn, EfficiencyIndex, LoadIn, Plan, Scenario } from "./types";

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
  plan: () => request<Plan>("/api/plan"),
  index: () => request<EfficiencyIndex>("/api/index"),
};
