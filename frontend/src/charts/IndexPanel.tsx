// Индекс эффективности участка: число 0–100, статус, вклад пяти факторов,
// причины ухудшения, прогноз по плану на час и динамика во времени.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { IndexFactor, IndexPoint } from "../api/types";
import { useAlarms } from "../lib/alarms";
import { useEChart } from "../lib/echarts";
import { clock, num } from "../lib/format";
import { useTokens } from "../lib/theme";
import { useSim } from "../store/sim";

export const INDEX_STATUS: Record<string, { icon: string; cls: string }> = {
  norm: { icon: "✓", cls: "badge-good" },
  warning: { icon: "!", cls: "badge-warning" },
  critical: { icon: "✕", cls: "badge-critical" },
  no_data: { icon: "…", cls: "badge-neutral" },
};

function meterColor(score: number): string {
  if (score >= 0.75) return "var(--accent)";
  if (score >= 0.5) return "var(--warning)";
  return "var(--serious)";
}

function FactorRow({ f }: { f: IndexFactor }) {
  return (
    <li className="factor" title={f.note}>
      <span className="factor-label">{f.label}</span>
      <span className="meter" aria-hidden>
        {f.available && f.score != null && (
          <span className="meter-fill" style={{ width: `${Math.round(f.score * 100)}%`, background: meterColor(f.score) }} />
        )}
      </span>
      <span className={`tabular factor-lost ${f.lost >= 1 ? "" : "muted"}`}>
        {f.available ? (f.lost >= 0.05 ? `−${num(f.lost, 1)} п.` : "0 п.") : "—"}
      </span>
      <span className="factor-value muted">
        {f.available ? `${f.value_text} · вес ${num(f.weight_eff * 100)} %` : `нет данных: ${f.note}`}
      </span>
    </li>
  );
}

export function IndexPanel() {
  const index = useSim((s) => s.state?.index ?? null);
  const forecast = useSim((s) => s.state?.planner.forecast ?? null);
  const runId = useSim((s) => s.state?.run_id ?? "");
  const t = useSim((s) => s.state?.t ?? 0);
  const alarms = useAlarms();
  const tokens = useTokens();
  const [history, setHistory] = useState<IndexPoint[]>([]);
  const lastFetch = useRef(-Infinity);
  const { ref, chart } = useEChart();

  useEffect(() => {
    setHistory([]);
    lastFetch.current = -Infinity;
  }, [runId]);

  // история: целиком при новом прогоне, дальше — только новые точки, не чаще раза в 5 с
  useEffect(() => {
    if (!runId) return;
    const now = performance.now();
    if (now - lastFetch.current < 5000) return;
    lastFetch.current = now;
    const since = history.length ? history[history.length - 1].t : undefined;
    api.index(since).then((r) => {
      setHistory((h) => {
        const merged = since == null ? r.history : h.concat(r.history.filter((p) => p.t > since));
        return merged.slice(-1440);
      });
    }).catch(() => {});
  }, [runId, t, history]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const pts = history.filter((p) => p.value != null).map((p) => [p.t, p.value as number]);
    const tMax = pts.length ? pts[pts.length - 1][0] : t;
    const tMin = Math.min(pts.length ? pts[0][0] : t - 3600, tMax - 1800);
    const band = (from: number, to: number, color: string) => [{ yAxis: from, itemStyle: { color, opacity: 0.09 } }, { yAxis: to }];
    c.setOption({
      animation: false,
      grid: { left: 30, right: 10, top: 8, bottom: 20 },
      tooltip: {
        trigger: "axis", backgroundColor: tokens["--surface-3"], borderColor: tokens["--border-strong"],
        textStyle: { color: tokens["--text-primary"], fontSize: 12 },
        axisPointer: { type: "line", lineStyle: { color: tokens["--text-muted"], width: 1 } },
        formatter: (ps: { value: number[] }[]) => {
          const p = ps[0];
          return p ? `<b>${Math.round(p.value[1])}</b> · ${clock(p.value[0], false)}` : "";
        },
      },
      xAxis: {
        type: "value", min: tMin, max: tMax, splitNumber: 4,
        axisLabel: { formatter: (v: number) => clock(v, false), color: tokens["--text-muted"], fontSize: 10 },
        axisLine: { lineStyle: { color: tokens["--border-strong"] } }, splitLine: { show: false }, axisTick: { show: false },
      },
      yAxis: {
        type: "value", min: 0, max: 100, interval: 25,
        axisLabel: { color: tokens["--text-muted"], fontSize: 10 },
        splitLine: { lineStyle: { color: tokens["--border"], opacity: 0.6 } },
      },
      series: [{
        type: "line", data: pts, symbol: "none", lineStyle: { width: 2, color: tokens["--accent"] },
        areaStyle: { color: tokens["--accent"], opacity: 0.08 },
        markArea: {
          silent: true,
          data: [band(75, 100, tokens["--good"]), band(50, 75, tokens["--warning"]), band(0, 50, tokens["--critical"])],
        },
      }],
    }, { replaceMerge: ["series"] });
  }, [chart, history, tokens, t]);

  const st = index ? INDEX_STATUS[index.status] : INDEX_STATUS.no_data;
  // красный — только если индекс прошёл в бюджет трёх красных элементов
  const badgeCls = index?.status === "critical" && !alarms.red.has("index") ? "badge-serious" : st.cls;

  return (
    <section className="card index-card" aria-label="Индекс эффективности участка">
      <div className="card-head">
        <span className="card-title">Индекс эффективности</span>
        <span className="card-sub">0–100 · веса и пороги из конфига</span>
      </div>
      <div className="card-body">
        <div className="index-hero">
          <span className="index-value">{index?.value != null ? Math.round(index.value) : "—"}</span>
          <div className="index-side">
            <span className={`badge ${badgeCls}`}><span aria-hidden>{st.icon}</span> {index?.status_label ?? "Нет данных"}</span>
            {forecast && (
              <span className="muted small" title="Тот же индекс, посчитанный по действующему плану на час вперёд">
                через час по плану: <b className="secondary">{forecast.value != null ? Math.round(forecast.value) : "—"}</b>
              </span>
            )}
            {index && index.missing.length > 0 && (
              <span className="muted small">без данных: {index.missing.join(", ")} — веса перенормированы</span>
            )}
          </div>
        </div>
        {index && index.reasons.length > 0 ? (
          <ul className="reasons" aria-label="Что тянет индекс вниз">
            {index.reasons.slice(0, 2).map((r) => <li key={r} title={r}>{r}</li>)}
          </ul>
        ) : (
          <div className="muted small" style={{ margin: "4px 0 8px" }}>Индекс ничто заметно не тянет вниз.</div>
        )}
        <div className="index-chart" ref={ref} role="img"
          aria-label={`Динамика индекса: ${history.length} точек, сейчас ${index?.value != null ? Math.round(index.value) : "нет данных"}`} />
        <ul className="factors">
          {(index?.factors ?? []).map((f) => <FactorRow key={f.key} f={f} />)}
        </ul>
      </div>
    </section>
  );
}
