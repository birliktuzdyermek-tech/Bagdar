// График движения: время по горизонтали, станции по вертикали.
// Серая — исходное расписание, пунктир — действующий план, сплошная — факт,
// точки — прогноз без пересчёта (план, сдвинутый на текущие отклонения).
// Конфликт виден как пересечение ниток и подсвечивается до того, как случился.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Plan, State, World } from "../api/types";
import { useEChart } from "../lib/echarts";
import { classGroup, GROUP_LABEL, type ClassGroup } from "../lib/palette";
import { clock, delayLabel } from "../lib/format";
import { groupColor, useTokens, type Tokens } from "../lib/theme";
import { usePlans } from "../store/plans";
import { useSim, type Indexed } from "../store/sim";

const BEFORE = 3600;
const AFTER = 7200;
const GROUPS: ClassGroup[] = ["fast", "pax", "freight", "engine", "extra"];
type Pt = (number | string)[];
const GAP: Pt = ["-", "-"];

interface Threads {
  sched: Map<string, number[][]>;
  plan: Map<string, number[][]>;
  prev: Map<string, number[][]>;
  proj: Map<string, number[][]>;
  fact: Map<string, number[][]>;
}

function kmOf(idx: Indexed, sid: string): number {
  return idx.stations.get(sid)?.km ?? 0;
}

function planThreads(idx: Indexed, plan: Plan | null, now: number, onlyFuture = false): Map<string, number[][]> {
  const out = new Map<string, number[][]>();
  if (!plan) return out;
  for (const lg of plan.legs) {
    if (onlyFuture && lg.arr < now) continue;
    let pts = out.get(lg.train_id);
    if (!pts) {
      pts = [];
      out.set(lg.train_id, pts);
    }
    pts.push([lg.dep, kmOf(idx, lg.from_id)], [lg.arr, kmOf(idx, lg.to_id)]);
  }
  return out;
}

function liveKm(idx: Indexed, st: State, id: string): number | null {
  const ts = st.trains.find((x) => x.id === id);
  if (!ts) return null;
  if (ts.section_id && ts.progress != null) {
    const sec = idx.sections.get(ts.section_id);
    if (!sec) return null;
    const a = kmOf(idx, sec.a);
    const b = kmOf(idx, sec.b);
    return a + (b - a) * ts.progress;
  }
  return ts.station_id ? kmOf(idx, ts.station_id) : null;
}

function buildThreads(world: World, idx: Indexed, st: State, plans: ReturnType<typeof usePlans.getState>,
  conflictTrains: Set<string>, showPrev: boolean): Threads {
  const sched = new Map<string, number[][]>();
  for (const tr of world.trains) {
    const pts: number[][] = [];
    for (const s of tr.schedule) {
      const km = kmOf(idx, s.station_id);
      if (s.arr != null) pts.push([s.arr, km]);
      if (s.dep != null && s.dep !== s.arr) pts.push([s.dep, km]);
    }
    sched.set(tr.id, pts);
  }
  const fact = new Map<string, number[][]>();
  for (const [tid, pts] of plans.traces) fact.set(tid, pts.slice());
  for (const ts of st.trains) {
    const km = liveKm(idx, st, ts.id);
    if (km == null) continue;
    const pts = fact.get(ts.id) ?? [];
    pts.push([st.t, km]);
    fact.set(ts.id, pts);
  }
  const proj = new Map<string, number[][]>();
  const p = planThreads(idx, plans.projected, st.t, true);
  for (const tid of conflictTrains) {
    const v = p.get(tid);
    if (v) proj.set(tid, v);
  }
  return {
    sched,
    plan: planThreads(idx, plans.current, st.t, true),
    prev: showPrev ? planThreads(idx, plans.previous, st.t) : new Map(),
    proj,
    fact,
  };
}

function merged(map: Map<string, number[][]>, ids: Iterable<string>, t0: number, t1: number): Pt[] {
  const out: Pt[] = [];
  for (const id of ids) {
    const pts = map.get(id);
    if (!pts || pts.length < 2) continue;
    if (pts[pts.length - 1][0] < t0 || pts[0][0] > t1) continue;
    for (const q of pts) out.push(q);
    out.push(GAP);
  }
  return out;
}

interface Hit {
  tid: string;
  layer: string;
  x: number;
  y: number;
  t: number;
}

export function TimeGraph() {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const selected = useSim((s) => s.selectedTrain);
  const selectTrain = useSim((s) => s.selectTrain);
  const focusSeq = useSim((s) => s.focusSeq);
  const tokens = useTokens();
  const [follow, setFollow] = useState(true);
  useEffect(() => setFollow(true), [focusSeq]);
  const [showPrev, setShowPrev] = useState(false);
  const [hit, setHit] = useState<Hit | null>(null);
  const win = useRef<[number, number] | null>(null);
  const threadsRef = useRef<Threads | null>(null);
  const programmatic = useRef(false);
  const { ref, chart } = useEChart((c) => {
    c.on("datazoom", () => {
      if (programmatic.current) return;
      const dz = (c.getOption() as { dataZoom?: { startValue?: number; endValue?: number }[] }).dataZoom?.[0];
      if (dz?.startValue != null && dz?.endValue != null) win.current = [dz.startValue, dz.endValue];
      setFollow(false);
    });
  });

  const stations = useMemo(() => world?.stations ?? [], [world]);
  const kmName = useMemo(() => new Map(stations.map((s) => [s.km.toFixed(3), s.name])), [stations]);

  // перерисовка не чаще 2 раз в секунду: данные берутся из хранилищ на момент кадра
  useEffect(() => {
    const draw = () => {
      const c = chart.current;
      const st = useSim.getState().state;
      const plans = usePlans.getState();
      if (!c || !world || !idx || !st) return;
      const conflicts = st.conflicts ?? [];
      const conflictTrains = new Set(conflicts.flatMap((x) => x.trains));
      const th = buildThreads(world, idx, st, plans, conflictTrains, showPrev);
      threadsRef.current = th;
      const now = st.t;
      const [t0, t1] = follow || !win.current ? [now - BEFORE, now + AFTER] : win.current;
      const byGroup = new Map<ClassGroup, string[]>(GROUPS.map((g) => [g, []]));
      for (const tr of world.trains) byGroup.get(classGroup(tr.cls))!.push(tr.id);
      const dim = selected ? 0.28 : 1;
      const allIds = world.trains.map((t) => t.id);
      const series: Record<string, unknown>[] = [];
      series.push({
        name: "sched", type: "line", silent: true, symbol: "none", data: merged(th.sched, allIds, t0, t1),
        lineStyle: { width: 1, color: tokens["--text-muted"], opacity: 0.45 * dim }, z: 1, animation: false,
        markLine: {
          silent: true, symbol: "none", animation: false, label: { show: false },
          lineStyle: { color: tokens["--border"], width: 1, type: "solid" },
          data: stations.map((s) => ({ yAxis: s.km })),
        },
      });
      if (showPrev) {
        series.push({
          name: "prev", type: "line", silent: true, symbol: "none", data: merged(th.prev, allIds, t0, t1),
          lineStyle: { width: 1, color: tokens["--text-secondary"], type: [2, 3], opacity: 0.8 * dim }, z: 2,
          animation: false,
        });
      }
      for (const g of GROUPS) {
        const ids = byGroup.get(g)!;
        if (!ids.length) continue;
        const col = groupColor(tokens, g);
        series.push({
          name: `plan-${g}`, type: "line", silent: true, symbol: "none", data: merged(th.plan, ids, t0, t1),
          lineStyle: { width: 1.5, color: col, type: [6, 4], opacity: 0.9 * dim }, z: 3, animation: false,
        });
        series.push({
          name: `fact-${g}`, type: "line", silent: true, symbol: "none", data: merged(th.fact, ids, t0, t1),
          lineStyle: { width: 2, color: col, opacity: dim }, z: 4, animation: false,
        });
      }
      series.push({
        name: "proj", type: "line", silent: true, symbol: "none", data: merged(th.proj, th.proj.keys(), t0, t1),
        lineStyle: { width: 2, color: tokens["--warning"], type: "dotted" }, z: 5, animation: false,
      });
      if (selected && idx.trains.has(selected)) {
        const col = groupColor(tokens, classGroup(idx.trains.get(selected)!.cls));
        series.push(
          { name: "sel-sched", type: "line", silent: true, symbol: "none", data: merged(th.sched, [selected], -1e9, 1e9),
            lineStyle: { width: 1.5, color: tokens["--text-secondary"] }, z: 6, animation: false },
          { name: "sel-plan", type: "line", silent: true, symbol: "none", data: merged(th.plan, [selected], -1e9, 1e9),
            lineStyle: { width: 2.5, color: col, type: [6, 4] }, z: 7, animation: false },
          { name: "sel-fact", type: "line", silent: true, symbol: "none", data: merged(th.fact, [selected], -1e9, 1e9),
            lineStyle: { width: 3.5, color: col }, z: 8, animation: false },
        );
      }
      // конфликты: область на ресурсе вокруг момента, с таймером
      const areas: unknown[] = [];
      for (const cf of conflicts) {
        let a: number | null = null;
        let b: number | null = null;
        const sec = idx.sections.get(cf.resource);
        if (sec) {
          a = kmOf(idx, sec.a);
          b = kmOf(idx, sec.b);
        } else {
          const sid = cf.resource.split(/[-:]/)[0];
          if (idx.stations.has(sid)) a = b = kmOf(idx, sid);
        }
        if (a == null || b == null) continue;
        const lo = Math.min(a, b) - 0.6;
        const hi = Math.max(a, b) + 0.6;
        areas.push([
          { xAxis: cf.t - 180, yAxis: lo, name: `⚠ ${Math.max(0, Math.round(cf.in_s / 60))} мин` },
          { xAxis: cf.t + 180, yAxis: hi },
        ]);
      }
      // закрытые перегоны: полоса по километрам от момента закрытия до ожидаемого открытия
      const closed = (st.incidents ?? []).filter((i) => i.kind === "section_closed" && i.section_id);
      const closedAreas = closed.map((i) => {
        const sec = idx.sections.get(i.section_id as string)!;
        const a = kmOf(idx, sec.a);
        const b = kmOf(idx, sec.b);
        return [{ xAxis: i.t, yAxis: Math.min(a, b), name: "закрыт" }, { xAxis: i.until ?? now + AFTER, yAxis: Math.max(a, b) }];
      });
      series.push({
        name: "closed", type: "line", silent: true, symbol: "none", data: [], animation: false,
        markArea: {
          silent: true, animation: false,
          itemStyle: { color: tokens["--serious"], opacity: 0.18, borderColor: tokens["--serious"], borderWidth: 1, borderType: "dashed" },
          label: { color: tokens["--text-secondary"], fontSize: 10, position: "insideTopLeft" },
          data: closedAreas,
        },
      });
      series.push({
        name: "now", type: "line", silent: true, symbol: "none", data: [], animation: false,
        markLine: {
          silent: true, symbol: "none", animation: false,
          lineStyle: { color: tokens["--accent"], width: 1.5, type: "solid" },
          label: { formatter: "сейчас", color: tokens["--text-secondary"], fontSize: 10, position: "insideEndTop" },
          data: [{ xAxis: now }],
        },
        markArea: {
          silent: true, animation: false,
          itemStyle: { color: tokens["--warning"], opacity: 0.22, borderColor: tokens["--warning"], borderWidth: 1.5 },
          label: { color: tokens["--text-primary"], fontSize: 11, fontWeight: 700, position: "insideTop" },
          data: areas,
        },
      });
      const maxKm = stations.length ? stations[stations.length - 1].km : 100;
      programmatic.current = true;
      c.setOption({
        animation: false,
        grid: { left: 92, right: 14, top: 10, bottom: 26 },
        xAxis: {
          type: "value", min: t0, max: t1, splitNumber: 8,
          axisLabel: { formatter: (v: number) => clock(v, false), color: tokens["--text-muted"], fontSize: 10.5 },
          axisLine: { lineStyle: { color: tokens["--border-strong"] } },
          splitLine: { show: true, lineStyle: { color: tokens["--border"], opacity: 0.5 } },
          axisTick: { show: false },
        },
        yAxis: {
          type: "value", inverse: true, min: 0, max: maxKm,
          axisLabel: {
            customValues: stations.map((s) => s.km), color: tokens["--text-secondary"], fontSize: 10,
            formatter: (v: number) => kmName.get(v.toFixed(3)) ?? "", hideOverlap: true,
          },
          axisTick: { show: false }, splitLine: { show: false },
          axisLine: { lineStyle: { color: tokens["--border-strong"] } },
        },
        dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none", startValue: t0, endValue: t1,
          zoomOnMouseWheel: "shift", moveOnMouseMove: true, moveOnMouseWheel: false }],
        series,
      }, { replaceMerge: ["series"] });
      programmatic.current = false;
    };
    draw();
    const id = window.setInterval(draw, 500);
    return () => window.clearInterval(id);
  }, [chart, world, idx, selected, showPrev, follow, tokens, stations, kmName]);

  // наведение и клик: ближайшая нитка в пределах 8 px (целиться в линию толщиной 2 px не нужно)
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const zr = c.getZr();
    const find = (px: number, py: number): Hit | null => {
      const th = threadsRef.current;
      if (!th || !c.containPixel({ gridIndex: 0 }, [px, py])) return null;
      const p0 = c.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[];
      const p1 = c.convertToPixel({ gridIndex: 0 }, [3600, 10]) as number[];
      const ax = (p1[0] - p0[0]) / 3600;
      const ay = (p1[1] - p0[1]) / 10;
      const toPx = (t: number, km: number) => [p0[0] + ax * t, p0[1] + ay * km];
      let best: Hit | null = null;
      let bestD = 8;
      const scan = (map: Map<string, number[][]>, layer: string) => {
        for (const [tid, pts] of map) {
          for (let i = 0; i + 1 < pts.length; i++) {
            const [x1, y1] = toPx(pts[i][0], pts[i][1]);
            const [x2, y2] = toPx(pts[i + 1][0], pts[i + 1][1]);
            if ((px < Math.min(x1, x2) - 8) || (px > Math.max(x1, x2) + 8)) continue;
            const dx = x2 - x1;
            const dy = y2 - y1;
            const L = dx * dx + dy * dy;
            const u = L > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
            const d = Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
            if (d < bestD) {
              bestD = d;
              best = { tid, layer, x: px, y: py, t: pts[i][0] + u * (pts[i + 1][0] - pts[i][0]) };
            }
          }
        }
      };
      scan(th.fact, "факт");
      scan(th.plan, "план");
      scan(th.proj, "прогноз без пересчёта");
      return best;
    };
    const onMove = (e: { offsetX: number; offsetY: number }) => setHit(find(e.offsetX, e.offsetY));
    const onClick = (e: { offsetX: number; offsetY: number }) => {
      const h = find(e.offsetX, e.offsetY);
      if (h) selectTrain(h.tid);
    };
    const onOut = () => setHit(null);
    zr.on("mousemove", onMove);
    zr.on("click", onClick);
    zr.on("globalout", onOut);
    return () => {
      zr.off("mousemove", onMove);
      zr.off("click", onClick);
      zr.off("globalout", onOut);
    };
  }, [chart, selectTrain]);

  const tr = hit && idx ? idx.trains.get(hit.tid) : null;
  const ts = hit ? useSim.getState().state?.trains.find((x) => x.id === hit.tid) : null;

  return (
    <div className="graph-wrap">
      <div className="chart-tools">
        <button className="btn btn-small" aria-pressed={follow} onClick={() => setFollow(true)} disabled={follow}
          title="Окно: час назад и два часа вперёд от текущего момента">
          ⟲ К текущему моменту
        </button>
        <label className="field small">
          <input type="checkbox" checked={showPrev} onChange={(e) => setShowPrev(e.target.checked)} />
          прежний план
        </label>
        <span className="muted small">Перетаскивание — сдвиг по времени, Shift + колесо — масштаб</span>
      </div>
      <div className="chart-rel">
        <div className="chart-box" ref={ref} style={{ cursor: hit ? "pointer" : "default" }}
          role="img" aria-label="График движения поездов: время по горизонтали, станции по вертикали" />
        {hit && tr && (
          <div className="tooltip" style={hit.x > 420 ? { right: `calc(100% - ${hit.x - 14}px)`, top: hit.y + 12 }
            : { left: hit.x + 14, top: hit.y + 12 }}>
            <div><b>{tr.number}</b> · {tr.cls_label}</div>
            <div className="muted">{hit.layer}, {clock(hit.t, false)}</div>
            {ts && <div>Сейчас: {delayLabel(ts.delay_s)}</div>}
            <div className="muted">клик — выбрать поезд</div>
          </div>
        )}
      </div>
      <GraphLegend tokens={tokens} />
    </div>
  );
}

function Key({ color, dash, width = 2, label }: { color: string; dash?: string; width?: number; label: string }) {
  return (
    <span className="legend-item">
      <svg width="26" height="8" aria-hidden>
        <line x1="1" y1="4" x2="25" y2="4" stroke={color} strokeWidth={width} strokeDasharray={dash} />
      </svg>
      {label}
    </span>
  );
}

function GraphLegend({ tokens }: { tokens: Tokens }) {
  return (
    <div className="legend legend-tight">
      <Key color={tokens["--text-secondary"]} label="Факт" />
      <Key color={tokens["--text-secondary"]} dash="6 4" width={1.5} label="Действующий план" />
      <Key color={tokens["--text-muted"]} width={1} label="Исходное расписание" />
      <Key color={tokens["--warning"]} dash="2 3" label="Прогноз без пересчёта" />
      <span className="legend-item"><span className="swatch-warn" aria-hidden /> Конфликт (с таймером)</span>
      <span className="legend-item"><span className="swatch-closed" aria-hidden /> Перегон закрыт</span>
      {(["fast", "pax", "freight", "extra"] as const).map((g) => (
        <span key={g} className="legend-item">
          <span className="dot" style={{ background: groupColor(tokens, g) }} aria-hidden />
          {GROUP_LABEL[g].split(" (")[0]}
        </span>
      ))}
    </div>
  );
}
