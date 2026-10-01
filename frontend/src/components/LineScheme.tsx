import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { State, TrainState, World } from "../api/types";
import { computeAlarms } from "../lib/alarms";
import { delayLabel, DISPLAY_LABEL } from "../lib/format";
import { buildLayout, sectionEnds, SCHEME_H, SCHEME_W, trainPos, trainShape, Y0, type Layout } from "../lib/geometry";
import { classGroup, GROUP_COLOR, GROUP_LABEL } from "../lib/palette";
import { useSim, type Indexed } from "../store/sim";

/* Статический слой: станции, пути, перегоны, подписи. Перерисовывается только при смене мира. */
const StaticLayer = memo(function StaticLayer({ world, layout, onStation }: {
  world: World;
  layout: Layout;
  onStation: (id: string) => void;
}) {
  return (
    <g>
      {world.sections.map((sec) => {
        const [x1, x2] = sectionEnds(layout, sec.a, sec.b);
        const mid = (x1 + x2) / 2;
        return (
          <g key={sec.id}>
            {sec.tracks === 2 ? (
              <>
                <line className="rail" x1={x1} x2={x2} y1={Y0 - 4} y2={Y0 - 4} />
                <line className="rail" x1={x1} x2={x2} y1={Y0 + 4} y2={Y0 + 4} />
              </>
            ) : (
              <line className="rail" x1={x1} x2={x2} y1={Y0} y2={Y0} />
            )}
            <text className="sec-label" x={mid} y={Y0 + 40} textAnchor="middle">
              {sec.length_km.toFixed(1).replace(".", ",")} км{sec.signalling === "PAB" ? " · ПАБ" : ""}
            </text>
            <text className="sec-label" x={mid} y={Y0 + 50} textAnchor="middle">
              {sec.speed_limit_kmh} км/ч{sec.no_stop_uphill ? " · ⛰" : ""}
            </text>
          </g>
        );
      })}
      {world.stations.map((st, i) => {
        const x = layout.stationX.get(st.id)!;
        const bw = layout.boxW.get(st.id)!;
        const ys = st.tracks.map((t) => layout.trackY.get(t.id)!);
        const top = Math.min(...ys) - 7;
        const bottom = Math.max(...ys) + 7;
        const above = i % 2 === 0;
        const nameY = above ? Math.min(top, Y0 - 27) - 18 : Math.max(bottom, Y0 + 27) + 44;
        return (
          <g key={st.id}>
            <rect
              className="st-box"
              data-station={st.id}
              x={x - bw / 2}
              y={top}
              width={bw}
              height={bottom - top}
              rx={4}
              onClick={() => onStation(st.id)}
              role="button"
              aria-label={`Станция ${st.name}, путей ${st.tracks.length}`}
            >
              <title>{`${st.name} · ${st.km.toFixed(1)} км · путей: ${st.tracks.length}`}</title>
            </rect>
            {st.tracks.map((t) => {
              const y = layout.trackY.get(t.id)!;
              const inset = t.is_main ? 0 : 6;
              return (
                <g key={t.id} pointerEvents="none">
                  <line className="track-line" x1={x - bw / 2 + inset} x2={x + bw / 2 - inset} y1={y} y2={y} />
                  {!t.is_main && (
                    <>
                      <line className="track-line" x1={x - bw / 2} y1={Y0} x2={x - bw / 2 + inset} y2={y} />
                      <line className="track-line" x1={x + bw / 2} y1={Y0} x2={x + bw / 2 - inset} y2={y} />
                    </>
                  )}
                </g>
              );
            })}
            <text
              className={`st-name ${st.kind}`}
              x={x}
              y={nameY}
              textAnchor="middle"
              onClick={() => onStation(st.id)}
            >
              {st.kind === "loop" ? st.name.replace("Разъезд ", "Рзд ") : st.name}
            </text>
            <text className="st-km" x={x} y={nameY + 11} textAnchor="middle">
              {st.km.toFixed(1).replace(".", ",")}
            </text>
          </g>
        );
      })}
    </g>
  );
});

/* Динамика инфраструктуры: занятые и зарезервированные пути, светофоры, маршрут выбранного поезда. */
function InfraLayer({ world, idx, layout, state, selectedTrain, selectedStation, red }: {
  world: World;
  idx: Indexed;
  layout: Layout;
  state: State;
  selectedTrain: string | null;
  selectedStation: string | null;
  red: Set<string>;
}) {
  const trainsById = useMemo(() => new Map(state.trains.map((t) => [t.id, t])), [state]);
  const sel = selectedTrain ? idx.trains.get(selectedTrain) : undefined;
  const selState = selectedTrain ? trainsById.get(selectedTrain) : undefined;
  const signals = new Map(state.signals.map((s) => [s.id, s.state]));
  return (
    <g>
      {sel && selState && (
        <g pointerEvents="none">
          {sel.sections.slice(selState.k).map((sid) => {
            const sec = idx.sections.get(sid)!;
            const [x1, x2] = sectionEnds(layout, sec.a, sec.b);
            return <line key={sid} className="route-hl" x1={x1 - 6} x2={x2 + 6} y1={Y0} y2={Y0} />;
          })}
        </g>
      )}
      {selectedStation && (() => {
        const x = layout.stationX.get(selectedStation);
        const bw = layout.boxW.get(selectedStation) ?? 30;
        if (x == null) return null;
        return <rect x={x - bw / 2 - 4} y={Y0 - 44} width={bw + 8} height={88} rx={6} fill="none"
          stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />;
      })()}
      {state.tracks.map((t) => {
        if (!t.reserved && t.available) return null;
        const st = idx.stations.get(t.id.split("-")[0]);
        if (!st) return null;
        const x = layout.stationX.get(st.id)!;
        const bw = layout.boxW.get(st.id)!;
        const y = layout.trackY.get(t.id)!;
        const isMain = st.tracks.find((tt) => tt.id === t.id)?.is_main;
        const inset = isMain ? 0 : 6;
        if (!t.available) {
          const isRed = red.has(`track:${t.id}`);
          return <line key={t.id} x1={x - bw / 2 + inset} x2={x + bw / 2 - inset} y1={y} y2={y}
            stroke={isRed ? "var(--critical)" : "var(--serious)"} strokeWidth={3} pointerEvents="none" />;
        }
        return <line key={t.id} className="track-reserved" x1={x - bw / 2 + inset} x2={x + bw / 2 - inset} y1={y} y2={y}
          pointerEvents="none" />;
      })}
      {world.signals.map((sg) => {
        const sec = idx.sections.get(sg.section_id)!;
        const [x1, x2] = sectionEnds(layout, sec.a, sec.b);
        const s = signals.get(sg.id) ?? "closed";
        const x = sg.direction > 0 ? x1 + 6 : x2 - 6;
        const y = Y0 + (sg.direction > 0 ? 11 : -11);
        if (s === "fault") {
          const isRed = red.has(`signal:${sg.id}`);
          const c = isRed ? "var(--critical)" : "var(--serious)";
          return (
            <g key={sg.id} pointerEvents="none">
              <circle cx={x} cy={y} r={4} fill={c} />
              <path d={`M${x - 2.5},${y - 2.5} L${x + 2.5},${y + 2.5} M${x + 2.5},${y - 2.5} L${x - 2.5},${y + 2.5}`}
                stroke="var(--on-critical)" strokeWidth={1.3} />
            </g>
          );
        }
        return s === "open"
          ? <circle key={sg.id} cx={x} cy={y} r={3.2} fill="var(--good)" pointerEvents="none" />
          : <circle key={sg.id} cx={x} cy={y} r={2.6} fill="none" stroke="var(--text-muted)" strokeWidth={1} pointerEvents="none" />;
      })}
      {state.sections.filter((s) => s.status !== "open").map((s) => {
        const sec = idx.sections.get(s.id)!;
        const [x1, x2] = sectionEnds(layout, sec.a, sec.b);
        const isRed = red.has(`section:${s.id}`);
        const c = s.status === "closed" ? (isRed ? "var(--critical)" : "var(--serious)") : "var(--warning)";
        return (
          <line key={s.id} x1={x1} x2={x2} y1={Y0} y2={Y0} stroke={c} strokeWidth={4}
            strokeDasharray={s.status === "closed" ? "none" : "6 4"} pointerEvents="none" />
        );
      })}
    </g>
  );
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/* Слой поездов: обновляется каждый кадр, позиции интерполируются между кадрами состояния. */
function TrainsLayer({ layout, red, onHover }: {
  layout: Layout;
  red: Set<string>;
  onHover: (id: string | null, x?: number, y?: number) => void;
}) {
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { state, recvAt, prevRecvAt } = useSim.getState();
      const span = Math.max(16, recvAt - prevRecvAt);
      if (state?.running || performance.now() - recvAt < span + 50) setFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { state, prev, recvAt, prevRecvAt, idx, world, selectedTrain, selectTrain } = useSim.getState();
  if (!state || !idx || !world) return null;
  const tol = new Map(world.classes.map((c) => [c.key, c.tolerance_min * 60]));
  const alpha = prev ? Math.min(1, Math.max(0, (performance.now() - recvAt) / Math.max(16, recvAt - prevRecvAt))) : 1;
  const prevById = new Map<string, TrainState>(prev ? prev.trains.map((t) => [t.id, t]) : []);

  const items = state.trains.map((ts) => {
    const tr = idx.trains.get(ts.id);
    if (!tr) return null;
    const cur = trainPos(layout, idx, state, ts, tr.direction);
    if (!cur) return null;
    const p0 = prevById.get(ts.id);
    const old = p0 && prev ? trainPos(layout, idx, prev, p0, tr.direction) : null;
    const x = old ? lerp(old.x, cur.x, alpha) : cur.x;
    const y = old ? lerp(old.y, cur.y, alpha) : cur.y;
    const group = classGroup(tr.cls);
    const over = ts.delay_s >= (tol.get(tr.cls) ?? 1800) && ts.delay_s >= 120;
    const late = ts.delay_s >= 120; // на схеме подсвечиваем опоздание от 2 мин, точное — в карточке
    const isRed = red.has(`train:${ts.id}`);
    const ring = over ? (isRed ? "var(--critical)" : "var(--serious)") : late ? "var(--warning)" : "none";
    const selected = selectedTrain === ts.id;
    const dim = selectedTrain != null && !selected;
    const showLabel = cur.onSection || selected || late;
    const labelY = cur.onSection ? (tr.direction > 0 ? 18 : -10) : Y0 - y - 40;
    return (
      <g
        key={ts.id}
        className={`train${dim ? " train-dim" : ""}`}
        transform={`translate(${x.toFixed(2)},${y.toFixed(2)})`}
        onClick={(e) => {
          e.stopPropagation();
          selectTrain(selected ? null : ts.id);
        }}
        onMouseEnter={(e) => onHover(ts.id, e.clientX, e.clientY)}
        onMouseMove={(e) => onHover(ts.id, e.clientX, e.clientY)}
        onMouseLeave={() => onHover(null)}
        role="button"
        aria-label={`Поезд ${tr.number}, ${tr.cls_label}, ${DISPLAY_LABEL[ts.display] ?? ts.display}, ${delayLabel(ts.delay_s)}`}
      >
        <rect x={-15} y={-12} width={30} height={24} fill="transparent" />
        {selected && <circle r={13} fill="none" stroke="var(--accent)" strokeWidth={2} />}
        <path
          d={trainShape(group, tr.direction, cur.onSection ? 1 : 0.8)}
          fill={GROUP_COLOR[group]}
          stroke={ring === "none" ? "var(--surface-1)" : ring}
          strokeWidth={ring === "none" ? 1 : 2.4}
        />
        {showLabel && (
          <text className="train-label" y={labelY} textAnchor="middle">
            {tr.number}
            {late && (
              <tspan className="delay-text" fill={over ? (isRed ? "var(--critical)" : "var(--serious)") : "var(--warning)"}>
                {` +${Math.round(ts.delay_s / 60)}′`}
              </tspan>
            )}
          </text>
        )}
      </g>
    );
  });
  return <g>{items}</g>;
}

export function LineScheme() {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const state = useSim((s) => s.state);
  const selectedTrain = useSim((s) => s.selectedTrain);
  const selectedStation = useSim((s) => s.selectedStation);
  const selectStation = useSim((s) => s.selectStation);
  const selectTrain = useSim((s) => s.selectTrain);
  const layout = useMemo(() => (world ? buildLayout(world) : null), [world]);
  const alarms = useMemo(() => computeAlarms(world, idx, state), [world, idx, state]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  if (!world || !idx || !layout || !state) {
    return <div className="empty">Загрузка участка…</div>;
  }
  const onHover = (id: string | null, cx?: number, cy?: number) => {
    if (!id || cx == null || cy == null || !wrapRef.current) return setHover(null);
    const r = wrapRef.current.getBoundingClientRect();
    setHover({ id, x: cx - r.left + wrapRef.current.scrollLeft, y: cy - r.top });
  };
  const hoverTrain = hover ? idx.trains.get(hover.id) : undefined;
  const hoverState = hover ? state.trains.find((t) => t.id === hover.id) : undefined;

  return (
    <div className="scheme-wrap" ref={wrapRef}>
      <svg
        className="scheme-svg"
        viewBox={`0 0 ${SCHEME_W} ${SCHEME_H}`}
        role="img"
        aria-label={`Схема участка ${world.name}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) selectTrain(null);
        }}
      >
        <StaticLayer world={world} layout={layout} onStation={(id) => selectStation(id)} />
        <InfraLayer world={world} idx={idx} layout={layout} state={state} selectedTrain={selectedTrain}
          selectedStation={selectedStation} red={alarms.red} />
        <TrainsLayer layout={layout} red={alarms.red} onHover={onHover} />
      </svg>
      {hover && hoverTrain && hoverState && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 14, (wrapRef.current?.scrollWidth ?? 9999) - 220), top: hover.y + 14 }}>
          <b>{hoverTrain.number}</b> <span className="muted">· {hoverTrain.cls_label}</span>
          <div>{DISPLAY_LABEL[hoverState.display] ?? hoverState.display}, {Math.round(hoverState.v_kmh)} км/ч</div>
          <div>Опоздание: {delayLabel(hoverState.delay_s)}</div>
          {hoverState.next_station_id && (
            <div className="muted">Далее: {idx.stations.get(hoverState.next_station_id)?.name}</div>
          )}
          {hoverState.wait_reason && <div className="muted">Ожидает: {hoverState.wait_reason}</div>}
        </div>
      )}
    </div>
  );
}

export function SchemeLegend() {
  const groups = ["fast", "pax", "freight", "engine", "extra"] as const;
  return (
    <div className="legend" aria-label="Легенда схемы">
      {groups.map((g) => (
        <span className="legend-item" key={g}>
          <svg width="26" height="14" viewBox="-13 -7 26 14" aria-hidden>
            <path d={trainShape(g, 1)} fill={GROUP_COLOR[g]} />
          </svg>
          {GROUP_LABEL[g]}
        </span>
      ))}
      <span className="legend-item">
        <svg width="26" height="14" viewBox="-13 -7 26 14" aria-hidden>
          <path d={trainShape("freight", 1)} fill="var(--cls-freight)" stroke="var(--warning)" strokeWidth={2.4} />
        </svg>
        опоздание в допуске
      </span>
      <span className="legend-item">
        <svg width="26" height="14" viewBox="-13 -7 26 14" aria-hidden>
          <path d={trainShape("freight", 1)} fill="var(--cls-freight)" stroke="var(--critical)" strokeWidth={2.4} />
        </svg>
        сверх допуска (красным — не больше трёх самых дорогих)
      </span>
      <span className="legend-item">
        <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="3.5" fill="var(--good)" /></svg>
        светофор открыт
      </span>
      <span className="legend-item">
        <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="3" fill="none" stroke="var(--text-muted)" /></svg>
        закрыт
      </span>
      <span className="legend-item">
        <svg width="28" height="12" aria-hidden><line x1="2" x2="26" y1="6" y2="6" stroke="var(--rail)" strokeWidth="2.5" /></svg>
        однопутный
      </span>
      <span className="legend-item">
        <svg width="28" height="12" aria-hidden>
          <line x1="2" x2="26" y1="3" y2="3" stroke="var(--rail)" strokeWidth="2.5" />
          <line x1="2" x2="26" y1="9" y2="9" stroke="var(--rail)" strokeWidth="2.5" />
        </svg>
        двухпутный
      </span>
      <span className="legend-item">
        <svg width="28" height="12" aria-hidden><line x1="2" x2="26" y1="6" y2="6" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" /></svg>
        путь закреплён за поездом
      </span>
      <span className="legend-item">⛰ — тяжёлый поезд на подъёме не останавливать</span>
    </div>
  );
}
