// Схема участка на холсте. Не в масштабе: раздельные пункты стоят равномерно,
// как на табло диспетчерской централизации (так же, как в Ядре).
import { shortStation } from "../lib/format";
import { cssVar, GROUP_VAR, group } from "../lib/palette";
import type { ReplayModel, TrainView } from "../replay/model";
import type { Frame } from "../replay/types";

export interface Flash {
  stationId: string | null;
  sectionId: string | null;
  trainId: string | null;
  until: number; // performance.now()
  tone: string; // CSS-переменная
}

export interface SchemeOpts {
  projector: boolean;
  reduced?: boolean;
  selected: string | null;
  hover: string | null;
  flashes: Flash[];
  now: number;
}

export interface Hit {
  id: string;
  x: number;
  y: number;
  r: number;
}

interface Layout {
  x: Map<string, number>;
  boxW: number;
  y0: number;
  trackY: Map<string, number>;
  boxTop: Map<string, number>;
  boxBottom: Map<string, number>;
}

function layout(m: ReplayModel, w: number, h: number, projector: boolean): Layout {
  const st = m.r.world.stations;
  const pad = w < 600 ? 22 : projector ? 60 : 44;
  const slot = (w - 2 * pad) / Math.max(1, st.length - 1);
  const boxW = Math.max(7, Math.min(40, slot * 0.42));
  const y0 = Math.round(h * 0.46);
  const gap = projector ? 11 : 8;
  const x = new Map<string, number>();
  const trackY = new Map<string, number>();
  const boxTop = new Map<string, number>();
  const boxBottom = new Map<string, number>();
  st.forEach((s, i) => {
    x.set(s.id, pad + i * slot);
    const main = s.tracks.filter((t) => t.is_main);
    const side = s.tracks.filter((t) => !t.is_main);
    const order = [...main, ...side];
    const offs = [0, -1, 1, -2, 2, -3, 3, -4];
    let top = y0;
    let bottom = y0;
    order.forEach((t, j) => {
      const y = y0 + offs[Math.min(j, offs.length - 1)] * gap;
      trackY.set(t.id, y);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    });
    boxTop.set(s.id, top - gap * 0.8);
    boxBottom.set(s.id, bottom + gap * 0.8);
  });
  return { x, boxW, y0, trackY, boxTop, boxBottom };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Метка поезда: форма — признак группы помимо цвета. */
function glyph(ctx: CanvasRenderingContext2D, g: string, x: number, y: number, r: number, dir: number): void {
  ctx.beginPath();
  if (g === "fast" || g === "pax") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x + dir * r * 0.95, y - r * 0.6);
    ctx.lineTo(x + dir * r * 1.75, y);
    ctx.lineTo(x + dir * r * 0.95, y + r * 0.6);
    ctx.closePath();
  } else if (g === "extra") {
    ctx.moveTo(x - r * 1.3, y);
    ctx.lineTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.3, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.closePath();
  } else if (g === "engine") {
    ctx.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
  } else {
    ctx.rect(x - r * 1.35, y - r * 0.8, r * 2.7, r * 1.6);
  }
}

export function drawScheme(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  m: ReplayModel,
  trains: TrainView[],
  frame: Frame,
  o: SchemeOpts,
): Hit[] {
  const L = layout(m, w, h, o.projector);
  const lw = o.projector ? 3 : 2;
  const fs = o.projector ? 20 : 13;
  const c = {
    bg: cssVar("--bg"),
    rail: cssVar("--rail"),
    track: cssVar("--track"),
    fill: cssVar("--station-fill"),
    border: cssVar("--border-strong"),
    text: cssVar("--text-primary"),
    text2: cssVar("--text-secondary"),
    accent: cssVar("--accent"),
    warning: cssVar("--warning"),
    critical: cssVar("--critical"),
    good: cssVar("--good"),
  };
  ctx.clearRect(0, 0, w, h);
  const secState = new Map(frame.state.sections.map((s) => [s.id, s]));
  const trackState = new Map(frame.state.tracks.map((t) => [t.id, t]));

  // перегоны
  for (const sec of m.r.world.sections) {
    const xa = (L.x.get(sec.a) ?? 0) + L.boxW / 2;
    const xb = (L.x.get(sec.b) ?? 0) - L.boxW / 2;
    const ss = secState.get(sec.id);
    const closed = ss?.status === "closed";
    const restricted = ss?.status === "restricted";
    ctx.strokeStyle = closed ? c.critical : restricted ? c.warning : c.rail;
    ctx.lineWidth = lw;
    ctx.setLineDash(closed ? [8, 6] : []);
    const ys = sec.tracks === 2 ? [L.y0 - 4, L.y0 + 4] : [L.y0];
    for (const y of ys) {
      ctx.beginPath();
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // длина перегона
    ctx.fillStyle = c.text2;
    ctx.font = `${Math.round(fs * 0.85)}px var(--font-ui), system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (xb - xa > 34) ctx.fillText(`${Math.round(sec.length_km)}`, (xa + xb) / 2, L.y0 - (o.projector ? 16 : 12));
  }

  // станции и пути
  m.r.world.stations.forEach((s, i) => {
    const x = L.x.get(s.id) ?? 0;
    const top = L.boxTop.get(s.id) ?? L.y0;
    const bottom = L.boxBottom.get(s.id) ?? L.y0;
    ctx.fillStyle = c.fill;
    ctx.strokeStyle = c.border;
    ctx.lineWidth = o.projector ? 2 : 1.5;
    roundRect(ctx, x - L.boxW / 2, top, L.boxW, bottom - top, 4);
    ctx.fill();
    ctx.stroke();
    for (const t of s.tracks) {
      const y = L.trackY.get(t.id) ?? L.y0;
      const ts = trackState.get(t.id);
      ctx.strokeStyle = ts && !ts.available ? c.critical : ts?.reserved ? c.accent : c.track;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x - L.boxW / 2 + 3, y);
      ctx.lineTo(x + L.boxW / 2 - 3, y);
      ctx.stroke();
    }
    // название: крупные станции жирно, подписи в два ряда, чтобы не налезали
    const big = s.kind !== "loop";
    // на узком экране разъезды без подписей: остаются только станции
    const slotW = m.r.world.stations.length > 1 ? (w - 2 * (L.x.get(m.r.world.stations[0].id) ?? 0)) / (m.r.world.stations.length - 1) : w;
    if (!big && slotW < fs * 2.6) return;
    ctx.fillStyle = big ? c.text : c.text2;
    ctx.font = `${big ? 650 : 500} ${fs}px var(--font-ui), system-ui, sans-serif`;
    ctx.textAlign = "center";
    const below = i % 2 === 0;
    const y = below ? bottom + fs + 6 : top - 8;
    ctx.textBaseline = below ? "alphabetic" : "bottom";
    ctx.fillText(big ? s.name : shortStation(s.name), x, below ? y + 4 : y);
    ctx.textBaseline = "alphabetic";
  });

  // вспышки: место решения или события
  for (const f of o.flashes) {
    const left = f.until - o.now;
    if (left <= 0) continue;
    const a = o.reduced ? 1 : Math.min(1, left / 1500);
    const pulse = o.reduced ? 1 : 0.5 + 0.5 * Math.sin((1500 - left) / 90);
    ctx.strokeStyle = cssVar(f.tone);
    ctx.globalAlpha = a * (0.45 + 0.55 * pulse);
    ctx.lineWidth = lw + 2;
    if (f.stationId && L.x.has(f.stationId)) {
      const x = L.x.get(f.stationId) ?? 0;
      const top = L.boxTop.get(f.stationId) ?? L.y0;
      const bottom = L.boxBottom.get(f.stationId) ?? L.y0;
      roundRect(ctx, x - L.boxW / 2 - 6, top - 6, L.boxW + 12, bottom - top + 12, 8);
      ctx.stroke();
    } else if (f.sectionId) {
      const sec = m.sections.get(f.sectionId);
      if (sec) {
        const xa = (L.x.get(sec.a) ?? 0) + L.boxW / 2;
        const xb = (L.x.get(sec.b) ?? 0) - L.boxW / 2;
        ctx.beginPath();
        ctx.moveTo(xa, L.y0);
        ctx.lineTo(xb, L.y0);
        ctx.lineWidth = lw * 4;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // поезда
  const hits: Hit[] = [];
  const r = o.projector ? 8 : 6;
  for (const tv of trains) {
    const st = tv.st;
    let x: number;
    let y: number;
    if (st.section_id && tv.progress != null) {
      const sec = m.sections.get(st.section_id);
      if (!sec) continue;
      const xa = (L.x.get(sec.a) ?? 0) + L.boxW / 2;
      const xb = (L.x.get(sec.b) ?? 0) - L.boxW / 2;
      x = xa + tv.progress * (xb - xa);
      const double = sec.tracks === 2 && !(secState.get(sec.id)?.single ?? false);
      y = L.y0 + (double ? (tv.train.direction > 0 ? 4 : -4) : 0);
    } else if (st.station_id) {
      x = L.x.get(st.station_id) ?? 0;
      y = st.track_id ? (L.trackY.get(st.track_id) ?? L.y0) : L.y0;
    } else continue;
    const g = group(tv.train.cls);
    const tol = m.tolerance.get(tv.train.cls) ?? 1800;
    const late = st.delay_s > tol;
    const waiting = !!st.wait_reason;
    const sel = o.selected === st.id || o.hover === st.id;
    glyph(ctx, g, x, y, sel ? r * 1.25 : r, tv.train.direction);
    ctx.fillStyle = cssVar(GROUP_VAR[g]);
    ctx.fill();
    ctx.lineWidth = late || waiting || sel ? (o.projector ? 3 : 2.5) : 1.5;
    ctx.strokeStyle = late ? c.critical : waiting ? c.warning : sel ? c.text : c.bg;
    ctx.stroke();
    if (waiting) {
      // значок ожидания над меткой: статус не только цветом
      ctx.fillStyle = c.warning;
      ctx.font = `700 ${fs}px var(--font-ui), system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("⏸", x, y - r - 4);
    }
    // номер поезда: у пассажирских, выбранного и опаздывающих
    if (g === "fast" || g === "pax" || g === "extra" || sel || late) {
      ctx.fillStyle = sel ? c.text : c.text2;
      ctx.font = `${sel ? 700 : 600} ${Math.round(fs * 0.9)}px var(--font-ui), system-ui, sans-serif`;
      ctx.textAlign = "center";
      const dy = tv.train.direction > 0 ? r + fs + 2 : -(r + (waiting ? fs + 6 : 6));
      ctx.fillText(tv.train.number, x, y + dy);
    }
    hits.push({ id: st.id, x, y, r: r * 2 });
  }
  return hits;
}

export function hitTest(hits: Hit[], x: number, y: number): string | null {
  let best: string | null = null;
  let bd = Infinity;
  for (const h of hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < h.r + 6 && d < bd) {
      bd = d;
      best = h.id;
    }
  }
  return best;
}
