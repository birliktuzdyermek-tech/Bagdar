// График движения (время — по горизонтали, километр — по вертикали).
// Тонкие нитки — действующий план из записи, толстые — фактическое движение
// по кадрам до текущего момента. При смене плана старые нитки перетекают
// в новые за --t-slow (700 мс), изменённые подсвечиваются.
import { clock, shortStation } from "../lib/format";
import { easeOut } from "../lib/motion";
import { cssVar, GROUP_VAR, group } from "../lib/palette";
import type { ReplayModel } from "../replay/model";
import type { PlanLeg } from "../replay/types";

export interface Morph {
  fromPlan: number; // индекс плана в записи
  toPlan: number;
  started: number; // performance.now()
}

export interface GraphOpts {
  projector: boolean;
  selected: string | null;
  before: number; // секунд истории в окне
  after: number; // секунд будущего в окне
  morph: Morph | null;
  now: number;
  reduced: boolean;
}

export const MORPH_MS = 700;

export function drawGraph(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  m: ReplayModel,
  t: number,
  o: GraphOpts,
): void {
  const fs = o.projector ? 19 : 13;
  const left = o.projector ? 120 : 88;
  const right = 16;
  const top = 14;
  const bottom = fs + 16;
  const t0 = t - o.before;
  const t1 = t + o.after;
  const X = (tt: number) => left + ((tt - t0) / (t1 - t0)) * (w - left - right);
  const Y = (km: number) => top + (km / m.kmMax) * (h - top - bottom);
  const c = {
    grid: cssVar("--border"),
    text2: cssVar("--text-secondary"),
    text: cssVar("--text-primary"),
    accent: cssVar("--accent"),
    rail: cssVar("--rail"),
  };
  ctx.clearRect(0, 0, w, h);

  // станции
  ctx.font = `500 ${fs}px var(--font-ui), system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  let lastLabelY = -Infinity;
  for (const s of m.r.world.stations) {
    const y = Y(s.km);
    const big = s.kind !== "loop";
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = big ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    if (big || y - lastLabelY > fs + 2) {
      ctx.fillStyle = big ? c.text : c.text2;
      ctx.fillText(big ? s.name : shortStation(s.name), left - 8, y);
      lastLabelY = y;
    }
  }

  // сетка времени каждые 10 минут
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const stepT = 600;
  for (let tt = Math.ceil(t0 / stepT) * stepT; tt <= t1; tt += stepT) {
    const x = X(tt);
    const hour = tt % 3600 === 0;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = hour ? 1.5 : 0.75;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, h - bottom);
    ctx.stroke();
    if (hour || (tt / stepT) % 3 === 0) {
      ctx.fillStyle = c.text2;
      ctx.fillText(clock(tt, false), x, h - 6);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 4, w - left - right, h - top - bottom + 8);
  ctx.clip();

  // плановые нитки (с перетеканием при смене плана)
  const cur = m.planAt(t);
  if (cur) {
    const legs = m.legsByTrain(cur.i);
    let morphA = 1;
    let old: Map<string, PlanLeg[]> | null = null;
    if (o.morph && o.morph.toPlan === cur.i && !o.reduced) {
      morphA = Math.min(1, (o.now - o.morph.started) / MORPH_MS);
      if (morphA < 1) old = m.legsByTrain(o.morph.fromPlan);
    }
    const e = easeOut(morphA);
    for (const [tid, arr] of legs) {
      const tr = m.trains.get(tid);
      if (!tr) continue;
      const oldArr = old?.get(tid);
      const oldByK = oldArr ? new Map(oldArr.map((l) => [l.k, l])) : null;
      const col = cssVar(GROUP_VAR[group(tr.cls)]);
      const sel = o.selected === tid;
      let changed = false;
      ctx.beginPath();
      let first = true;
      for (const lg of arr) {
        if (lg.arr < t0 - 600 || lg.dep > t1 + 600) continue;
        const ol = oldByK?.get(lg.k);
        let dep = lg.dep;
        let arrT = lg.arr;
        if (ol) {
          if (Math.abs(ol.dep - lg.dep) > 20 || Math.abs(ol.arr - lg.arr) > 20) changed = true;
          dep = ol.dep + (lg.dep - ol.dep) * e;
          arrT = ol.arr + (lg.arr - ol.arr) * e;
        }
        const ka = m.stations.get(lg.from_id)?.km ?? 0;
        const kb = m.stations.get(lg.to_id)?.km ?? 0;
        if (first) ctx.moveTo(X(dep), Y(ka));
        else ctx.lineTo(X(dep), Y(ka)); // стоянка на станции
        ctx.lineTo(X(arrT), Y(kb));
        first = false;
      }
      ctx.strokeStyle = changed ? c.text : col; // не accent: он совпадает с цветом скорых
      ctx.globalAlpha = sel ? 0.95 : changed ? 0.9 : 0.42;
      ctx.lineWidth = sel ? 2.5 : changed ? 2.25 : 1.25;
      ctx.setLineDash(sel ? [] : [5, 4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // фактические нитки до текущего момента
  for (const [tid, tr] of m.traces) {
    const train = m.trains.get(tid);
    if (!train) continue;
    const sel = o.selected === tid;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < tr.t.length; i++) {
      const tt = tr.t[i];
      if (tt > t) break;
      if (tt < t0 - 60) continue;
      const x = X(tt);
      const y = Y(tr.km[i]);
      // разрыв нитки, если поезд пропадал из кадров
      if (!started || tt - tr.t[i - 1] > 3 * m.r.frame_interval_s) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (!started) continue;
    ctx.strokeStyle = cssVar(GROUP_VAR[group(train.cls)]);
    ctx.lineWidth = sel ? (o.projector ? 5 : 4) : o.projector ? 3.5 : 2.5;
    ctx.globalAlpha = o.selected && !sel ? 0.55 : 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // текущий момент
  const xn = X(t);
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = o.projector ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(xn, top - 4);
  ctx.lineTo(xn, h - bottom + 4);
  ctx.stroke();
  ctx.fillStyle = c.accent;
  ctx.font = `700 ${fs}px var(--font-ui), system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("сейчас", xn + 6, top + fs);
  ctx.fillStyle = c.text2;
  ctx.font = `500 ${fs}px var(--font-ui), system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText("план →", w - right - 4, top + fs);
}
