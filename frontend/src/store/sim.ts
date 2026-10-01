import { create } from "zustand";
import type { DecisionCard, SimEvent, State, Station, Section, TrainStatic, World } from "../api/types";

export type Conn = "connecting" | "open" | "closed";

const MAX_EVENTS = 3000;

export interface Indexed {
  stations: Map<string, Station>;
  stationOrder: Map<string, number>;
  sections: Map<string, Section>;
  trains: Map<string, TrainStatic>;
}

function index(world: World): Indexed {
  return {
    stations: new Map(world.stations.map((s) => [s.id, s])),
    stationOrder: new Map(world.stations.map((s, i) => [s.id, i])),
    sections: new Map(world.sections.map((s) => [s.id, s])),
    trains: new Map(world.trains.map((t) => [t.id, t])),
  };
}

interface SimStore {
  conn: Conn;
  world: World | null;
  idx: Indexed | null;
  runId: string;
  state: State | null;
  prev: State | null;
  recvAt: number;
  prevRecvAt: number;
  events: SimEvent[];
  lastSeq: number;
  cards: DecisionCard[];
  selectedTrain: string | null;
  selectedStation: string | null;
  error: string | null;
  focusSeq: number;

  setConn: (c: Conn) => void;
  setHello: (runId: string) => void;
  setWorld: (w: World) => void;
  pushState: (s: State) => void;
  pushEvents: (evs: SimEvent[], reset: boolean) => void;
  pushCards: (cards: DecisionCard[], reset: boolean) => void;
  selectTrain: (id: string | null) => void;
  selectStation: (id: string | null) => void;
  setError: (e: string | null) => void;
  bumpFocus: () => void;
}

export const useSim = create<SimStore>()((set, get) => ({
  conn: "connecting",
  world: null,
  idx: null,
  runId: "",
  state: null,
  prev: null,
  recvAt: 0,
  prevRecvAt: 0,
  events: [],
  lastSeq: 0,
  cards: [],
  selectedTrain: null,
  selectedStation: null,
  error: null,
  focusSeq: 0,

  setConn: (conn) => set({ conn }),
  setHello: (runId) => {
    if (runId !== get().runId) set({ runId, events: [], lastSeq: 0, prev: null, cards: [] });
  },
  setWorld: (world) => {
    const keepStation = get().selectedStation;
    const idx = index(world);
    set({
      world,
      idx,
      prev: null,
      state: null,
      selectedTrain: null,
      selectedStation: keepStation && idx.stations.has(keepStation) ? keepStation : null,
    });
  },
  pushState: (s) => {
    const { state, recvAt, world } = get();
    if (world && s.world_version !== world.version) return; // устаревший кадр до прихода нового мира
    const now = performance.now();
    const sameRun = state && state.run_id === s.run_id && s.t >= state.t;
    set({ prev: sameRun ? state : null, prevRecvAt: sameRun ? recvAt : now, state: s, recvAt: now, runId: s.run_id });
  },
  pushEvents: (evs, reset) => {
    const base = reset ? [] : get().events;
    const seen = new Set(base.map((e) => e.seq));
    const merged = base.concat(evs.filter((e) => !seen.has(e.seq)));
    const trimmed = merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
    const lastSeq = trimmed.length ? trimmed[trimmed.length - 1].seq : 0;
    set({ events: trimmed, lastSeq });
  },
  pushCards: (cards, reset) => {
    // карточки обновляются на месте (статус, окно отмены), новые дописываются
    const base = reset ? [] : get().cards.slice();
    const pos = new Map(base.map((c, i) => [c.id, i]));
    for (const c of cards) {
      const i = pos.get(c.id);
      if (i == null) {
        pos.set(c.id, base.length);
        base.push(c);
      } else {
        base[i] = c;
      }
    }
    set({ cards: base.slice(-200) });
  },
  selectTrain: (id) => set({ selectedTrain: id }),
  selectStation: (id) => set({ selectedStation: id }),
  setError: (error) => set({ error }),
  bumpFocus: () => set({ focusSeq: get().focusSeq + 1 }),
}));
