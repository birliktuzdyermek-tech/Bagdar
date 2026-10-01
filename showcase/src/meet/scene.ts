// Рисование сцены «Кто первым?» на canvas: ночная степь, однопутный перегон, две станции
// с обгонными путями, светофоры, поезда с вагонами, фары, табло ожидания.
// Положения поездов — только из расчёта (MeetResult.options[].motion), сцена ничего не досчитывает.
import type { MeetOption, MeetResult, Seg } from "./model";
import { posAt } from "./model";

export const STRETCH = 3;           // поезда и обгонные пути на схеме длиннее в 3 раза — иначе вагонов не видно
const STOP_M = 150;                 // голова ждущего поезда — у выходного конца обгонного пути
const RAMP_M = 350;                 // стрелочный съезд на обгонный путь

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

// ------------------------------------------------------------------ фон
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ridge(ctx: CanvasRenderingContext2D, W: number, base: number, amp: number, seed: number, fill: string, H: number) {
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 6) {
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
  // балласт
  ctx.strokeStyle = "#2a2722";
  ctx.lineWidth = 9 * ui;
  path(ctx, pts);
  ctx.stroke();
  // шпалы
  ctx.strokeStyle = "#4a4136";
  ctx.lineWidth = 6 * ui;
  ctx.setLineDash([1.6 * ui, 4.2 * ui]);
  path(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
  // рельсы
  ctx.strokeStyle = "#a9a59a";
  ctx.lineWidth = 1.1 * ui;
  for (const off of [-1.8 * ui, 1.8 * ui]) {
    path(ctx, pts.map(([x, y]) => [x, y + off]));
    ctx.stroke();
  }
}

function path(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}

function loopPts(lay: Layout, g: LoopGeom): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = g.x1 - RAMP_M; x <= g.x2 + RAMP_M; x += 25) pts.push([lay.map(x), lay.trackY + loopFrac(g, x) * (lay.loopY - lay.trackY)]);
  return pts;
}

export function drawBackground(ctx: CanvasRenderingContext2D, lay: Layout, res: MeetResult, names: [string, string]) {
  const { W, H, ui, trackY } = lay;
  const sky = ctx.createLinearGradient(0, 0, 0, trackY);
  sky.addColorStop(0, "#070d1d");
  sky.addColorStop(0.5, "#13203d");
  sky.addColorStop(0.82, "#2c2a4a");
  sky.addColorStop(1, "#5a3a3e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const r = rng(11);
  for (let i = 0; i < Math.round(W / 14); i++) {
    const x = r() * W;
    const y = r() * trackY * 0.55;
    const a = 0.25 + r() * 0.6;
    ctx.fillStyle = `rgba(230,236,255,${a})`;
    ctx.fillRect(x, y, r() < 0.15 ? 1.6 : 1, r() < 0.15 ? 1.6 : 1);
  }
  // луна
  const mx = W * 0.86;
  const my = H * 0.16;
  const mg = ctx.createRadialGradient(mx, my, 2, mx, my, 40 * ui);
  mg.addColorStop(0, "rgba(255,244,214,0.5)");
  mg.addColorStop(1, "rgba(255,244,214,0)");
  ctx.fillStyle = mg;
  ctx.fillRect(mx - 40 * ui, my - 40 * ui, 80 * ui, 80 * ui);
  ctx.fillStyle = "#f3ead2";
  ctx.beginPath();
  ctx.arc(mx, my, 7 * ui, 0, Math.PI * 2);
  ctx.fill();
  ridge(ctx, W, trackY - 34 * ui, 46 * ui, 3, "#1a2034", H);
  ridge(ctx, W, trackY - 14 * ui, 24 * ui, 8, "#1d2230", H);
  const ground = ctx.createLinearGradient(0, trackY - 16 * ui, 0, H);
  ground.addColorStop(0, "#1b1f1b");
  ground.addColorStop(1, "#101310");
  ctx.fillStyle = ground;
  ctx.fillRect(0, trackY - 12 * ui, W, H);
  // контактная сеть: опоры и провод
  ctx.strokeStyle = "rgba(160,160,150,0.28)";
  ctx.lineWidth = 1;
  const wireY = trackY - 30 * ui;
  ctx.beginPath();
  ctx.moveTo(0, wireY);
  ctx.lineTo(W, wireY);
  ctx.stroke();
  for (let px = 18; px < W; px += 64 * ui) {
    if (lay.brk && px > lay.brk.px0 - 6 && px < lay.brk.px1 + 6) continue;
    ctx.beginPath();
    ctx.moveTo(px, trackY + 6 * ui);
    ctx.lineTo(px, wireY - 4 * ui);
    ctx.lineTo(px + 7 * ui, wireY - 4 * ui);
    ctx.stroke();
  }
  // пути
  rails(ctx, [[0, trackY], [W, trackY]], ui);
  rails(ctx, loopPts(lay, lay.loopA), ui);
  rails(ctx, loopPts(lay, lay.loopB), ui);
  // станции: платформа, вокзал, подпись
  for (const [i, xs] of [0, lay.L].entries()) {
    const px = lay.map(xs);
    ctx.fillStyle = "#3a3934";
    const pl = lay.map(xs + (i === 0 ? -1 : 1) * 420) - px;
    ctx.fillRect(Math.min(px, px + pl), trackY + 7 * ui, Math.abs(pl), 4 * ui);
    // вокзал
    const bx = px + (i === 0 ? -1 : 1) * 30 * ui - 13 * ui;
    const by = trackY + 15 * ui;
    ctx.fillStyle = "#2b2f3a";
    ctx.fillRect(bx, by, 26 * ui, 13 * ui);
    ctx.fillStyle = "#3d4352";
    ctx.beginPath();
    ctx.moveTo(bx - 3 * ui, by);
    ctx.lineTo(bx + 13 * ui, by - 8 * ui);
    ctx.lineTo(bx + 29 * ui, by);
    ctx.fill();
    ctx.fillStyle = "#ffd27a";
    for (let w = 0; w < 3; w++) ctx.fillRect(bx + (4 + w * 7) * ui, by + 4 * ui, 3.5 * ui, 4 * ui);
    ctx.fillStyle = "#e9e7df";
    ctx.font = `700 ${Math.round(13 * ui)}px system-ui, sans-serif`;
    ctx.textAlign = i === 0 ? "right" : "left";
    ctx.fillText(names[i], bx + (i === 0 ? -8 * ui : 34 * ui), by + 11 * ui);
  }
  // перегон: скобка и подпись
  const a = lay.map(lay.loopA.x2 + RAMP_M);
  const b = lay.map(lay.loopB.x1 - RAMP_M);
  const yb = trackY + 22 * ui;
  ctx.strokeStyle = "rgba(250,178,25,0.75)";
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
  ctx.fillText(lbl, Math.max(160 * ui, Math.min(W - 160 * ui, lx)), yb + 16 * ui);
}

/** Гора над серединой длинного перегона: поезд «уходит в тоннель» — часть перегона не помещается на экране. */
export function drawForeground(ctx: CanvasRenderingContext2D, lay: Layout) {
  if (!lay.brk) return;
  const { px0, px1 } = lay.brk;
  const { trackY, ui } = lay;
  const top = trackY - 74 * ui;
  const g = ctx.createLinearGradient(0, top, 0, trackY + 10 * ui);
  g.addColorStop(0, "#353b52");
  g.addColorStop(1, "#1d2130");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(px0 - 18 * ui, trackY + 10 * ui);
  const w = px1 - px0;
  ctx.bezierCurveTo(px0 + w * 0.05, trackY - 30 * ui, px0 + w * 0.18, top, px0 + w * 0.36, top + 6 * ui);
  ctx.bezierCurveTo(px0 + w * 0.5, top - 10 * ui, px0 + w * 0.62, top + 4 * ui, px0 + w * 0.7, top + 10 * ui);
  ctx.bezierCurveTo(px0 + w * 0.86, top + 18 * ui, px0 + w * 0.97, trackY - 30 * ui, px1 + 18 * ui, trackY + 10 * ui);
  ctx.closePath();
  ctx.fill();
  // снег на вершинах
  ctx.fillStyle = "rgba(220,228,240,0.18)";
  ctx.beginPath();
  ctx.moveTo(px0 + w * 0.3, top + 12 * ui);
  ctx.lineTo(px0 + w * 0.36, top + 6 * ui);
  ctx.lineTo(px0 + w * 0.44, top + 2 * ui);
  ctx.lineTo(px0 + w * 0.5, top - 4 * ui);
  ctx.lineTo(px0 + w * 0.56, top + 6 * ui);
  ctx.closePath();
  ctx.fill();
  // порталы тоннеля
  for (const x of [px0 + 4 * ui, px1 - 4 * ui]) {
    ctx.fillStyle = "#0a0b10";
    ctx.beginPath();
    ctx.moveTo(x - 9 * ui, trackY + 6 * ui);
    ctx.lineTo(x - 9 * ui, trackY - 6 * ui);
    ctx.arc(x, trackY - 6 * ui, 9 * ui, Math.PI, 0);
    ctx.lineTo(x + 9 * ui, trackY + 6 * ui);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#5a6072";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ поезда
export interface Car { len: number; kind: "loco" | "coach" | "tank" | "hopper" | "box" | "reefer" | "container" | "gondola"; color: string }

const CONTAINERS = ["#2f6fd6", "#d0743c", "#3a9d5d", "#c9c4b4", "#b8433a"];

export function paxCars(res: MeetResult): Car[] {
  const n = Math.round((res.trains.pax.length_m - 20) / 25);
  const cls = res.trains.pax.cls;
  const body = cls === "high_speed_passenger" ? "#e8edf3" : cls === "fast_passenger" ? "#2f6fd6" : "#199e70";
  return [{ len: 20, kind: "loco", color: body }, ...Array.from({ length: n }, () => ({ len: 25, kind: "coach" as const, color: body }))];
}

export function freightCars(res: MeetResult): Car[] {
  const n = Math.round((res.trains.freight.length_m - 34) / 14);
  const cargo = res.params.freight.cargo;
  const r = rng(Math.round(res.trains.freight.mass_t));
  const cars: Car[] = [{ len: 34, kind: "loco", color: "#c0392b" }];
  for (let i = 0; i < n; i++) {
    const u = r();
    let c: Car;
    if (cargo.includes("perishable") && u < 0.55) c = { len: 14, kind: "reefer", color: "#dfe6ea" };
    else if (cargo.includes("dangerous") && u < 0.5) c = { len: 14, kind: "tank", color: "#3b3f46" };
    else if ((cargo.includes("urgent") || cargo.includes("deadline")) && u < 0.6) c = { len: 14, kind: "container", color: CONTAINERS[i % CONTAINERS.length] };
    else {
      const v = r();
      c = v < 0.3 ? { len: 14, kind: "hopper", color: "#7a5236" } : v < 0.55 ? { len: 14, kind: "gondola", color: "#5d4a3a" }
        : v < 0.75 ? { len: 14, kind: "tank", color: "#6b6f76" } : { len: 14, kind: "container", color: CONTAINERS[Math.floor(v * 97) % CONTAINERS.length] };
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
    const w = Math.max(1.2, lay.k * c.len * lay.scaleAt(xc) - (tr.pax ? 1.1 : 0.7));
    const h = (c.kind === "loco" ? 14 : tr.pax ? 13 : c.kind === "gondola" || c.kind === "hopper" ? 10 : 11.5) * ui;
    ctx.save();
    ctx.translate(px, py - h / 2 - 2.2 * ui);
    ctx.rotate(ang);
    drawCar(ctx, c, w, h, tr.dir, tr.pax, ui);
    ctx.restore();
    if (i === 0) headPx = [px + tr.dir * (w / 2), py];
    if (i === tr.cars.length - 1) tailPx = [px - tr.dir * (w / 2), py];
  }
  // фара и хвостовой огонь
  if (headPx) {
    const [hx, hy] = headPx;
    const y = hy - 6 * ui;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const len = (v > 0.5 ? 90 : 34) * ui;
    const gr = ctx.createLinearGradient(hx, y, hx + tr.dir * len, y);
    gr.addColorStop(0, "rgba(255,240,200,0.42)");
    gr.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(hx, y - 2 * ui);
    ctx.lineTo(hx + tr.dir * len, y - 12 * ui);
    ctx.lineTo(hx + tr.dir * len, y + 10 * ui);
    ctx.lineTo(hx, y + 2 * ui);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,250,230,0.95)";
    ctx.beginPath();
    ctx.arc(hx, y, 1.8 * ui, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (tailPx) {
    const blink = Math.sin(now / 260) > -0.3 ? 1 : 0.35;
    ctx.fillStyle = `rgba(255,70,60,${blink})`;
    ctx.beginPath();
    ctx.arc(tailPx[0], tailPx[1] - 6 * ui, 1.6 * ui, 0, Math.PI * 2);
    ctx.fill();
  }
  return { head: headPx, mid, v, x: xf };
}

function drawCar(ctx: CanvasRenderingContext2D, c: Car, w: number, h: number, dir: number, pax: boolean, ui: number) {
  const x = -w / 2;
  const y = -h / 2;
  if (c.kind === "loco") {
    ctx.fillStyle = c.color;
    ctx.beginPath();
    const nose = Math.min(w * 0.35, 6 * ui);
    if (dir > 0) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w - nose, y);
      ctx.quadraticCurveTo(x + w, y + 1, x + w, y + h * 0.6);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
    } else {
      ctx.moveTo(x + w, y);
      ctx.lineTo(x + nose, y);
      ctx.quadraticCurveTo(x, y + 1, x, y + h * 0.6);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + w, y + h);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pax ? (c.color === "#e8edf3" ? "#d03b3b" : "#f2f2f2") : "#f2c14e";
    ctx.fillRect(x, y + h * 0.62, w, Math.max(1, h * 0.13));
    // окно кабины
    ctx.fillStyle = "#9fd0ff";
    const cw = Math.min(4 * ui, w * 0.25);
    ctx.fillRect(dir > 0 ? x + w - nose - cw * 0.2 : x + nose - cw * 0.8, y + h * 0.18, cw, h * 0.28);
    // токоприёмник
    ctx.strokeStyle = "rgba(200,200,190,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, y);
    ctx.lineTo(w * 0.05, y - 4 * ui);
    ctx.lineTo(w * 0.2, y - 4 * ui);
    ctx.stroke();
    return;
  }
  if (c.kind === "coach") {
    ctx.fillStyle = c.color;
    roundRect(ctx, x, y, w, h, Math.min(2.5 * ui, w / 3));
    ctx.fill();
    ctx.fillStyle = c.color === "#e8edf3" ? "#d03b3b" : "rgba(255,255,255,0.75)";
    ctx.fillRect(x, y + h * 0.72, w, Math.max(0.8, h * 0.08));
    ctx.fillStyle = "#ffe08a";
    const n = Math.max(1, Math.floor(w / (3.4 * ui)));
    const ww = Math.max(0.8, Math.min(2 * ui, (w / n) * 0.55));
    for (let k = 0; k < n; k++) ctx.fillRect(x + (k + 0.5) * (w / n) - ww / 2, y + h * 0.22, ww, h * 0.3);
    return;
  }
  if (c.kind === "tank") {
    ctx.fillStyle = c.color;
    roundRect(ctx, x, y + h * 0.15, w, h * 0.7, h * 0.35);
    ctx.fill();
    if (c.color === "#3b3f46") {
      ctx.fillStyle = "#f08a24";
      ctx.fillRect(x, y + h * 0.42, w, h * 0.14);
    }
  } else if (c.kind === "hopper" || c.kind === "gondola") {
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.1);
    ctx.lineTo(x + w, y + h * 0.1);
    ctx.lineTo(x + w * (c.kind === "hopper" ? 0.85 : 1), y + h);
    ctx.lineTo(x + w * (c.kind === "hopper" ? 0.15 : 0), y + h);
    ctx.closePath();
    ctx.fill();
    if (c.kind === "gondola") {
      ctx.fillStyle = "#2a241d";
      ctx.fillRect(x + 0.5, y + h * 0.1, Math.max(0.5, w - 1), h * 0.2);
    }
  } else {
    ctx.fillStyle = c.color;
    ctx.fillRect(x, y, w, h);
    if (c.kind === "reefer") {
      ctx.fillStyle = "#7fb6d9";
      ctx.fillRect(x, y + h * 0.4, w, h * 0.12);
    }
  }
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x, y + h - 1, w, 1);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ светофоры, таблички
export function drawSignal(ctx: CanvasRenderingContext2D, lay: Layout, x: number, green: boolean, now: number) {
  const px = lay.map(x);
  const ui = lay.ui;
  const top = lay.loopY - 26 * ui;
  ctx.strokeStyle = "#6f7180";
  ctx.lineWidth = 1.6 * ui;
  ctx.beginPath();
  ctx.moveTo(px, lay.trackY - 4 * ui);
  ctx.lineTo(px, top + 12 * ui);
  ctx.stroke();
  ctx.fillStyle = "#15161c";
  roundRect(ctx, px - 4.5 * ui, top, 9 * ui, 15 * ui, 3 * ui);
  ctx.fill();
  const col = green ? "#29d17a" : "#ff4a3d";
  const ly = green ? top + 11 * ui : top + 4.5 * ui;
  const pulse = 0.75 + 0.25 * Math.sin(now / 300);
  const g = ctx.createRadialGradient(px, ly, 0, px, ly, 12 * ui);
  g.addColorStop(0, green ? `rgba(41,209,122,${0.55 * pulse})` : `rgba(255,74,61,${0.55 * pulse})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(px - 12 * ui, ly - 12 * ui, 24 * ui, 24 * ui);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(px, ly, 2.6 * ui, 0, Math.PI * 2);
  ctx.fill();
}

export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, ui: number, W: number) {
  ctx.font = `700 ${Math.round(12 * ui)}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + 14 * ui;
  const h = 20 * ui;
  const left = Math.max(4, Math.min(W - w - 4, x - w / 2));
  ctx.fillStyle = bg;
  roundRect(ctx, left, y - h, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.fillText(text, left + 7 * ui, y - 6 * ui);
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

/** Сколько у.е. «натикало» к моменту t: цена варианта набирается, пока уступающий поезд тормозит, стоит и разгоняется. */
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
