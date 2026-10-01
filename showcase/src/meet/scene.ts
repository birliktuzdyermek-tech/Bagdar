// Рисование сцены «Кто первым?» на canvas: ночная степь, однопутный перегон, две станции
// с обгонными путями и фонарями, светофоры, поезда с окнами, колёсами и фарами, табло ожидания.
// Положения поездов — только из расчёта (MeetResult.options[].motion), сцена ничего не досчитывает.
import type { MeetOption, MeetResult, Seg } from "./model";
import { posAt } from "./model";

export const STRETCH = 3;           // поезда и обгонные пути на схеме длиннее — иначе вагонов не видно
const STOP_M = 150;                 // голова ждущего поезда — у выходного конца обгонного пути
const RAMP_M = 350;                 // стрелочный съезд на обгонный путь
const WHEEL_R_M = 0.5;              // радиус колеса, м — для вращения

export interface LoopGeom { x1: number; x2: number }
export interface Layout {
  W: number; H: number; dpr: number; ui: number; k: number;
  trackY: number; loopY: number;
  from: number; to: number; L: number;
  zin: number; brk: { px0: number; px1: number; m0: number; m1: number } | null;
  loopA: LoopGeom; loopB: LoopGeom;
  map: (x: number) => number;
  scaleAt: (x: number) => number;
  sigA: number; sigB: number;
}

/**
 * Во сколько раз растянуть поезда на схеме. По расчёту хвост первого поезда уходит со стрелки
 * раньше, чем к ней подъедет уступавший (интервал скрещения 90 с). Растянутый хвост идёт дольше —
 * растяжение подбирается так, чтобы и на схеме хвост освобождал стрелку за 10 с до встречного.
 */
export function stretchFor(res: MeetResult): number {
  const xm = STOP_M + RAMP_M;
  let k = STRETCH;
  for (const o of res.options) {
    const y = o.yield === "pax" ? res.trains.pax : res.trains.freight;
    const f = o.yield === "pax" ? res.trains.freight : res.trains.pax;
    const ys = o[o.yield];
    const fs = o.yield === "pax" ? o.freight : o.pax;
    const vy = y.v_kmh / 3.6;
    const ay = vy / Math.max(1, y.accel_s);
    const tY = ys.stopped ? ys.dep + Math.sqrt((2 * xm) / ay) : ys.arr + xm / vy;
    const vf = f.v_kmh / 3.6;
    const lim = (vf * (tY - 10 - fs.arr_far) + xm) / f.length_m;
    if (Number.isFinite(lim)) k = Math.min(k, lim);
  }
  return Math.max(1, k);
}

export function makeLayout(res: MeetResult, W: number, H: number, dpr: number): Layout {
  const L = res.geometry.section_m;
  const k = stretchFor(res);
  const loopLen = k * res.geometry.loop_m;
  const loopA = { x1: STOP_M - loopLen, x2: STOP_M };
  const loopB = { x1: L - STOP_M, x2: L - STOP_M + loopLen };
  const zin = STOP_M + RAMP_M + 650;
  const zout = loopLen - STOP_M + RAMP_M + 40;    // сразу за входной стрелкой — край схемы
  const from = -zout;
  const to = L + zout;
  const pad = 14;
  const ui = Math.max(0.8, Math.min(1.35, W / 1350));
  let map: (x: number) => number;
  let scaleAt: (x: number) => number;
  let brk: Layout["brk"] = null;
  if (L - 2 * zin > 1500) {
    const brkPx = Math.max(96, Math.min(230, W * 0.14));
    const zonePx = (W - 2 * pad - brkPx) / 2;
    const s = zonePx / (zout + zin);
    const m0 = zin;
    const m1 = L - zin;
    const px0 = pad + zonePx;
    const px1 = px0 + brkPx;
    const sb = brkPx / (m1 - m0);
    brk = { px0, px1, m0, m1 };
    map = (x) => (x <= m0 ? pad + (x - from) * s : x >= m1 ? px1 + (x - m1) * s : px0 + (x - m0) * sb);
    scaleAt = (x) => (x <= m0 || x >= m1 ? s : sb);
  } else {
    const s = (W - 2 * pad) / (to - from);
    map = (x) => pad + (x - from) * s;
    scaleAt = () => s;
  }
  const trackY = Math.round(H * 0.7);
  return {
    W, H, dpr, ui, k, trackY, loopY: trackY - Math.round(30 * ui), from, to, L, zin, brk, loopA, loopB, map, scaleAt,
    sigA: loopA.x2 + RAMP_M + 60, sigB: loopB.x1 - RAMP_M - 60,
  };
}

/** Доля смещения на обгонный путь (0 — главный путь, 1 — обгонный) для точки x. */
function loopFrac(g: LoopGeom, x: number): number {
  if (x < g.x1 - RAMP_M || x > g.x2 + RAMP_M) return 0;
  if (x >= g.x1 && x <= g.x2) return 1;
  const u = x < g.x1 ? (x - (g.x1 - RAMP_M)) / RAMP_M : 1 - (x - g.x2) / RAMP_M;
  return u * u * (3 - 2 * u);
}

// ------------------------------------------------------------------ вспомогательное
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function path(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

// ------------------------------------------------------------------ фон
function ridge(ctx: CanvasRenderingContext2D, W: number, base: number, amp: number, seed: number, fill: string, H: number) {
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 5) {
    const u = x / W;
    const y = base - amp * (0.55 * Math.sin(u * 7 + ph[0]) + 0.3 * Math.sin(u * 17 + ph[1]) + 0.15 * Math.sin(u * 41 + ph[2]) + 0.6);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function rails(ctx: CanvasRenderingContext2D, pts: [number, number][], ui: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#2b2824";
  ctx.lineWidth = 11 * ui;
  path(ctx, pts);
  ctx.stroke();
  ctx.strokeStyle = "#3a3530";
  ctx.lineWidth = 9 * ui;
  path(ctx, pts);
  ctx.stroke();
  // шпалы
  ctx.strokeStyle = "#5a4c3c";
  ctx.lineWidth = 6.5 * ui;
  ctx.setLineDash([1.7 * ui, 4.4 * ui]);
  path(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
  // рельсы: тёмная подошва и светлая головка
  for (const off of [-1.9 * ui, 1.9 * ui]) {
    ctx.strokeStyle = "#6d6960";
    ctx.lineWidth = 1.6 * ui;
    path(ctx, pts.map(([x, y]) => [x, y + off + 0.5]));
    ctx.stroke();
    ctx.strokeStyle = "#c9c4b6";
    ctx.lineWidth = 0.9 * ui;
    path(ctx, pts.map(([x, y]) => [x, y + off]));
    ctx.stroke();
  }
}

function loopPts(lay: Layout, g: LoopGeom): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = g.x1 - RAMP_M; x <= g.x2 + RAMP_M; x += 25) pts.push([lay.map(x), lay.trackY + loopFrac(g, x) * (lay.loopY - lay.trackY)]);
  return pts;
}

function lamp(ctx: CanvasRenderingContext2D, x: number, groundY: number, ui: number) {
  const h = 30 * ui;
  ctx.strokeStyle = "#6a6e7a";
  ctx.lineWidth = 1.4 * ui;
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x, groundY - h);
  ctx.lineTo(x + 5 * ui, groundY - h);
  ctx.stroke();
  const lx = x + 6 * ui;
  const ly = groundY - h + 1.5 * ui;
  const cone = ctx.createLinearGradient(lx, ly, lx, groundY + 8 * ui);
  cone.addColorStop(0, "rgba(255,214,140,0.28)");
  cone.addColorStop(1, "rgba(255,214,140,0)");
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(lx - 2 * ui, ly);
  ctx.lineTo(lx + 2 * ui, ly);
  ctx.lineTo(lx + 22 * ui, groundY + 8 * ui);
  ctx.lineTo(lx - 22 * ui, groundY + 8 * ui);
  ctx.closePath();
  ctx.fill();
  glow(ctx, lx, ly, 9 * ui, "255,220,150", 0.5);
  ctx.fillStyle = "#fff1c8";
  ctx.beginPath();
  ctx.arc(lx, ly, 1.6 * ui, 0, Math.PI * 2);
  ctx.fill();
}

function station(ctx: CanvasRenderingContext2D, lay: Layout, xs: number, side: 1 | -1, name: string) {
  const { trackY, ui, H } = lay;
  const px = lay.map(xs);
  const pl = lay.map(xs + side * 520) - px;
  const left = Math.min(px, px + pl);
  const wdt = Math.abs(pl);
  // платформа
  ctx.fillStyle = "#3b3a36";
  roundRect(ctx, left, trackY + 7 * ui, wdt, 5 * ui, 1.5 * ui);
  ctx.fill();
  ctx.fillStyle = "#8a8578";
  ctx.fillRect(left, trackY + 7 * ui, wdt, 1);
  ctx.fillStyle = "#c9b24a";
  ctx.fillRect(left + 4, trackY + 8.5 * ui, wdt - 8, 0.8 * ui);
  // вокзал
  const bw = 34 * ui;
  const bh = 15 * ui;
  const bx = px + side * 26 * ui - bw / 2;
  const by = trackY + 14 * ui;
  const wall = ctx.createLinearGradient(0, by, 0, by + bh);
  wall.addColorStop(0, "#343a4a");
  wall.addColorStop(1, "#232733");
  ctx.fillStyle = wall;
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = "#4b5265";
  ctx.beginPath();
  ctx.moveTo(bx - 3 * ui, by);
  ctx.lineTo(bx + bw / 2, by - 9 * ui);
  ctx.lineTo(bx + bw + 3 * ui, by);
  ctx.closePath();
  ctx.fill();
  for (let w = 0; w < 4; w++) {
    ctx.fillStyle = w === 1 ? "#ffd27a" : "#f6c460";
    ctx.fillRect(bx + (3.5 + w * 8) * ui, by + 4.5 * ui, 4 * ui, 4.5 * ui);
  }
  glow(ctx, bx + bw / 2, by + bh / 2, 26 * ui, "255,200,110", 0.12);
  for (let i = 0; i < 3; i++) lamp(ctx, left + (0.18 + i * 0.32) * wdt, trackY + 7 * ui, ui);
  // табличка с названием
  ctx.font = `700 ${Math.round(13 * ui)}px system-ui, sans-serif`;
  const tw = ctx.measureText(name).width;
  const sx = side === 1 ? bx + bw + 8 * ui : bx - 8 * ui - tw - 12 * ui;
  const sy = H - 22 * ui;
  ctx.fillStyle = "#101520";
  roundRect(ctx, sx, sy, tw + 12 * ui, 18 * ui, 4 * ui);
  ctx.fill();
  ctx.strokeStyle = "#3e4a66";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#eef0f6";
  ctx.textAlign = "left";
  ctx.fillText(name, sx + 6 * ui, sy + 13 * ui);
}

export function drawBackground(ctx: CanvasRenderingContext2D, lay: Layout, res: MeetResult, names: [string, string]) {
  const { W, H, ui, trackY } = lay;
  const sky = ctx.createLinearGradient(0, 0, 0, trackY);
  sky.addColorStop(0, "#04071a");
  sky.addColorStop(0.42, "#0c1737");
  sky.addColorStop(0.72, "#1c2a55");
  sky.addColorStop(0.9, "#3b2f55");
  sky.addColorStop(1, "#6a3f47");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // млечный путь
  ctx.save();
  ctx.translate(W * 0.55, trackY * 0.3);
  ctx.rotate(-0.42);
  const mw = ctx.createLinearGradient(0, -60 * ui, 0, 60 * ui);
  mw.addColorStop(0, "rgba(180,200,255,0)");
  mw.addColorStop(0.5, "rgba(190,205,255,0.09)");
  mw.addColorStop(1, "rgba(180,200,255,0)");
  ctx.fillStyle = mw;
  ctx.fillRect(-W, -60 * ui, 2 * W, 120 * ui);
  ctx.restore();
  // звёзды
  const r = rng(11);
  for (let i = 0; i < Math.round(W / 9); i++) {
    const x = r() * W;
    const y = r() * trackY * 0.62;
    const a = 0.2 + r() * 0.6;
    const big = r() < 0.08;
    ctx.fillStyle = `rgba(230,236,255,${a})`;
    ctx.fillRect(x, y, big ? 1.8 : 1, big ? 1.8 : 1);
    if (big) {
      ctx.strokeStyle = `rgba(230,236,255,${a * 0.5})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x - 3, y + 1);
      ctx.lineTo(x + 4, y + 1);
      ctx.moveTo(x + 1, y - 3);
      ctx.lineTo(x + 1, y + 4);
      ctx.stroke();
    }
  }
  // луна
  const mx = W * 0.86;
  const my = H * 0.16;
  glow(ctx, mx, my, 56 * ui, "255,244,214", 0.35);
  ctx.fillStyle = "#f6efd8";
  ctx.beginPath();
  ctx.arc(mx, my, 7.5 * ui, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(200,190,160,0.35)";
  ctx.beginPath();
  ctx.arc(mx - 2.4 * ui, my - 1.5 * ui, 1.6 * ui, 0, Math.PI * 2);
  ctx.arc(mx + 2 * ui, my + 2.5 * ui, 1.1 * ui, 0, Math.PI * 2);
  ctx.fill();
  // дальние огни посёлка
  const cx = W * 0.14;
  glow(ctx, cx, trackY - 34 * ui, 90 * ui, "255,170,90", 0.1);
  const rc = rng(5);
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgba(255,${180 + Math.round(rc() * 60)},110,${0.35 + rc() * 0.5})`;
    ctx.fillRect(cx - 50 * ui + rc() * 100 * ui, trackY - 36 * ui + rc() * 5 * ui, 1.2, 1.2);
  }
  // горы
  ridge(ctx, W, trackY - 40 * ui, 54 * ui, 3, "#141b36", H);
  ridge(ctx, W, trackY - 26 * ui, 36 * ui, 8, "#181f3a", H);
  ridge(ctx, W, trackY - 14 * ui, 22 * ui, 13, "#1c2238", H);
  const haze = ctx.createLinearGradient(0, trackY - 40 * ui, 0, trackY);
  haze.addColorStop(0, "rgba(120,90,110,0)");
  haze.addColorStop(1, "rgba(120,90,110,0.22)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, trackY - 40 * ui, W, 40 * ui);
  // земля
  const ground = ctx.createLinearGradient(0, trackY - 12 * ui, 0, H);
  ground.addColorStop(0, "#1c201c");
  ground.addColorStop(0.5, "#141713");
  ground.addColorStop(1, "#0d0f0d");
  ctx.fillStyle = ground;
  ctx.fillRect(0, trackY - 12 * ui, W, H);
  const rg = rng(21);
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = trackY + 14 * ui + rg() * (H - trackY - 16 * ui);
    const x = rg() * W;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 20 + rg() * 80, y);
    ctx.stroke();
  }
  // контактная сеть
  const wireY = trackY - 34 * ui;
  ctx.strokeStyle = "rgba(170,170,160,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, wireY);
  ctx.lineTo(W, wireY);
  ctx.stroke();
  ctx.strokeStyle = "rgba(190,190,180,0.22)";
  ctx.beginPath();
  ctx.moveTo(0, wireY + 2.5 * ui);
  ctx.lineTo(W, wireY + 2.5 * ui);
  ctx.stroke();
  for (let px = 22; px < W; px += 72 * ui) {
    if (lay.brk && px > lay.brk.px0 - 8 && px < lay.brk.px1 + 8) continue;
    ctx.strokeStyle = "rgba(160,160,150,0.5)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px, trackY + 6 * ui);
    ctx.lineTo(px, wireY - 6 * ui);
    ctx.lineTo(px + 9 * ui, wireY - 6 * ui);
    ctx.lineTo(px + 9 * ui, wireY);
    ctx.stroke();
    ctx.fillStyle = "#9fa8b8";
    ctx.fillRect(px + 8 * ui, wireY - 2, 2, 2);
  }
  // пути
  rails(ctx, [[0, trackY], [W, trackY]], ui);
  rails(ctx, loopPts(lay, lay.loopA), ui);
  rails(ctx, loopPts(lay, lay.loopB), ui);
  station(ctx, lay, 0, -1, names[0]);
  station(ctx, lay, lay.L, 1, names[1]);
  // перегон: скобка и подпись
  const a = lay.map(lay.loopA.x2 + RAMP_M);
  const b = lay.map(lay.loopB.x1 - RAMP_M);
  const yb = trackY + 24 * ui;
  ctx.strokeStyle = "rgba(250,178,25,0.7)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(a, yb);
  ctx.lineTo(b, yb);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const x of [a, b]) {
    ctx.beginPath();
    ctx.moveTo(x, yb - 4);
    ctx.lineTo(x, yb + 4);
    ctx.stroke();
  }
  ctx.fillStyle = "#fab219";
  ctx.font = `600 ${Math.round(12 * ui)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  const lbl = `однопутный перегон · ${fmtKm(res.geometry.section_m)} — двоим не разъехаться`;
  const lx = lay.brk ? (lay.brk.px0 + lay.brk.px1) / 2 : (a + b) / 2;
  ctx.fillText(lbl, Math.max(170 * ui, Math.min(W - 170 * ui, lx)), yb + 16 * ui);
}

// ------------------------------------------------------------------ живое небо
interface Star { x: number; y: number; r: number; ph: number }
interface Cloud { x: number; y: number; w: number; h: number; v: number; a: number }
const skyCache = new WeakMap<Layout, { stars: Star[]; clouds: Cloud[] }>();

/** Мерцание звёзд и медленные облака — рисуется поверх статичного фона каждый кадр. */
export function drawSky(ctx: CanvasRenderingContext2D, lay: Layout, now: number) {
  let c = skyCache.get(lay);
  if (!c) {
    const r = rng(77);
    const stars: Star[] = [];
    for (let i = 0; i < 34; i++) stars.push({ x: r() * lay.W, y: r() * lay.trackY * 0.55, r: 0.8 + r() * 1.2, ph: r() * 6.28 });
    const clouds: Cloud[] = [];
    for (let i = 0; i < 4; i++) clouds.push({ x: r() * lay.W, y: lay.trackY * (0.18 + r() * 0.3), w: (90 + r() * 160) * lay.ui, h: (10 + r() * 14) * lay.ui, v: 2 + r() * 4, a: 0.04 + r() * 0.05 });
    c = { stars, clouds };
    skyCache.set(lay, c);
  }
  for (const s of c.stars) {
    const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 900 + s.ph));
    ctx.fillStyle = `rgba(235,240,255,${a})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const cl of c.clouds) {
    const x = ((cl.x + (now / 1000) * cl.v) % (lay.W + cl.w)) - cl.w / 2;
    ctx.save();
    ctx.translate(x, cl.y);
    ctx.scale(1, cl.h / (cl.w / 2));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cl.w / 2);
    g.addColorStop(0, `rgba(200,210,240,${cl.a})`);
    g.addColorStop(1, "rgba(200,210,240,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, cl.w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Гора над серединой длинного перегона: поезд уходит в тоннель — часть перегона не помещается на экране. */
export function drawForeground(ctx: CanvasRenderingContext2D, lay: Layout) {
  const { trackY, ui, W, H } = lay;
  if (lay.brk) {
    const { px0, px1 } = lay.brk;
    const top = trackY - 80 * ui;
    const w = px1 - px0;
    const g = ctx.createLinearGradient(0, top, 0, trackY + 12 * ui);
    g.addColorStop(0, "#3d4460");
    g.addColorStop(0.55, "#262c42");
    g.addColorStop(1, "#171b2a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px0 - 22 * ui, trackY + 12 * ui);
    ctx.bezierCurveTo(px0 + w * 0.04, trackY - 34 * ui, px0 + w * 0.17, top, px0 + w * 0.36, top + 6 * ui);
    ctx.bezierCurveTo(px0 + w * 0.5, top - 12 * ui, px0 + w * 0.62, top + 3 * ui, px0 + w * 0.7, top + 10 * ui);
    ctx.bezierCurveTo(px0 + w * 0.86, top + 18 * ui, px0 + w * 0.97, trackY - 34 * ui, px1 + 22 * ui, trackY + 12 * ui);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(225,232,245,0.22)";
    ctx.beginPath();
    ctx.moveTo(px0 + w * 0.3, top + 13 * ui);
    ctx.lineTo(px0 + w * 0.36, top + 6 * ui);
    ctx.lineTo(px0 + w * 0.44, top + 1 * ui);
    ctx.lineTo(px0 + w * 0.5, top - 6 * ui);
    ctx.lineTo(px0 + w * 0.57, top + 5 * ui);
    ctx.lineTo(px0 + w * 0.52, top + 9 * ui);
    ctx.closePath();
    ctx.fill();
    const lit = ctx.createLinearGradient(px0 + w * 0.5, top, px1, trackY);
    lit.addColorStop(0, "rgba(255,240,210,0.08)");
    lit.addColorStop(1, "rgba(255,240,210,0)");
    ctx.fillStyle = lit;
    ctx.fillRect(px0 + w * 0.5, top - 12 * ui, w * 0.5 + 22 * ui, trackY - top + 24 * ui);
    for (const x of [px0 + 5 * ui, px1 - 5 * ui]) {
      ctx.fillStyle = "#4a4f63";
      ctx.beginPath();
      ctx.moveTo(x - 12 * ui, trackY + 8 * ui);
      ctx.lineTo(x - 12 * ui, trackY - 7 * ui);
      ctx.arc(x, trackY - 7 * ui, 12 * ui, Math.PI, 0);
      ctx.lineTo(x + 12 * ui, trackY + 8 * ui);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#07080c";
      ctx.beginPath();
      ctx.moveTo(x - 9 * ui, trackY + 7 * ui);
      ctx.lineTo(x - 9 * ui, trackY - 6 * ui);
      ctx.arc(x, trackY - 6 * ui, 9 * ui, Math.PI, 0);
      ctx.lineTo(x + 9 * ui, trackY + 7 * ui);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#8b92a8";
      ctx.fillRect(x - 2 * ui, trackY - 16.5 * ui, 4 * ui, 3 * ui);
      glow(ctx, x, trackY - 18 * ui, 8 * ui, "255,220,160", 0.5);
      ctx.fillStyle = "#ffe9bf";
      ctx.beginPath();
      ctx.arc(x, trackY - 18 * ui, 1.4 * ui, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const v = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.5, W / 2, H * 0.55, W * 0.72);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ------------------------------------------------------------------ поезда
export interface Car { len: number; kind: "loco" | "coach" | "tank" | "hopper" | "box" | "reefer" | "container" | "gondola"; color: string; seed: number }

const CONTAINERS = ["#2f6fd6", "#d0743c", "#3a9d5d", "#c9c4b4", "#b8433a", "#7b5cc9"];

export function paxCars(res: MeetResult): Car[] {
  const n = Math.round((res.trains.pax.length_m - 20) / 25);
  const cls = res.trains.pax.cls;
  const body = cls === "high_speed_passenger" ? "#e8edf3" : cls === "fast_passenger" ? "#2f6fd6" : "#199e70";
  return [{ len: 20, kind: "loco", color: body, seed: 1 }, ...Array.from({ length: n }, (_, i) => ({ len: 25, kind: "coach" as const, color: body, seed: i + 2 }))];
}

export function freightCars(res: MeetResult): Car[] {
  const n = Math.round((res.trains.freight.length_m - 34) / 14);
  const cargo = res.params.freight.cargo;
  const r = rng(Math.round(res.trains.freight.mass_t));
  const cars: Car[] = [{ len: 34, kind: "loco", color: "#c0392b", seed: 1 }];
  for (let i = 0; i < n; i++) {
    const u = r();
    let c: Car;
    const seed = Math.floor(r() * 1e6);
    if (cargo.includes("perishable") && u < 0.55) c = { len: 14, kind: "reefer", color: "#e3e9ec", seed };
    else if (cargo.includes("dangerous") && u < 0.5) c = { len: 14, kind: "tank", color: "#3b3f46", seed };
    else if ((cargo.includes("urgent") || cargo.includes("deadline")) && u < 0.6) c = { len: 14, kind: "container", color: CONTAINERS[i % CONTAINERS.length], seed };
    else {
      const v = r();
      c = v < 0.3 ? { len: 14, kind: "hopper", color: "#7a5236", seed } : v < 0.55 ? { len: 14, kind: "gondola", color: "#5d4a3a", seed }
        : v < 0.75 ? { len: 14, kind: "tank", color: "#6b6f76", seed } : { len: 14, kind: "container", color: CONTAINERS[Math.floor(v * 97) % CONTAINERS.length], seed };
    }
    cars.push(c);
  }
  return cars;
}

export interface TrainDraw {
  segs: Seg[];
  dir: 1 | -1;
  cars: Car[];
  loop: LoopGeom | null;    // обгонный путь, на который уходит этот поезд
  pax: boolean;
}

function carY(lay: Layout, tr: TrainDraw, x: number): number {
  return lay.trackY + (tr.loop ? loopFrac(tr.loop, x) : 0) * (lay.loopY - lay.trackY);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

interface Placed { px: number; py: number; ang: number; w: number; h: number; c: Car }

/** Рисует поезд; возвращает экранные координаты головы и середины состава для табличек. */
export function drawTrain(ctx: CanvasRenderingContext2D, lay: Layout, tr: TrainDraw, t: number, now: number) {
  const { x: xf, v } = posAt(tr.segs, t);
  const ui = lay.ui;
  let cum = 0;
  let mid: [number, number] = [0, 0];
  const total = tr.cars.reduce((s, c) => s + c.len, 0);
  const visible = (x: number) => x > lay.from - 200 && x < lay.to + 200;
  let headPx: [number, number] | null = null;
  let tailPx: [number, number] | null = null;
  const wheelAng = (xf / WHEEL_R_M) % (Math.PI * 2);
  const placed: Placed[] = [];
  for (let i = 0; i < tr.cars.length; i++) {
    const c = tr.cars[i];
    const xc = xf - tr.dir * lay.k * (cum + c.len / 2);
    cum += c.len;
    if (Math.abs(cum - total / 2) <= c.len) mid = [lay.map(xc), carY(lay, tr, xc)];
    if (!visible(xc)) continue;
    const px = lay.map(xc);
    const py = carY(lay, tr, xc);
    const dx = lay.map(xc + 8) - lay.map(xc - 8);
    const dy = carY(lay, tr, xc + 8) - carY(lay, tr, xc - 8);
    const ang = Math.atan2(dy, dx);
    const w = Math.max(1.2, lay.k * c.len * lay.scaleAt(xc) - (tr.pax ? 1.3 : 0.9));
    const h = Math.min((c.kind === "loco" ? 12.5 : tr.pax ? 11.5 : c.kind === "gondola" || c.kind === "hopper" ? 9 : 10.5) * ui, Math.max(6 * ui, w * 1.15));
    placed.push({ px, py, ang, w, h, c });
    if (i === 0) headPx = [px + tr.dir * (w / 2), py];
    if (i === tr.cars.length - 1) tailPx = [px - tr.dir * (w / 2), py];
  }
  // тень под составом
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  for (const p of placed) {
    ctx.save();
    ctx.translate(p.px, p.py + 2.5 * ui);
    ctx.rotate(p.ang);
    ctx.beginPath();
    ctx.ellipse(0, 0, p.w / 2 + 1, 2.4 * ui, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // кузова с колёсами
  for (const p of placed) {
    ctx.save();
    ctx.translate(p.px, p.py - p.h / 2 - 2.6 * ui);
    ctx.rotate(p.ang);
    drawCar(ctx, p.c, p.w, p.h, tr.dir, tr.pax, ui, wheelAng, Math.abs(v));
    ctx.restore();
  }
  // фара и хвостовой огонь
  if (headPx) {
    const [hx, hy] = headPx;
    const y = hy - 6.5 * ui;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const moving = v > 0.5;
    const len = (moving ? 110 : 40) * ui;
    const gr = ctx.createLinearGradient(hx, y, hx + tr.dir * len, y);
    gr.addColorStop(0, `rgba(255,240,200,${moving ? 0.5 : 0.3})`);
    gr.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(hx, y - 2.2 * ui);
    ctx.lineTo(hx + tr.dir * len, y - 14 * ui);
    ctx.lineTo(hx + tr.dir * len, y + 13 * ui);
    ctx.lineTo(hx, y + 2.2 * ui);
    ctx.closePath();
    ctx.fill();
    const pool = ctx.createRadialGradient(hx + tr.dir * 30 * ui, hy + 3 * ui, 0, hx + tr.dir * 30 * ui, hy + 3 * ui, 46 * ui);
    pool.addColorStop(0, `rgba(255,236,190,${moving ? 0.22 : 0.12})`);
    pool.addColorStop(1, "rgba(255,236,190,0)");
    ctx.fillStyle = pool;
    ctx.fillRect(hx - 60 * ui, hy - 10 * ui, 120 * ui, 30 * ui);
    glow(ctx, hx, y, 5 * ui, "255,250,230", 0.8);
    ctx.fillStyle = "rgba(255,252,240,1)";
    ctx.beginPath();
    ctx.arc(hx, y - 1.6 * ui, 1.3 * ui, 0, Math.PI * 2);
    ctx.arc(hx, y + 1.6 * ui, 1.3 * ui, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (tailPx) {
    const blink = Math.sin(now / 260) > -0.3 ? 1 : 0.35;
    glow(ctx, tailPx[0], tailPx[1] - 6 * ui, 5 * ui, "255,70,60", 0.5 * blink);
    ctx.fillStyle = `rgba(255,80,70,${blink})`;
    ctx.beginPath();
    ctx.arc(tailPx[0], tailPx[1] - 6 * ui, 1.6 * ui, 0, Math.PI * 2);
    ctx.fill();
  }
  return { head: headPx, mid, v, x: xf };
}

function wheels(ctx: CanvasRenderingContext2D, w: number, h: number, ui: number, ang: number, twoBogies: boolean) {
  const r = 2.3 * ui;
  const y = h / 2 + 1.2 * ui;
  const xs = twoBogies && w > 14 * ui ? [-w * 0.32 - 3 * ui, -w * 0.32 + 3 * ui, w * 0.32 - 3 * ui, w * 0.32 + 3 * ui] : [-w * 0.3, w * 0.3];
  for (const x of xs) {
    if (Math.abs(x) > w / 2 - r) continue;
    ctx.fillStyle = "#1a1a1c";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#8c8f96";
    ctx.lineWidth = 0.8 * ui;
    ctx.beginPath();
    ctx.arc(x, y, r - 0.5 * ui, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#c9ccd2";
    ctx.lineWidth = 0.7 * ui;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * (r - 0.8 * ui), y + Math.sin(ang) * (r - 0.8 * ui));
    ctx.lineTo(x - Math.cos(ang) * (r - 0.8 * ui), y - Math.sin(ang) * (r - 0.8 * ui));
    ctx.stroke();
  }
  ctx.fillStyle = "#15161a";
  ctx.fillRect(-w / 2 + 0.5, h / 2 - 0.3 * ui, w - 1, 1.4 * ui);
}

function drawCar(ctx: CanvasRenderingContext2D, c: Car, w: number, h: number, dir: number, pax: boolean, ui: number, wheelAng: number, speed: number) {
  const x = -w / 2;
  const y = -h / 2;
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, shade(c.color, 1.22));
  body.addColorStop(0.45, c.color);
  body.addColorStop(1, shade(c.color, 0.62));
  wheels(ctx, w, h, ui, wheelAng, c.kind === "loco" || c.kind === "coach");
  if (c.kind === "loco") {
    ctx.fillStyle = body;
    ctx.beginPath();
    const nose = Math.min(w * 0.32, 7 * ui);
    if (dir > 0) {
      ctx.moveTo(x + 1.5 * ui, y);
      ctx.lineTo(x + w - nose, y);
      ctx.quadraticCurveTo(x + w, y + 1, x + w, y + h * 0.62);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + 1.5 * ui);
    } else {
      ctx.moveTo(x + w - 1.5 * ui, y);
      ctx.lineTo(x + nose, y);
      ctx.quadraticCurveTo(x, y + 1, x, y + h * 0.62);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w, y + 1.5 * ui);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pax ? (c.color === "#e8edf3" ? "#d03b3b" : "rgba(255,255,255,0.85)") : "#f2c14e";
    ctx.fillRect(x, y + h * 0.64, w, Math.max(1, h * 0.12));
    ctx.fillStyle = "rgba(160,215,255,0.95)";
    const cw = Math.min(4.5 * ui, w * 0.22);
    const cx = dir > 0 ? x + w - nose - cw * 0.25 : x + nose - cw * 0.75;
    roundRect(ctx, cx, y + h * 0.16, cw, h * 0.3, 1);
    ctx.fill();
    if (w > 30 * ui) {
      ctx.fillStyle = "rgba(160,215,255,0.6)";
      for (let k = 0; k < 2; k++) ctx.fillRect(x + w * 0.35 + k * 6 * ui - (dir > 0 ? 0 : 6 * ui), y + h * 0.2, 3 * ui, h * 0.25);
    }
    ctx.strokeStyle = "rgba(210,210,200,0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * 0.12, y);
    ctx.lineTo(w * 0.04, y - 5 * ui);
    ctx.lineTo(w * 0.2, y - 5 * ui);
    ctx.stroke();
    if (speed > 8 && Math.random() < 0.05) {
      ctx.fillStyle = "rgba(210,230,255,0.95)";
      ctx.beginPath();
      ctx.arc(w * 0.12, y - 5.2 * ui, 1.6 * ui, 0, Math.PI * 2);
      ctx.fill();
      glow(ctx, w * 0.12, y - 5.2 * ui, 7 * ui, "180,210,255", 0.7);
    }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x, y + h - 1, w, 1);
    return;
  }
  if (c.kind === "coach") {
    ctx.fillStyle = body;
    roundRect(ctx, x, y, w, h, Math.min(3 * ui, w / 3));
    ctx.fill();
    ctx.fillStyle = shade(c.color, 0.85);
    ctx.fillRect(x + 1, y, Math.max(0, w - 2), 1.2 * ui);
    ctx.fillStyle = c.color === "#e8edf3" ? "#d03b3b" : "rgba(255,255,255,0.7)";
    ctx.fillRect(x, y + h * 0.7, w, Math.max(0.8, h * 0.08));
    const r = rng(c.seed);
    const n = Math.max(1, Math.floor(w / (3.6 * ui)));
    const ww = Math.max(0.8, Math.min(2.2 * ui, (w / n) * 0.55));
    for (let k = 0; k < n; k++) {
      const lit = r() > 0.18;
      ctx.fillStyle = lit ? (r() > 0.5 ? "#ffe08a" : "#ffd36a") : "#2a3340";
      ctx.fillRect(x + (k + 0.5) * (w / n) - ww / 2, y + h * 0.22, ww, h * 0.32);
    }
    if (w > 10 * ui) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x + 1.2 * ui, y + h * 0.15, 0.8 * ui, h * 0.75);
      ctx.fillRect(x + w - 2 * ui, y + h * 0.15, 0.8 * ui, h * 0.75);
    }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x, y + h - 1, w, 1);
    return;
  }
  if (c.kind === "tank") {
    ctx.fillStyle = body;
    roundRect(ctx, x, y + h * 0.18, w, h * 0.68, h * 0.34);
    ctx.fill();
    ctx.fillStyle = shade(c.color, 0.8);
    ctx.fillRect(x + w * 0.42, y + h * 0.05, Math.max(1, w * 0.16), h * 0.16);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x + 1, y + h * 0.26, Math.max(0, w - 2), 1);
    if (c.color === "#3b3f46") {
      ctx.fillStyle = "#f08a24";
      ctx.fillRect(x, y + h * 0.44, w, h * 0.14);
    }
  } else if (c.kind === "hopper" || c.kind === "gondola") {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.1);
    ctx.lineTo(x + w, y + h * 0.1);
    ctx.lineTo(x + w * (c.kind === "hopper" ? 0.84 : 1), y + h);
    ctx.lineTo(x + w * (c.kind === "hopper" ? 0.16 : 0), y + h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 0.6 * ui;
    for (let k = 1; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(x + (w * k) / 3, y + h * 0.12);
      ctx.lineTo(x + (w * k) / 3, y + h * 0.9);
      ctx.stroke();
    }
    ctx.fillStyle = c.kind === "gondola" ? "#2b241c" : "#4c3a2b";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + h * 0.12);
    ctx.quadraticCurveTo(x + w / 2, y - h * 0.08, x + w - 0.5, y + h * 0.12);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = body;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 0.6 * ui;
    const ribs = Math.max(1, Math.floor(w / (3 * ui)));
    for (let k = 1; k < ribs; k++) {
      ctx.beginPath();
      ctx.moveTo(x + (w * k) / ribs, y + 1);
      ctx.lineTo(x + (w * k) / ribs, y + h - 1);
      ctx.stroke();
    }
    if (c.kind === "reefer") {
      ctx.fillStyle = "#5aa0d0";
      ctx.fillRect(x, y + h * 0.4, w, h * 0.14);
      ctx.fillStyle = "#9fb3bd";
      ctx.fillRect(x + 1, y + 2, Math.min(3 * ui, w * 0.25), h * 0.3);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(x + w * 0.1, y + h * 0.35, Math.max(1, w * 0.25), h * 0.2);
    }
  }
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(x, y + h - 1, w, 1);
}

// ------------------------------------------------------------------ светофоры, таблички
const signalState = new Map<string, { green: boolean; since: number }>();

export function drawSignal(ctx: CanvasRenderingContext2D, lay: Layout, x: number, green: boolean, now: number, id = "") {
  const key = `${id}:${x}`;
  let st = signalState.get(key);
  if (!st) {
    st = { green, since: -1e9 };
    signalState.set(key, st);
  } else if (st.green !== green) {
    st.green = green;
    st.since = now;
  }
  const px = lay.map(x);
  const ui = lay.ui;
  const top = lay.loopY - 28 * ui;
  ctx.strokeStyle = "#7a7e8c";
  ctx.lineWidth = 1.8 * ui;
  ctx.beginPath();
  ctx.moveTo(px, lay.trackY - 4 * ui);
  ctx.lineTo(px, top + 14 * ui);
  ctx.stroke();
  ctx.strokeStyle = "rgba(170,175,190,0.5)";
  ctx.lineWidth = 0.8;
  for (let yy = top + 16 * ui; yy < lay.trackY - 5 * ui; yy += 3.2 * ui) {
    ctx.beginPath();
    ctx.moveTo(px - 2.2 * ui, yy);
    ctx.lineTo(px + 2.2 * ui, yy);
    ctx.stroke();
  }
  ctx.fillStyle = "#12141b";
  roundRect(ctx, px - 5 * ui, top, 10 * ui, 16 * ui, 3.5 * ui);
  ctx.fill();
  ctx.strokeStyle = "#3a3f4e";
  ctx.lineWidth = 1;
  ctx.stroke();
  const lensR = 2.7 * ui;
  const yRed = top + 5 * ui;
  const yGreen = top + 11.5 * ui;
  ctx.fillStyle = "#2a2e3a";
  ctx.fillRect(px - 4.5 * ui, yRed - lensR - 1.2 * ui, 9 * ui, 1.2 * ui);
  ctx.fillRect(px - 4.5 * ui, yGreen - lensR - 1.2 * ui, 9 * ui, 1.2 * ui);
  const pulse = 0.78 + 0.22 * Math.sin(now / 320);
  const ly = green ? yGreen : yRed;
  const rgb = green ? "41,209,122" : "255,74,61";
  glow(ctx, px, ly, 14 * ui, rgb, 0.55 * pulse);
  ctx.fillStyle = green ? "#2a1a1a" : "#1a2a22";
  ctx.beginPath();
  ctx.arc(px, green ? yRed : yGreen, lensR, 0, Math.PI * 2);
  ctx.fill();
  const lens = ctx.createRadialGradient(px - 0.8 * ui, ly - 0.8 * ui, 0, px, ly, lensR);
  lens.addColorStop(0, "#ffffff");
  lens.addColorStop(0.35, green ? "#6cf0a8" : "#ff8a7a");
  lens.addColorStop(1, green ? "#19b060" : "#d8322a");
  ctx.fillStyle = lens;
  ctx.beginPath();
  ctx.arc(px, ly, lensR, 0, Math.PI * 2);
  ctx.fill();
  const age = now - st.since;
  if (age < 800) {
    const u = age / 800;
    ctx.strokeStyle = `rgba(${rgb},${(1 - u) * 0.8})`;
    ctx.lineWidth = 2 * (1 - u) + 0.5;
    ctx.beginPath();
    ctx.arc(px, ly, lensR + u * 22 * ui, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, ui: number, W: number) {
  ctx.font = `700 ${Math.round(12 * ui)}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + 16 * ui;
  const h = 21 * ui;
  const left = Math.max(4, Math.min(W - w - 4, x - w / 2));
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = bg;
  roundRect(ctx, left, y - h, w, h, h / 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.fillText(text, left + 8 * ui, y - 6.5 * ui);
  return left + w / 2;
}

export function fmtKm(m: number): string {
  const km = m / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1).replace(".", ",")} км`;
}

export function fmtClock(t: number): string {
  const s = Math.max(0, Math.round(8 * 3600 + t));
  const hh = Math.floor(s / 3600) % 24;
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function fmtDur(s: number): string {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/** Окно времени, когда хоть один поезд виден на схеме. */
export function visibleWindow(res: MeetResult, lay: Layout): [number, number] {
  let a = Infinity;
  let b = 0;
  for (const o of res.options) {
    for (const [key, len] of [["pax", res.trains.pax.length_m], ["freight", res.trains.freight.length_m]] as const) {
      const segs = o.motion[key];
      const end = segs[segs.length - 1].t1;
      for (let t = 0; t <= end; t += 2) {
        const { x } = posAt(segs, t);
        const dir = key === "pax" ? 1 : -1;
        const tail = x - dir * lay.k * len;
        const vis = Math.max(x, tail) > lay.from && Math.min(x, tail) < lay.to;
        if (vis) {
          a = Math.min(a, t);
          b = Math.max(b, t);
        }
      }
    }
  }
  return [Math.max(0, a - 4), b + 2];
}

/** Сколько «натикало» к моменту t: цена варианта набирается, пока уступающий поезд тормозит, стоит и разгоняется. */
export function costAt(res: MeetResult, o: MeetOption, t: number): number {
  const side = o.yield === "pax" ? o.pax : o.freight;
  const tr = o.yield === "pax" ? res.trains.pax : res.trains.freight;
  if (o.econ <= 0) return 0;
  let a: number;
  let b: number;
  if (side.planned_stop) {
    a = side.dep - side.wait_s;
    b = side.dep + 1;
  } else if (side.stopped) {
    a = side.arr - tr.brake_s;
    b = side.dep + tr.accel_s;
  } else return 0;
  return o.econ * Math.max(0, Math.min(1, (t - a) / Math.max(1, b - a)));
}

export function sectionOwner(res: MeetResult, o: MeetOption, t: number): "pax" | "freight" | null {
  const L = res.geometry.section_m;
  const on = (key: "pax" | "freight") => {
    const { x } = posAt(o.motion[key], t);
    const dir = key === "pax" ? 1 : -1;
    const tail = x - dir * res.trains[key].length_m;
    return Math.max(x, tail) > 0 && Math.min(x, tail) < L;
  };
  return on("pax") ? "pax" : on("freight") ? "freight" : null;
}
