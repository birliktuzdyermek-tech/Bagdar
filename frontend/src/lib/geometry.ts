// Геометрия линейной схемы участка (SVG, координаты в единицах viewBox).
// Схема не в масштабе: раздельные пункты расставлены равномерно, как на
// табло ДЦ, а длины перегонов подписаны.
import type { State, TrainState, World } from "../api/types";
import type { Indexed } from "../store/sim";

export const SCHEME_W = 1600;
export const SCHEME_H = 210;
export const Y0 = 92;
const PAD_X = 46;
const TRACK_OFFSETS = [0, -10, 10, -20, 20, -30, 30, -40];

export interface Layout {
  stationX: Map<string, number>;
  boxW: Map<string, number>;
  trackY: Map<string, number>;
  slot: number;
}

export function boxWidth(kind: string): number {
  return kind === "terminal" ? 44 : kind === "station" ? 40 : 32;
}

export function buildLayout(world: World): Layout {
  const n = world.stations.length;
  const slot = (SCHEME_W - 2 * PAD_X) / Math.max(1, n - 1);
  const stationX = new Map<string, number>();
  const boxW = new Map<string, number>();
  const trackY = new Map<string, number>();
  world.stations.forEach((st, i) => {
    stationX.set(st.id, PAD_X + i * slot);
    boxW.set(st.id, boxWidth(st.kind));
    const main = st.tracks.filter((t) => t.is_main);
    const side = st.tracks.filter((t) => !t.is_main);
    [...main, ...side].forEach((t, j) => trackY.set(t.id, Y0 + TRACK_OFFSETS[Math.min(j, TRACK_OFFSETS.length - 1)]));
  });
  return { stationX, boxW, trackY, slot };
}

export function sectionEnds(layout: Layout, a: string, b: string): [number, number] {
  const xa = (layout.stationX.get(a) ?? 0) + (layout.boxW.get(a) ?? 0) / 2;
  const xb = (layout.stationX.get(b) ?? 0) - (layout.boxW.get(b) ?? 0) / 2;
  return [xa, xb];
}

export interface Pos {
  x: number;
  y: number;
  onSection: boolean;
}

export function trainPos(layout: Layout, idx: Indexed, state: State, ts: TrainState, dir: number): Pos | null {
  if (ts.section_id && ts.progress != null) {
    const sec = idx.sections.get(ts.section_id);
    if (!sec) return null;
    const [xa, xb] = sectionEnds(layout, sec.a, sec.b);
    const secState = state.sections.find((s) => s.id === sec.id);
    const doubleLine = sec.tracks === 2 && !(secState?.single ?? false);
    return { x: xa + ts.progress * (xb - xa), y: Y0 + (doubleLine ? (dir > 0 ? 4 : -4) : 0), onSection: true };
  }
  if (ts.station_id) {
    const x = layout.stationX.get(ts.station_id);
    if (x == null) return null;
    return { x, y: ts.track_id ? layout.trackY.get(ts.track_id) ?? Y0 : Y0, onSection: false };
  }
  return null;
}

/** Контур метки поезда: форма — дополнительный признак группы помимо цвета. */
export function trainShape(group: string, dir: number, scale = 1): string {
  const s = scale;
  const f = dir > 0 ? 1 : -1;
  const P = (x: number, y: number) => `${(x * f * s).toFixed(1)},${(y * s).toFixed(1)}`;
  switch (group) {
    case "fast":
    case "pax":
      return `M${P(-10, -4.5)} L${P(5, -4.5)} L${P(11, 0)} L${P(5, 4.5)} L${P(-10, 4.5)} Z`;
    case "extra":
      return `M${P(-9, 0)} L${P(0, -6)} L${P(9, 0)} L${P(0, 6)} Z`;
    case "engine":
      return `M${P(-5, -4)} L${P(3, -4)} L${P(6, 0)} L${P(3, 4)} L${P(-5, 4)} Z`;
    default:
      return `M${P(-11, -4.5)} L${P(8, -4.5)} L${P(8, -2)} L${P(11, -2)} L${P(11, 2)} L${P(8, 2)} L${P(8, 4.5)} L${P(-11, 4.5)} Z`;
  }
}
