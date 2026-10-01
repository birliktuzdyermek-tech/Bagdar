// Восстановление прогона на любой момент t по правилам contracts/README.md:
// первый кадр слева — авторитетный снимок; progress интерполируется только
// для поезда, который в обоих кадрах на одном перегоне; события — с t <= now.
import type { Frame, Plan, PlanLeg, Replay, Section, SimEvent, Station, TrainState, TrainStatic } from "./types";

export interface TrainView {
  st: TrainState; // снимок левого кадра (статус, задержка, причина)
  train: TrainStatic;
  progress: number | null; // интерполированное положение на перегоне, от a к b
  km: number; // положение по километражу, для графика движения
}

export interface Trace {
  t: Float64Array;
  km: Float64Array;
}

export type MarkerKind = "plan" | "decision" | "warn" | "critical" | "injected";

export class ReplayModel {
  readonly r: Replay;
  readonly stations: Map<string, Station>;
  readonly stationIndex: Map<string, number>;
  readonly sections: Map<string, Section>;
  readonly trains: Map<string, TrainStatic>;
  readonly tolerance: Map<string, number>;
  readonly start: number;
  readonly end: number;
  readonly kmMax: number;
  readonly traces: Map<string, Trace>;
  private readonly frameT: Float64Array;
  private readonly eventT: Float64Array;
  private readonly planT: Float64Array;
  private readonly legIndex = new Map<number, Map<string, PlanLeg[]>>();

  constructor(r: Replay) {
    this.r = r;
    const w = r.world;
    this.stations = new Map(w.stations.map((s) => [s.id, s]));
    this.stationIndex = new Map(w.stations.map((s, i) => [s.id, i]));
    this.sections = new Map(w.sections.map((s) => [s.id, s]));
    this.trains = new Map(w.trains.map((t) => [t.id, t]));
    this.tolerance = new Map(w.classes.map((c) => [c.key, c.tolerance_min * 60]));
    r.frames.sort((a, b) => a.t - b.t);
    r.events.sort((a, b) => a.seq - b.seq);
    r.plans.sort((a, b) => a.t - b.t);
    this.start = r.frames[0].t;
    this.end = r.frames[r.frames.length - 1].t;
    this.kmMax = Math.max(...w.stations.map((s) => s.km));
    this.frameT = Float64Array.from(r.frames, (f) => f.t);
    this.eventT = Float64Array.from(r.events, (e) => e.t);
    this.planT = Float64Array.from(r.plans, (p) => p.t);
    this.traces = this.buildTraces();
  }

  /** Индекс последнего элемента с arr[i] <= t, или -1. */
  private static floor(arr: Float64Array, t: number): number {
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  clamp(t: number): number {
    return Math.min(this.end, Math.max(this.start, t));
  }

  frameAt(t: number): { i: number; frame: Frame; next: Frame | null } {
    const i = Math.max(0, ReplayModel.floor(this.frameT, t));
    return { i, frame: this.r.frames[i], next: this.r.frames[i + 1] ?? null };
  }

  sectionKm(secId: string, progress: number): number {
    const sec = this.sections.get(secId);
    if (!sec) return 0;
    const ka = this.stations.get(sec.a)?.km ?? 0;
    const kb = this.stations.get(sec.b)?.km ?? 0;
    return ka + progress * (kb - ka);
  }

  private kmOf(st: TrainState, progress: number | null): number {
    if (st.section_id && progress != null) return this.sectionKm(st.section_id, progress);
    if (st.station_id) return this.stations.get(st.station_id)?.km ?? 0;
    return 0;
  }

  /** Поезда на момент t. smooth=false — без интерполяции (настройка «меньше движения»). */
  trainsAt(t: number, smooth = true): TrainView[] {
    const { frame, next } = this.frameAt(t);
    const nextById = new Map<string, TrainState>();
    if (smooth && next) for (const s of next.state.trains) nextById.set(s.id, s);
    const span = next ? next.t - frame.t : 0;
    const a = span > 0 ? Math.min(1, Math.max(0, (t - frame.t) / span)) : 0;
    const out: TrainView[] = [];
    for (const st of frame.state.trains) {
      const train = this.trains.get(st.id);
      if (!train) continue;
      let progress = st.progress;
      const nx = nextById.get(st.id);
      if (progress != null && nx && nx.status === st.status && nx.section_id === st.section_id && nx.progress != null) {
        progress = progress + (nx.progress - progress) * a;
      }
      out.push({ st, train, progress, km: this.kmOf(st, progress) });
    }
    return out;
  }

  planAt(t: number): { plan: Plan; t: number; i: number } | null {
    const i = ReplayModel.floor(this.planT, t);
    return i < 0 ? null : { plan: this.r.plans[i].plan, t: this.r.plans[i].t, i };
  }

  /** Плечи плана по поездам, кэш по номеру плана в записи. */
  legsByTrain(planI: number): Map<string, PlanLeg[]> {
    let m = this.legIndex.get(planI);
    if (!m) {
      m = new Map();
      for (const lg of this.r.plans[planI].plan.legs) {
        let arr = m.get(lg.train_id);
        if (!arr) m.set(lg.train_id, (arr = []));
        arr.push(lg);
      }
      for (const arr of m.values()) arr.sort((x, y) => x.k - y.k);
      this.legIndex.set(planI, m);
    }
    return m;
  }

  /** События с t <= now в порядке seq. */
  eventsUpTo(t: number): SimEvent[] {
    return this.r.events.slice(0, ReplayModel.floor(this.eventT, t) + 1);
  }

  eventCountUpTo(t: number): number {
    return ReplayModel.floor(this.eventT, t) + 1;
  }

  /** Фактические нитки по кадрам записи: (t, km) для каждого поезда. */
  private buildTraces(): Map<string, Trace> {
    const tmp = new Map<string, { t: number[]; km: number[] }>();
    for (const f of this.r.frames) {
      for (const st of f.state.trains) {
        let tr = tmp.get(st.id);
        if (!tr) tmp.set(st.id, (tr = { t: [], km: [] }));
        tr.t.push(f.t);
        tr.km.push(this.kmOf(st, st.progress));
      }
    }
    const out = new Map<string, Trace>();
    for (const [id, tr] of tmp) out.set(id, { t: Float64Array.from(tr.t), km: Float64Array.from(tr.km) });
    return out;
  }

  /** Значимые моменты для шкалы перемотки. */
  markers(): { t: number; kind: MarkerKind }[] {
    const out: { t: number; kind: MarkerKind }[] = [];
    for (const e of this.r.events) {
      if (e.kind === "decision") out.push({ t: e.t, kind: "decision" });
      else if (e.kind === "train_delay_injected") out.push({ t: e.t, kind: "injected" });
      else if (e.kind === "plan_published") out.push({ t: e.t, kind: "plan" });
      else if (e.severity === "critical") out.push({ t: e.t, kind: "critical" });
      else if (e.severity === "warn") out.push({ t: e.t, kind: "warn" });
    }
    return out;
  }
}
