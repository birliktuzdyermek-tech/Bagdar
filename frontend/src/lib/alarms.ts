// Бюджет тревог: на экране одновременно не больше трёх красных элементов.
// Все проблемы ранжируются по цене; красными становятся только три самые
// дорогие, остальные получают оранжевый цвет и уходят в счётчик.
import { useMemo } from "react";
import type { State, World } from "../api/types";
import { useSim, type Indexed } from "../store/sim";

export const RED_BUDGET = 3;

export interface Alarm {
  key: string;
  kind: "delay" | "signal" | "section" | "track" | "plan" | "index";
  score: number;
  label: string;
  trainId?: string;
  sectionId?: string;
  stationId?: string;
}

export interface AlarmView {
  all: Alarm[];
  red: Set<string>;
}

export function computeAlarms(world: World | null, idx: Indexed | null, state: State | null): AlarmView {
  const all: Alarm[] = [];
  if (!world || !idx || !state) return { all, red: new Set() };
  const cls = new Map(world.classes.map((c) => [c.key, c]));
  for (const ts of state.trains) {
    const tr = idx.trains.get(ts.id);
    if (!tr) continue;
    const c = cls.get(tr.cls);
    const tol = (c?.tolerance_min ?? 30) * 60;
    if (ts.delay_s >= tol && ts.delay_s >= 60) {
      all.push({
        key: `train:${ts.id}`,
        kind: "delay",
        score: (c?.weight ?? 10) * (ts.delay_s / 60) * Math.max(1, tr.passengers / 500),
        label: `Поезд ${tr.number}: опоздание ${Math.round(ts.delay_s / 60)} мин при допуске ${Math.round(tol / 60)}`,
        trainId: ts.id,
      });
    }
  }
  for (const sec of state.sections) {
    if (sec.status === "closed") {
      all.push({ key: `section:${sec.id}`, kind: "section", score: 5000, label: `Перегон ${sec.id} закрыт`, sectionId: sec.id });
    }
  }
  for (const sig of state.signals) {
    if (sig.state === "fault") {
      all.push({ key: `signal:${sig.id}`, kind: "signal", score: 1500, label: `Неисправен светофор ${sig.id}` });
    }
  }
  for (const tr of state.tracks) {
    if (!tr.available) {
      all.push({ key: `track:${tr.id}`, kind: "track", score: 800, label: `Путь ${tr.id} недоступен` });
    }
  }
  // сводные тревоги: план не найден и индекс «Критично» — дороже любой одиночной проблемы
  if (state.planner.status === "infeasible") {
    all.push({ key: "plan", kind: "plan", score: 20000, label: "Допустимый план не найден — поезда удержаны" });
  }
  if (state.index?.status === "critical") {
    all.push({ key: "index", kind: "index", score: 10000,
      label: `Индекс ${Math.round(state.index.value ?? 0)} — «Критично»` });
  }
  all.sort((a, b) => b.score - a.score);
  return { all, red: new Set(all.slice(0, RED_BUDGET).map((a) => a.key)) };
}

export function useAlarms(): AlarmView {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const state = useSim((s) => s.state);
  return useMemo(() => computeAlarms(world, idx, state), [world, idx, state]);
}
