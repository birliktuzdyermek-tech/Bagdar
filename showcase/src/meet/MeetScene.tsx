import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeetOption, MeetResult } from "./model";
import { posAt } from "./model";
import {
  type Layout, type TrainDraw, costAt, drawBackground, drawForeground, drawSignal, drawTrain, fmtClock, fmtDur,
  freightCars, makeLayout, paxCars, pill, sectionOwner, visibleWindow,
} from "./scene";

const SPEEDS = [30, 60, 120, 240];
const NAMES: [string, string] = ["Станция А", "Станция Б"];
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export interface SceneProps {
  res: MeetResult;
  /** Смена ключа — сцена начинается сначала (новый пример). */
  runKey: string;
  compact?: boolean;
  autoplay?: boolean;
  loop?: boolean;
  /** Ждать ответа зрителя перед запуском (игра «Решите сами»). */
  paused?: boolean;
  onReveal?: () => void;
  revealed?: boolean;
}

interface Particle { lane: number; x: number; y: number; text: string; born: number }

function laneTitle(o: MeetOption): [string, string] {
  return o.id === "pax_first"
    ? ["Первым едет пассажирский", "грузовой ждёт на станции Б"]
    : ["Первым едет грузовой", "пассажирский ждёт на станции А"];
}

function money(x: number): string {
  return `${Math.round(x).toLocaleString("ru-RU")} у.е.`;
}

export function MeetScene({ res, runKey, compact = false, autoplay = true, loop = false, paused = false, onReveal, revealed = false }: SceneProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([null, null]);
  const tickers = useRef<(HTMLSpanElement | null)[]>([null, null]);
  const [width, setWidth] = useState(1200);
  const [playing, setPlaying] = useState(autoplay && !paused);
  const [speed, setSpeed] = useState(compact ? 120 : 60);
  const [, setUiTick] = useState(0);
  const tRef = useRef(0);
  const particles = useRef<Particle[]>([]);
  const lastMin = useRef<number[]>([-1, -1]);
  const revealedRef = useRef(false);
  const H = compact ? 180 : 232;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, Math.round(el.clientWidth))));
    ro.observe(el);
    setWidth(Math.max(320, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const lay: Layout = useMemo(() => makeLayout(res, width, H, dpr), [res, width, H, dpr]);
  const [t0, t1] = useMemo(() => visibleWindow(res, lay), [res, lay]);
  const revealT = useMemo(() => {
    const deps = res.options.map((o) => (o.yield === "pax" ? o.pax.dep : o.freight.dep));
    return Math.min(t1, Math.max(...deps) + 45);
  }, [res, t1]);

  // фон и передний план — один раз на размер и пример
  const layers = useMemo(() => {
    const mk = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(width * dpr);
      c.height = Math.round(H * dpr);
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      return [c, ctx] as const;
    };
    const [bg, bctx] = mk();
    drawBackground(bctx, lay, res, NAMES);
    const [fg, fctx] = mk();
    drawForeground(fctx, lay);
    return { bg, fg };
  }, [lay, res, width, H, dpr]);

  const trains = useMemo(() => {
    const pc = paxCars(res);
    const fc = freightCars(res);
    return res.options.map((o): TrainDraw[] => [
      { segs: o.motion.pax, dir: 1, cars: pc, loop: o.yield === "pax" ? lay.loopA : null, pax: true },
      { segs: o.motion.freight, dir: -1, cars: fc, loop: o.yield === "freight" ? lay.loopB : null, pax: false },
    ]);
  }, [res, lay]);

  // новый пример — сначала
  useEffect(() => {
    tRef.current = t0;
    particles.current = [];
    lastMin.current = [-1, -1];
    revealedRef.current = false;
    setPlaying(autoplay && !paused);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  useEffect(() => {
    if (paused) setPlaying(false);
    else if (autoplay) setPlaying(true);
  }, [paused, autoplay]);

  useEffect(() => {
    if (tRef.current < t0 || tRef.current > t1) tRef.current = Math.min(Math.max(tRef.current, t0), t1);
  }, [t0, t1]);

  const draw = useCallback((now: number) => {
    const t = tRef.current;
    res.options.forEach((o, li) => {
      const cv = canvases.current[li];
      if (!cv) return;
      if (cv.width !== Math.round(width * dpr)) {
        cv.width = Math.round(width * dpr);
        cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(layers.bg, 0, 0, width, H);
      const yieldKey = o.yield;
      const firstKey = yieldKey === "pax" ? "freight" : "pax";
      const side = o[yieldKey];
      const owner = t < side.dep ? firstKey : yieldKey;
      const passed = (key: "pax" | "freight", sx: number) => {
        const { x } = posAt(o.motion[key], t);
        return key === "pax" ? x > sx : x < sx;
      };
      drawSignal(ctx, lay, lay.sigA, owner === "pax" && !passed("pax", lay.sigA), now);
      drawSignal(ctx, lay, lay.sigB, owner === "freight" && !passed("freight", lay.sigB), now);
      const drawn = trains[li].map((tr) => drawTrain(ctx, lay, tr, t, now));
      ctx.drawImage(layers.fg, 0, 0, width, H);
      const ui = lay.ui;
      // перегон за горой: кто на нём
      if (lay.brk) {
        const occ = sectionOwner(res, o, t);
        const cx = (lay.brk.px0 + lay.brk.px1) / 2;
        const label = occ === "pax" ? "▶ пассажирский в пути" : occ === "freight" ? "грузовой в пути ◀" : "перегон свободен";
        pill(ctx, cx, lay.trackY - 44 * ui, label, occ ? "rgba(250,178,25,0.92)" : "rgba(41,209,122,0.85)", "#141414", ui * 0.86, width);
        if (occ) {
          const { x } = posAt(o.motion[occ], t);
          const u = Math.max(0, Math.min(1, x / res.geometry.section_m));
          const a = lay.brk.px0 + 14 * ui;
          const b = lay.brk.px1 - 14 * ui;
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(a, lay.trackY - 30 * ui);
          ctx.lineTo(b, lay.trackY - 30 * ui);
          ctx.stroke();
          ctx.fillStyle = occ === "pax" ? "#5aa9ff" : "#f2c14e";
          ctx.beginPath();
          ctx.arc(a + (b - a) * u, lay.trackY - 30 * ui, 3.5 * ui, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // таблички над поездами
      (["pax", "freight"] as const).forEach((key, k) => {
        const d = drawn[k];
        if (!d.head) return;
        const s = o[key];
        const tr = res.trains[key];
        const waiting = s.stopped && t >= s.arr && t < s.dep;
        const [mx, my] = d.mid[0] ? d.mid : d.head;
        const top = Math.min(my, d.head[1]) - 22 * ui;
        if (waiting) {
          const planned = s.planned_stop && t < s.dep - s.wait_s;
          const txt = planned ? `⏱ стоянка по графику ${fmtDur(s.dep - s.wait_s - t)}`
            : `‖ ждёт ${fmtDur(t - (s.planned_stop ? s.dep - s.wait_s : s.arr))}`;
          pill(ctx, mx, top, txt, planned ? "rgba(90,169,255,0.92)" : "rgba(255,74,61,0.94)", "#fff", ui, width);
          if (key === "pax" && tr.passengers && !planned) pill(ctx, mx, top - 24 * ui, `👥 ${tr.passengers.toLocaleString("ru-RU")} пассажиров ждут`, "rgba(20,22,30,0.9)", "#ffe08a", ui * 0.92, width);
          if (key === "freight") pill(ctx, mx, top - 24 * ui, `${tr.mass_t.toLocaleString("ru-RU")} т стоят${res.params.freight.uphill ? " на подъёме" : ""}`, "rgba(20,22,30,0.9)", "#f2c14e", ui * 0.92, width);
          // ПТЭ: пассажирский вышел за допуск
          if (key === "pax" && o.pte_excess_min > 0 && t >= s.dep - o.pte_excess_min * 60) {
            pill(ctx, mx, top - 48 * ui, `⚠ сверх допуска ПТЭ (${tr.tolerance_min} мин)`, "rgba(208,59,59,0.96)", "#fff", ui * 0.92, width);
          }
          // монетки: каждая минута ожидания
          const minute = Math.floor((t - s.arr) / 60);
          if (playing && key === o.yield && !planned && minute > lastMin.current[li] && o.econ > 0) {
            lastMin.current[li] = minute;
            const per = o.econ / Math.max(1, (s.dep - s.arr) / 60 + 2);
            particles.current.push({ lane: li, x: mx + (Math.random() - 0.5) * 40 * ui, y: top - (key === "pax" && o.pte_excess_min > 0 ? 74 : 50) * ui, text: `−${Math.max(1, Math.round(per))} у.е.`, born: now });
          }
        } else if (Math.abs(d.v) > 1 && !compact) {
          pill(ctx, d.head[0] - (key === "pax" ? 40 : -40) * ui, d.head[1] - 22 * ui, `${Math.round(Math.abs(d.v) * 3.6)} км/ч`, "rgba(20,22,30,0.75)", "#e9e7df", ui * 0.85, width);
        }
      });
      // всплывающие «−N у.е.»
      particles.current = particles.current.filter((p) => now - p.born < 1600);
      for (const p of particles.current) {
        if (p.lane !== li) continue;
        const age = (now - p.born) / 1600;
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = "#ff7b6b";
        ctx.font = `800 ${Math.round(13 * ui)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(p.text, p.x, p.y - age * 36 * ui);
        ctx.globalAlpha = 1;
      }
      const tk = tickers.current[li];
      if (tk) tk.textContent = money(costAt(res, o, t));
    });
  }, [res, width, H, dpr, layers, lay, trains, playing, compact]);

  // цикл анимации
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let uiLast = 0;
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        tRef.current += dt * speed;
        if (tRef.current >= t1) {
          if (loop) {
            tRef.current = t0;
            particles.current = [];
            lastMin.current = [-1, -1];
          } else {
            tRef.current = t1;
            setPlaying(false);
          }
        }
      }
      if (!revealedRef.current && tRef.current >= revealT) {
        revealedRef.current = true;
        onReveal?.();
      }
      draw(now);
      if (now - uiLast > 120) {
        uiLast = now;
        setUiTick((x) => x + 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, t0, t1, loop, draw, revealT, onReveal]);

  const t = tRef.current;
  const showWin = revealed || t >= revealT;
  const restart = () => {
    tRef.current = t0;
    particles.current = [];
    lastMin.current = [-1, -1];
    setPlaying(true);
  };

  return (
    <div className={`meet-scene ${compact ? "compact" : ""}`} ref={wrapRef}>
      {res.options.map((o, li) => {
        const [title, sub] = laneTitle(o);
        const win = res.winner === o.id;
        return (
          <section key={o.id} className={`meet-lane ${showWin ? (win ? "win" : "lose") : ""}`} aria-label={`${title}: ${sub}`}>
            <header className="meet-lane-head">
              <span className="meet-lane-num">{li + 1}</span>
              <span className="meet-lane-title">{title}<span className="muted"> — {sub}</span></span>
              <span className="spacer" />
              {showWin && win && <span className="meet-badge win">✓ Бағдар выбирает это</span>}
              {showWin && !win && o.pte_excess_min > 0 && <span className="meet-badge pte">⚠ нарушение ПТЭ</span>}
              <span className="meet-ticker" title="Условная цена варианта: копится, пока уступающий поезд тормозит, стоит и разгоняется">
                потери <span ref={(el) => { tickers.current[li] = el; }}>0 у.е.</span>
              </span>
            </header>
            <canvas
              ref={(el) => { canvases.current[li] = el; }}
              style={{ width: "100%", height: H }}
              role="img"
              aria-label={`Анимация: ${title.toLowerCase()}, ${sub}`}
            />
          </section>
        );
      })}
      <div className="meet-controls">
        <button type="button" className="btn btn-primary meet-play" onClick={() => (t >= t1 ? restart() : setPlaying((p) => !p))} disabled={paused}
          aria-label={playing ? "Пауза" : "Пуск"}>
          {playing ? "❚❚ Пауза" : t >= t1 ? "↻ Ещё раз" : "▶ Пуск"}
        </button>
        <span className="meet-clock" aria-label="Время в модели">{fmtClock(t)}</span>
        <input className="meet-scrub" type="range" min={t0} max={t1} step={1} value={t} aria-label="Перемотка сцены"
          onChange={(e) => { tRef.current = Number(e.target.value); particles.current = []; }} />
        <span className="meet-speed" role="group" aria-label="Скорость">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`btn btn-ghost ${s === speed ? "on" : ""}`} onClick={() => setSpeed(s)}>×{s}</button>
          ))}
        </span>
      </div>
      {!compact && <p className="meet-note muted small">
        Движение — из расчёта: торможение, стоянка, разгон по характеристикам класса. Поезда и обгонные пути на схеме длиннее
        в {nf.format(lay.k)} раза — иначе вагонов не видно. Середина длинного перегона скрыта за горой — время там идёт по
        расчёту.
      </p>}
    </div>
  );
}
