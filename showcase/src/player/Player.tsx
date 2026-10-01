import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { clock, minutes, num } from "../lib/format";
import { reducedMotionNow, useCountUp } from "../lib/motion";
import { cssVar, GROUP_LABEL, GROUP_VAR, trainStatus, TONE_VAR, type Group } from "../lib/palette";
import { ReplayModel } from "../replay/model";
import type { RunInfo, SimEvent } from "../replay/types";
import { Clock, SPEEDS } from "./clock";
import { drawGraph, MORPH_MS, type Morph } from "./graph";
import { drawScheme, hitTest, type Flash, type Hit } from "./scheme";

const UI_HZ = 4;
const FLASH_MS = 1500;

function useCanvas(): [React.RefObject<HTMLCanvasElement | null>, React.RefObject<{ w: number; h: number }>] {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const size = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      size.current = { w: r.width, h: r.height };
      cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

interface Props {
  model: ReplayModel;
  info: RunInfo;
  projector: boolean;
}

export function Player({ model, info, projector }: Props) {
  const clockRef = useRef<Clock | null>(null);
  if (!clockRef.current || clockRef.current.model !== model) clockRef.current = new Clock(model);
  const clk = clockRef.current;
  const ctl = useSyncExternalStore(clk.subscribe, () => `${clk.playing}|${clk.speed}|${clk.t}`);
  void ctl;

  const [schemeRef, schemeSize] = useCanvas();
  const [graphRef, graphSize] = useCanvas();
  const [uiT, setUiT] = useState(model.start);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const hits = useRef<Hit[]>([]);
  const flashes = useRef<Flash[]>([]);
  const morph = useRef<Morph | null>(null);
  const lastPlanI = useRef<number>(-1);
  const lastEventN = useRef<number>(0);
  const sel = useRef<string | null>(null);
  const hov = useRef<string | null>(null);
  sel.current = selected;
  hov.current = hover;

  const flash = useCallback((e: SimEvent) => {
    if (!e.station_id && !e.section_id) return;
    flashes.current.push({
      stationId: e.station_id,
      sectionId: e.station_id ? null : e.section_id,
      trainId: e.train_id,
      until: performance.now() + FLASH_MS,
      tone: e.kind === "decision" ? "--accent" : e.severity === "critical" ? "--critical" : "--warning",
    });
  }, []);

  // единый цикл кадров
  useEffect(() => {
    let raf = 0;
    let lastUi = 0;
    const loop = (now: number) => {
      clk.tick(now);
      const t = clk.t;
      const reduced = reducedMotionNow();
      // смена плана -> перетекание; новые решения -> вспышка места
      const p = model.planAt(t);
      if (p && p.i !== lastPlanI.current) {
        if (lastPlanI.current >= 0 && p.i === lastPlanI.current + 1 && clk.playing) {
          morph.current = { fromPlan: lastPlanI.current, toPlan: p.i, started: now };
        } else morph.current = null;
        lastPlanI.current = p.i;
      }
      const n = model.eventCountUpTo(t);
      if (n > lastEventN.current && clk.playing && n - lastEventN.current < 40) {
        for (let i = lastEventN.current; i < n; i++) {
          const e = model.r.events[i];
          if (e.kind === "decision" || e.severity === "warn" || e.severity === "critical") flash(e);
        }
      }
      lastEventN.current = n;
      flashes.current = flashes.current.filter((f) => f.until > now);

      const { frame } = model.frameAt(t);
      const trains = model.trainsAt(t, !reduced);
      const sc = schemeRef.current?.getContext("2d");
      if (sc && schemeSize.current.w) {
        hits.current = drawScheme(sc, schemeSize.current.w, schemeSize.current.h, model, trains, frame, {
          projector,
          selected: sel.current,
          hover: hov.current,
          flashes: flashes.current,
          now,
        });
      }
      const gc = graphRef.current?.getContext("2d");
      if (gc && graphSize.current.w) {
        const narrow = graphSize.current.w < 700;
        drawGraph(gc, graphSize.current.w, graphSize.current.h, model, t, {
          projector,
          selected: sel.current,
          before: narrow ? 2400 : 3600,
          after: narrow ? 1200 : 2400,
          morph: morph.current && now - morph.current.started < MORPH_MS ? morph.current : null,
          now,
          reduced,
        });
      }
      if (now - lastUi > 1000 / UI_HZ) {
        lastUi = now;
        setUiT(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clk, model, projector, flash, schemeRef, schemeSize, graphRef, graphSize]);

  // клавиатура
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        clk.toggle();
      } else if (e.key === "ArrowRight") clk.seek(clk.t + (e.shiftKey ? 600 : 60));
      else if (e.key === "ArrowLeft") clk.seek(clk.t - (e.shiftKey ? 600 : 60));
      else if (e.key === "Home") clk.seek(model.start);
      else if (e.key === "End") clk.seek(model.end);
      else if (e.key === "+" || e.key === "=") clk.faster(1);
      else if (e.key === "-") clk.faster(-1);
      else if (e.key === "Escape") setSelected(null);
      else return;
      setUiT(clk.t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clk, model]);

  const pickTrain = (e: React.PointerEvent<HTMLCanvasElement>, click: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    const id = hitTest(hits.current, e.clientX - r.left, e.clientY - r.top);
    if (click) setSelected(id);
    else if (id !== hover) setHover(id);
    e.currentTarget.style.cursor = id ? "pointer" : "default";
  };

  const seekTo = (e: SimEvent) => {
    clk.seek(e.t);
    flash(e);
    if (e.train_id) setSelected(e.train_id);
    setUiT(clk.t);
  };

  const { frame } = model.frameAt(uiT);
  const injected = info.injected ?? [];

  return (
    <div className="player">
      <section className="player-head" aria-label="О записи">
        <span className="badge badge-rec" title="Всё, что движется на экране, проигрывается из файла записи настоящего прогона Ядра">
          <span className="rec-dot" aria-hidden /> Запись прогона
        </span>
        <h1 className="player-title">{info.title}</h1>
        <span className="muted">
          {model.r.world.name} · seed {model.r.world.seed} · {info.from}–{info.to} модели
        </span>
        {info.note && <span className="muted small player-note">{info.note}</span>}
        {injected.map((d) => (
          <span key={d.at + d.train_id} className="badge badge-warn" title="Внешняя команда Ядру, как кнопка «задержать поезд» или POST /api/events">
            ⚑ {d.at}: поезд {model.trains.get(d.train_id)?.number ?? d.train_id} задержан на {d.minutes} мин ({d.reason})
          </span>
        ))}
      </section>

      <div className="player-main">
        <div className="player-canvases">
          <figure className="panel scheme-panel">
            <figcaption className="panel-title">
              Схема участка <span className="muted">· не в масштабе, длины перегонов в км</span>
            </figcaption>
            <canvas
              ref={schemeRef}
              className="cv cv-scheme"
              role="img"
              aria-label={`Схема участка на ${clock(uiT)}: ${frame.state.metrics.active_trains} поездов на участке`}
              onPointerMove={(e) => pickTrain(e, false)}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => pickTrain(e as unknown as React.PointerEvent<HTMLCanvasElement>, true)}
            />
            <Legend />
          </figure>
          <figure className="panel graph-panel">
            <figcaption className="panel-title">
              График движения <span className="muted">· пунктир — план, сплошная — факт по записи</span>
            </figcaption>
            <canvas ref={graphRef} className="cv cv-graph" role="img" aria-label="График движения поездов: план и факт" />
          </figure>
        </div>
        <aside className="player-side">
          <TimeCard t={uiT} />
          <PlannerCard model={model} t={uiT} />
          <MetricsCard model={model} t={uiT} />
          <IndexCard model={model} t={uiT} />
          {selected && <TrainCard model={model} t={uiT} id={selected} onClose={() => setSelected(null)} />}
          <Feed model={model} t={uiT} onPick={seekTo} />
        </aside>
      </div>

      <Transport clk={clk} model={model} t={uiT} onSeek={(t) => { clk.seek(t); setUiT(clk.t); }} />
    </div>
  );
}

function Legend() {
  const groups: Group[] = ["fast", "pax", "freight", "engine", "extra"];
  return (
    <ul className="legend" aria-label="Обозначения">
      {groups.map((g) => (
        <li key={g}>
          <svg width="22" height="14" viewBox="-11 -7 22 14" aria-hidden>
            <Shape g={g} />
          </svg>
          {GROUP_LABEL[g]}
        </li>
      ))}
      <li>
        <span className="legend-ring legend-ring-warn" aria-hidden>⏸</span> ожидает
      </li>
      <li>
        <span className="legend-ring legend-ring-crit" aria-hidden>▲</span> опаздывает сверх допуска
      </li>
    </ul>
  );
}

function Shape({ g }: { g: Group }) {
  const fill = `var(${GROUP_VAR[g]})`;
  if (g === "fast" || g === "pax") return <path d="M5.7,-3.6 L10.5,0 L5.7,3.6 Z M0,-6 a6,6 0 1,0 0.01,0 Z" fill={fill} />;
  if (g === "extra") return <path d="M-7.8,0 L0,-6.5 L7.8,0 L0,6.5 Z" fill={fill} />;
  if (g === "engine") return <rect x="-4.5" y="-4.5" width="9" height="9" fill={fill} />;
  return <rect x="-8" y="-4.8" width="16" height="9.6" fill={fill} />;
}

function TimeCard({ t }: { t: number }) {
  return (
    <div className="panel time-card">
      <span className="time-big" aria-live="off">{clock(t)}</span>
      <span className="muted">01.10.2026 · UTC+5 · время модели</span>
    </div>
  );
}

function PlannerCard({ model, t }: { model: ReplayModel; t: number }) {
  const { frame } = model.frameAt(t);
  const p = frame.state.planner;
  const plan = model.planAt(t);
  const solver: Record<string, string> = { cpsat: "CP-SAT", greedy: "эвристика", repair: "прежний порядок", hold: "удержание", timetable: "исходный график" };
  return (
    <div className="panel">
      <h2 className="panel-title">Планировщик</h2>
      {p ? (
        <dl className="kv">
          <dt>Действующий план</dt>
          <dd>v{p.version} · {solver[p.solver ?? ""] ?? p.solver ?? "—"}</dd>
          <dt>Статус</dt>
          <dd>{p.status === "feasible" ? "✓ допустим" : p.status === "delayed" ? "◐ допустим, есть задержки" : p.status === "infeasible" ? "✕ не найден" : p.status ?? "—"}</dd>
          <dt>Время расчёта</dt>
          <dd>{p.compute_ms != null ? `${num(p.compute_ms)} мс` : "—"}</dd>
          <dt title="Целевая функция плана, условные единицы">J плана</dt>
          <dd>{p.J != null ? `${num(p.J)} у.е.` : "—"} <span className="muted">условные</span></dd>
          <dt>Решений всего</dt>
          <dd>{p.cards_total}</dd>
        </dl>
      ) : (
        <p className="muted">В этой записи нет сводки планировщика.</p>
      )}
      {plan && <p className="muted small">Планов в записи: {model.r.plans.length}, этот с {clock(plan.t, false)}</p>}
    </div>
  );
}

function Metric({ label, value, unit, digits = 0, tone }: { label: string; value: number; unit?: string; digits?: number; tone?: string }) {
  const v = useCountUp(value);
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value" style={tone ? { color: `var(${tone})` } : undefined}>
        {num(v, digits)}
        {unit && <span className="metric-unit"> {unit}</span>}
      </span>
    </div>
  );
}

function MetricsCard({ model, t }: { model: ReplayModel; t: number }) {
  const m = model.frameAt(t).frame.state.metrics;
  return (
    <div className="panel">
      <h2 className="panel-title">Участок сейчас</h2>
      <div className="metrics">
        <Metric label="Поездов на участке" value={m.active_trains} />
        <Metric label="Ушли с участка" value={m.finished_trains} />
        <Metric label="Средняя задержка" value={m.avg_delay_s / 60} digits={1} unit="мин" />
        <Metric label="Максимальная" value={m.max_delay_s / 60} unit="мин" tone={m.max_delay_s > 900 ? "--warning" : undefined} />
        <Metric label="В допуске" value={m.on_time_share * 100} unit="%" />
        <Metric label="Ожидают" value={m.waiting_trains} tone={m.waiting_trains > 0 ? "--warning" : undefined} />
        <Metric label="Неплановых остановок" value={m.unplanned_stops} />
        <Metric label="Энергия на остановки" value={m.stop_energy_kwh} unit="кВт·ч" />
      </div>
    </div>
  );
}

function IndexCard({ model, t }: { model: ReplayModel; t: number }) {
  const idx = model.frameAt(t).frame.index;
  const v = useCountUp(idx?.value ?? 0);
  if (!idx) {
    return (
      <div className="panel">
        <h2 className="panel-title">Индекс участка</h2>
        <p className="muted">Индекс пока не рассчитан Ядром для этой записи. Число появится, когда Ядро начнёт записывать его в кадры.</p>
      </div>
    );
  }
  const tone = idx.status === "normal" ? "--good" : idx.status === "warning" ? "--warning" : "--critical";
  const word = idx.status === "normal" ? "Норма" : idx.status === "warning" ? "Внимание" : "Критично";
  return (
    <div className="panel">
      <h2 className="panel-title">Индекс участка</h2>
      <div className="index-row">
        <span className="index-value" style={{ color: `var(${tone})` }}>{Math.round(v)}</span>
        <span className="badge" style={{ borderColor: `var(${tone})` }}>{word}</span>
      </div>
      <ul className="factors">
        {Object.entries(idx.factors).map(([k, s]) => (
          <li key={k}>
            <span>{k}</span>
            <span className="bar"><span style={{ width: `${Math.round(s * 100)}%` }} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrainCard({ model, t, id, onClose }: { model: ReplayModel; t: number; id: string; onClose: () => void }) {
  const tr = model.trains.get(id);
  const st = model.frameAt(t).frame.state.trains.find((x) => x.id === id);
  if (!tr) return null;
  const tol = model.tolerance.get(tr.cls) ?? 1800;
  const where = st
    ? st.section_id
      ? `перегон ${model.stations.get(model.sections.get(st.section_id)?.a ?? "")?.name} — ${model.stations.get(model.sections.get(st.section_id)?.b ?? "")?.name}`
      : `ст. ${model.stations.get(st.station_id ?? "")?.name ?? "—"}`
    : "вне участка";
  const s = st ? trainStatus(st.display, st.delay_s, tol, !!st.wait_reason) : null;
  return (
    <div className="panel train-card">
      <div className="train-card-head">
        <h2 className="panel-title">Поезд {tr.number}</h2>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Закрыть карточку поезда">✕</button>
      </div>
      <p className="muted">{tr.cls_label} · {tr.direction > 0 ? "нечётное" : "чётное"} направление · {tr.length_m} м · {num(tr.mass_t)} т</p>
      {st && s ? (
        <dl className="kv">
          <dt>Статус</dt>
          <dd style={{ color: `var(${TONE_VAR[s.tone]})` }}>{s.icon} {s.word}</dd>
          <dt>Где</dt>
          <dd>{where}</dd>
          <dt>Скорость</dt>
          <dd>{num(st.v_kmh)} км/ч</dd>
          <dt>Задержка</dt>
          <dd>{minutes(st.delay_s)} мин <span className="muted">(допуск {Math.round(tol / 60)})</span></dd>
          {st.wait_reason && (
            <>
              <dt>Почему стоит</dt>
              <dd>{st.wait_reason}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted">Сейчас поезда нет на участке.</p>
      )}
    </div>
  );
}

const KIND_ICON: Record<string, string> = {
  decision: "◆",
  plan_published: "↻",
  train_delay: "▲",
  train_recovered: "✓",
  train_held: "⏸",
  train_delay_injected: "⚑",
  planner_error: "✕",
  scenario_loaded: "▶",
};

function Feed({ model, t, onPick }: { model: ReplayModel; t: number; onPick: (e: SimEvent) => void }) {
  const [all, setAll] = useState(false);
  const events = useMemo(() => {
    const list = model.eventsUpTo(t).filter((e) => (all ? e.severity !== "debug" : e.kind === "decision" || e.severity === "warn" || e.severity === "critical" || e.kind === "train_delay_injected"));
    return list.slice(-60).reverse();
  }, [model, t, all]);
  return (
    <div className="panel feed">
      <div className="feed-head">
        <h2 className="panel-title">Решения и события</h2>
        <label className="toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> все
        </label>
      </div>
      {events.length === 0 && <p className="muted">Пока ничего важного.</p>}
      <ol className="feed-list">
        {events.map((e) => {
          const level = e.kind === "decision" ? /^\[([ABC])\]/.exec(e.message)?.[1] : undefined;
          const text = level ? e.message.replace(/^\[[ABC]\]\s*/, "") : e.message;
          return (
            <li key={e.seq} className={`feed-item sev-${e.severity} kind-${e.kind}`}>
              <button className="feed-btn" onClick={() => onPick(e)} title="Перейти к этому моменту и показать место на схеме">
                <span className="feed-time">{clock(e.t, false)}</span>
                <span className="feed-icon" aria-hidden>{KIND_ICON[e.kind] ?? "•"}</span>
                {level && <span className={`lvl lvl-${level}`} title={level === "A" ? "A — применено автоматически" : level === "B" ? "B — авто с уведомлением" : "C — нужен выбор диспетчера"}>{level}</span>}
                <span className="feed-text">{text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Transport({ clk, model, t, onSeek }: { clk: Clock; model: ReplayModel; t: number; onSeek: (t: number) => void }) {
  const marks = useMemo(() => model.markers(), [model]);
  const span = model.end - model.start || 1;
  const markRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = markRef.current;
    if (!cv) return;
    const draw = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      const col: Record<string, string> = {
        plan: cssVar("--border-strong"),
        decision: cssVar("--accent"),
        warn: cssVar("--warning"),
        critical: cssVar("--critical"),
        injected: cssVar("--critical"),
      };
      for (const mk of marks) {
        const x = ((mk.t - model.start) / span) * r.width;
        ctx.fillStyle = col[mk.kind];
        const hgt = mk.kind === "plan" ? r.height * 0.35 : mk.kind === "injected" ? r.height : r.height * 0.7;
        ctx.fillRect(Math.round(x), r.height - hgt, mk.kind === "injected" ? 3 : 2, hgt);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [marks, model, span]);

  return (
    <div className="transport" role="group" aria-label="Управление воспроизведением">
      <button className="btn btn-primary btn-play" onClick={() => clk.toggle()} aria-label={clk.playing ? "Пауза (пробел)" : "Воспроизвести (пробел)"}>
        {clk.playing ? "❚❚ Пауза" : "▶ Пуск"}
      </button>
      <div className="speeds" role="radiogroup" aria-label="Скорость воспроизведения">
        {SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={clk.speed === s} className={`btn btn-speed ${clk.speed === s ? "on" : ""}`} onClick={() => clk.setSpeed(s)}>
            ×{s}
          </button>
        ))}
      </div>
      <div className="scrub">
        <canvas ref={markRef} className="scrub-marks" aria-hidden />
        <input
          type="range"
          className="scrub-range"
          min={model.start}
          max={model.end}
          step={1}
          value={t}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Перемотка записи"
          aria-valuetext={clock(t)}
        />
        <div className="scrub-ticks muted">
          <span>{clock(model.start, false)}</span>
          <span className="scrub-legend">
            <i className="mk mk-decision" /> решение <i className="mk mk-warn" /> опоздание <i className="mk mk-injected" /> внешняя команда
          </span>
          <span>{clock(model.end, false)}</span>
        </div>
      </div>
      <span className="keys muted" aria-hidden>
        пробел — пуск/пауза · ← → минута · Shift — 10 мин · + − скорость
      </span>
    </div>
  );
}
