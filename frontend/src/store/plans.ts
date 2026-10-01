// Данные для графика движения и Ганта: планы и факт. Загружаются одним
// хуком usePlanSync (в App) и разделяются между компонентами.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api } from "../api/client";
import type { Plan } from "../api/types";
import { useSim } from "./sim";

interface PlanStore {
  runId: string;
  current: Plan | null;
  previous: Plan | null;
  projected: Plan | null;
  traces: Map<string, number[][]>;
  tracesT: number;
  tracesRev: number;
  set: (p: Partial<PlanStore>) => void;
}

export const usePlans = create<PlanStore>()((set) => ({
  runId: "",
  current: null,
  previous: null,
  projected: null,
  traces: new Map(),
  tracesT: 0,
  tracesRev: 0,
  set: (p) => set(p),
}));

export function usePlanSync(): void {
  const runId = useSim((s) => s.state?.run_id ?? "");
  const applied = useSim((s) => s.state?.planner.applied_version ?? -1);
  const conflicts = useSim((s) => s.state?.planner.conflicts ?? 0);
  const t = useSim((s) => s.state?.t ?? 0);
  const running = useSim((s) => s.state?.running ?? false);
  const tracing = useRef(false);
  const lastProj = useRef(-Infinity);

  // новый прогон — всё заново
  useEffect(() => {
    if (!runId) return;
    usePlans.getState().set({ runId, current: null, previous: null, projected: null, traces: new Map(), tracesT: 0,
      tracesRev: 0 });
  }, [runId]);

  // действующий и предыдущий план — при смене версии
  useEffect(() => {
    if (!runId || applied < 0) return;
    let off = false;
    api.plan("current").then((p) => !off && usePlans.getState().set({ current: p })).catch(() => {});
    if (applied >= 1) {
      // до первого пересчёта предыдущего плана нет — не спрашиваем (сервер честно ответил бы 404)
      api.plan("previous").then((p) => !off && usePlans.getState().set({ previous: p }))
        .catch(() => !off && usePlans.getState().set({ previous: null }));
    } else {
      usePlans.getState().set({ previous: null });
    }
    return () => {
      off = true;
    };
  }, [runId, applied]);

  // прогнозный план (действующий, сдвинутый на отклонения) — пока есть прогнозные конфликты
  useEffect(() => {
    if (!runId) return;
    if (conflicts === 0) {
      if (usePlans.getState().projected) usePlans.getState().set({ projected: null });
      return;
    }
    const now = performance.now();
    if (now - lastProj.current < 2500) return;
    lastProj.current = now;
    api.plan("projected").then((p) => usePlans.getState().set({ projected: p })).catch(() => {});
  }, [runId, conflicts, t]);

  // факт — инкрементально, не чаще раза в 2 с, пока модель идёт
  useEffect(() => {
    if (!runId || tracing.current) return;
    const st = usePlans.getState();
    if (st.tracesT && (!running && t <= st.tracesT)) return;
    tracing.current = true;
    const since = st.tracesT;
    api.traces(since).then((res) => {
      const cur = usePlans.getState();
      if (cur.runId !== runId) return;
      const map = new Map(cur.traces);
      for (const tr of res.traces) {
        const old = map.get(tr.train_id) ?? [];
        map.set(tr.train_id, old.concat(tr.points));
      }
      cur.set({ traces: map, tracesT: res.t, tracesRev: cur.tracesRev + 1 });
    }).catch(() => {}).finally(() => {
      window.setTimeout(() => {
        tracing.current = false;
      }, 2000);
    });
  }, [runId, t, running]);
}
