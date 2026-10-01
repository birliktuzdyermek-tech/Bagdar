// Диаграмма Ганта: занятость путей станций и перегонов. Слева от «сейчас» —
// факт, справа — план. Переключатель «до / после» показывает предыдущий или
// действующий план; интервалы, которые отличаются между ними, обведены.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Busy, Occupancy } from "../api/types";
import { echarts, useEChart } from "../lib/echarts";
import { clock } from "../lib/format";
import { classGroup } from "../lib/palette";
import { groupColor, inkOn, useTokens } from "../lib/theme";
import { useSim } from "../store/sim";

const ROW_H = 17;
const KIND: Record<string, string> = { stand: "стоянка", pass: "проследование", section: "на перегоне", hold: "удержание" };

interface Row {
  id: string;
  label: string;
  station: string;
  kind: "track" | "section";
}

type Filter = "all" | "changed" | "station";

export function GanttChart() {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const runId = useSim((s) => s.state?.run_id ?? "");
  const applied = useSim((s) => s.state?.planner.applied_version ?? 0);
  const running = useSim((s) => s.state?.running ?? false);
  const tNow = useSim((s) => Math.floor((s.state?.t ?? 0) / 30));
  const selectedTrain = useSim((s) => s.selectedTrain);
  const selectedStation = useSim((s) => s.selectedStation);
  const conflicts = useSim((s) => s.state?.conflicts);
  const selectTrain = useSim((s) => s.selectTrain);
  const tokens = useTokens();
  const [which, setWhich] = useState<"current" | "previous">("current");
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<Occupancy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const meta = useRef<{ b: Busy; row: Row }[]>([]);
  const { ref, chart } = useEChart((c) => {
    c.on("click", (p) => {
      const m = meta.current[(p as { dataIndex: number }).dataIndex];
      if (m && (p as { seriesName?: string }).seriesName === "busy") selectTrain(m.b.train_id);
    });
  });

  const rows = useMemo<Row[]>(() => {
    if (!world) return [];
    const out: Row[] = [];
    const secByA = new Map<string, typeof world.sections>();
    for (const s of world.sections) secByA.set(s.a, [...(secByA.get(s.a) ?? []), s]);
    for (const st of world.stations) {
      const tracks = [...st.tracks].sort((a, b) => Number(b.is_main) - Number(a.is_main) || a.name.localeCompare(b.name));
      for (const t of tracks) {
        out.push({ id: t.id, station: st.id, kind: "track", label: `${st.name} · ${t.name}${t.is_main ? " гл." : ""}` });
      }
      for (const sec of secByA.get(st.id) ?? []) {
        out.push({ id: sec.id, station: st.id, kind: "section",
          label: `   перегон ${sec.id} · ${sec.tracks === 1 ? "1 путь" : "2 пути"}` });
      }
    }
    return out;
  }, [world]);

  // данные: при смене плана, режима «до/после» и раз в 30 с модели, пока идёт симуляция
  useEffect(() => {
    if (!runId) return;
    const t = useSim.getState().state?.t ?? 0;
    let off = false;
    api.occupancy(which, t - 1800, t + 9000)
      .then((d) => {
        if (!off) {
          setData(d);
          setErr(null);
        }
      })
      .catch((e) => !off && setErr(String(e.message ?? e)));
    return () => {
      off = true;
    };
  }, [runId, which, applied, running ? tNow : 0]);

  const visibleRows = useMemo(() => {
    if (!data) return rows;
    if (filter === "changed") {
      const ch = new Set(data.items.filter((b) => b.changed).map((b) => b.resource));
      return rows.filter((r) => ch.has(r.id));
    }
    if (filter === "station" && selectedStation) {
      return rows.filter((r) => r.station === selectedStation ||
        (r.kind === "section" && idx?.sections.get(r.id)?.b === selectedStation));
    }
    return rows;
  }, [rows, data, filter, selectedStation, idx]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !data || !idx) return;
    const rowPos = new Map(visibleRows.map((r, i) => [r.id, i]));
    const items: { b: Busy; row: Row }[] = [];
    for (const b of data.items) {
      const i = rowPos.get(b.resource);
      if (i == null) continue;
      items.push({ b, row: visibleRows[i] });
    }
    meta.current = items;
    const now = data.t;
    const series: Record<string, unknown>[] = [{
      name: "busy",
      type: "custom",
      encode: { x: [1, 2], y: 0 },
      data: items.map(({ b, row }) => [rowPos.get(row.id)!, b.t0, b.t1]),
      renderItem: (params: { dataIndex: number; coordSys: { x: number; y: number; width: number; height: number } },
        a: { value: (i: number) => number; coord: (v: number[]) => number[]; size: (v: number[]) => number[] }) => {
        const m = items[params.dataIndex];
        const r = a.value(0);
        const p0 = a.coord([a.value(1), r]);
        const p1 = a.coord([a.value(2), r]);
        const h = Math.min(12, a.size([0, 1])[1] * 0.72);
        const rect = echarts.graphic.clipRectByRect(
          { x: p0[0], y: p0[1] - h / 2, width: Math.max(2, p1[0] - p0[0]), height: h },
          { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
        );
        if (!rect) return undefined;
        const tr = idx.trains.get(m.b.train_id);
        const col = groupColor(tokens, tr ? classGroup(tr.cls) : "freight");
        const isSel = selectedTrain === m.b.train_id;
        const dim = selectedTrain && !isSel ? 0.25 : 1;
        const fact = m.b.source === "fact";
        const label = tr?.number ?? "";
        const fits = rect.width > label.length * 6.2 + 8;
        return {
          type: "group",
          children: [
            {
              type: "rect",
              shape: { ...rect, r: 2 },
              style: {
                fill: col,
                opacity: (fact ? 0.5 : m.b.kind === "pass" ? 0.6 : 0.92) * dim,
                stroke: m.b.changed ? tokens["--text-primary"] : isSel ? tokens["--accent"] : undefined,
                lineWidth: m.b.changed || isSel ? 1.5 : 0,
              },
            },
            ...(fits ? [{
              type: "text",
              style: { text: label, x: rect.x + 4, y: rect.y + rect.height / 2, verticalAlign: "middle",
                fill: inkOn(col), font: "600 10px system-ui", opacity: dim },
              silent: true,
            }] : []),
          ],
        };
      },
      tooltip: {
        formatter: (p: { dataIndex: number }) => {
          const m = items[p.dataIndex];
          if (!m) return "";
          const tr = idx.trains.get(m.b.train_id);
          const src = m.b.source === "fact" ? "факт" : `${which === "current" ? "действующий" : "предыдущий"} план v${data.plan_version}`;
          const esc = (x: string) => x.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
          return `<b>${esc(tr?.number ?? m.b.train_id)}</b> ${esc(tr?.cls_label ?? "")}<br/>` +
            `${esc(m.row.label.trim())}<br/>${clock(m.b.t0, false)}–${clock(m.b.t1, false)} · ${KIND[m.b.kind]}<br/>` +
            `<span style="opacity:.75">${src}${m.b.changed ? " · отличается в другом плане" : ""}</span>`;
        },
      },
      z: 2,
    }];
    // прогнозные конфликты на строках ресурсов
    const cf = (conflicts ?? []).flatMap((x) => {
      const i = rowPos.get(x.resource);
      return i == null ? [] : [{ value: [x.t, i], name: `⚠ ${Math.max(0, Math.round(x.in_s / 60))} мин: ${x.message}` }];
    });
    series.push({
      name: "conflicts", type: "scatter", symbol: "triangle", symbolSize: 13, data: cf, z: 5,
      itemStyle: { color: tokens["--warning"], borderColor: tokens["--surface-1"], borderWidth: 2 },
      encode: { x: 0, y: 1 },
      tooltip: { formatter: (p: { name: string }) => p.name },
      markLine: {
        silent: true, symbol: "none", animation: false, data: [{ xAxis: now }],
        lineStyle: { color: tokens["--accent"], width: 1.5, type: "solid" },
        label: { formatter: "сейчас", color: tokens["--text-secondary"], fontSize: 10, position: "insideEndTop" },
      },
    });
    c.setOption({
      animation: false,
      grid: { left: 150, right: 12, top: 22, bottom: 8 },
      tooltip: { trigger: "item", confine: true, backgroundColor: tokens["--surface-3"], borderColor: tokens["--border-strong"],
        textStyle: { color: tokens["--text-primary"], fontSize: 12 } },
      xAxis: {
        type: "value", position: "top", min: now - 1800, max: now + 9000, splitNumber: 6,
        axisLabel: { formatter: (v: number) => clock(v, false), color: tokens["--text-muted"], fontSize: 10.5 },
        splitLine: { lineStyle: { color: tokens["--border"], opacity: 0.6 } },
        axisLine: { lineStyle: { color: tokens["--border-strong"] } }, axisTick: { show: false },
      },
      yAxis: {
        type: "category", inverse: true, data: visibleRows.map((r) => r.label),
        axisLabel: {
          color: (_v?: string | number, i?: number) => (visibleRows[i ?? 0]?.kind === "section" ? tokens["--text-muted"] : tokens["--text-secondary"]),
          fontSize: 10, interval: 0,
        },
        axisTick: { show: false }, axisLine: { lineStyle: { color: tokens["--border-strong"] } },
        splitLine: { show: false },
      },
      series,
    }, { replaceMerge: ["series"] });
  }, [chart, data, visibleRows, idx, tokens, selectedTrain, conflicts, which]);

  const changed = data ? data.items.filter((b) => b.changed).length : 0;
  const height = Math.max(120, visibleRows.length * ROW_H + 34);
  const st = selectedStation ? idx?.stations.get(selectedStation) : null;

  return (
    <div className="gantt-wrap">
      <div className="chart-tools">
        <div className="seg" role="group" aria-label="До или после пересчёта">
          <button aria-pressed={which === "previous"} onClick={() => setWhich("previous")}>
            До{data && which === "previous" && data.plan_version != null ? ` · v${data.plan_version}` : ""}
          </button>
          <button aria-pressed={which === "current"} onClick={() => setWhich("current")}>
            После · v{applied}
          </button>
        </div>
        <div className="seg" role="group" aria-label="Какие ресурсы показать">
          <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Весь участок</button>
          <button aria-pressed={filter === "changed"} onClick={() => setFilter("changed")}>Изменения ({changed})</button>
          <button aria-pressed={filter === "station"} onClick={() => setFilter("station")} disabled={!st}
            title={st ? "" : "Выберите станцию на схеме"}>
            {st ? st.name : "Станция"}
          </button>
        </div>
        {which === "previous" && data?.plan_version == null && <span className="muted small">Предыдущего плана ещё нет</span>}
        {err && <span className="muted small">Ошибка загрузки: {err}</span>}
      </div>
      <div className="gantt-scroll">
        {filter === "changed" && visibleRows.length === 0 ? (
          <div className="empty">Между планами нет отличий в занятости на этом окне.</div>
        ) : null}
        <div ref={ref} style={{ height, display: filter === "changed" && visibleRows.length === 0 ? "none" : "block" }}
          role="img" aria-label="Диаграмма Ганта занятости путей и перегонов" />
      </div>
      <div className="legend legend-tight">
        <span className="legend-item"><span className="bar-key" style={{ opacity: 0.5 }} /> факт</span>
        <span className="legend-item"><span className="bar-key" /> план</span>
        <span className="legend-item"><span className="bar-key bar-key-changed" /> отличается в другом плане</span>
        <span className="legend-item"><span className="tri-key" aria-hidden>▲</span> прогнозный конфликт</span>
        <span className="legend-item muted">цвет — класс поезда, клик по полосе — выбрать поезд</span>
      </div>
    </div>
  );
}
