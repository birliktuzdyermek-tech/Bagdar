import { useMemo } from "react";
import { hhmm } from "../lib/format";
import { classGroup, GROUP_COLOR } from "../lib/palette";
import { useAlarms } from "../lib/alarms";
import { useSim } from "../store/sim";

const W = 560;
const X0 = 96;
const X1 = W - 96;
const TH = 52; // x центра горловины от края

export function StationDetail() {
  const id = useSim((s) => s.selectedStation);
  const alarms = useAlarms();
  const idx = useSim((s) => s.idx);
  const world = useSim((s) => s.world);
  const state = useSim((s) => s.state);
  const selectTrain = useSim((s) => s.selectTrain);
  const st = id && idx ? idx.stations.get(id) : undefined;

  const upcoming = useMemo(() => {
    if (!st || !world || !state) return [];
    const rows: { train: string; number: string; arr: number | null; dep: number | null; stop: boolean }[] = [];
    for (const tr of world.trains) {
      const s = tr.schedule.find((x) => x.station_id === st.id);
      if (!s) continue;
      const tRef = s.arr ?? s.dep ?? 0;
      if (tRef >= state.t - 60 && tRef <= state.t + 3 * 3600) rows.push({ train: tr.id, number: tr.number, arr: s.arr, dep: s.dep, stop: s.stop });
    }
    rows.sort((a, b) => (a.arr ?? a.dep ?? 0) - (b.arr ?? b.dep ?? 0));
    return rows.slice(0, 8);
  }, [st, world, state]);

  if (!st || !idx || !state) {
    return (
      <section className="card" aria-label="Станция">
        <div className="card-head"><span className="card-title">Станция</span></div>
        <div className="card-body"><div className="empty">Нажмите на станцию на схеме — откроется её путевое развитие и горловины.</div></div>
      </section>
    );
  }
  const trackState = new Map(state.tracks.map((t) => [t.id, t]));
  const throatBusy = new Map(state.throats.map((t) => [t.id, t.holder]));
  const main = st.tracks.filter((t) => t.is_main);
  const side = st.tracks.filter((t) => !t.is_main);
  const ordered = [...main, ...side];
  const rowH = 30;
  const H = 44 + ordered.length * rowH;
  const yMain = 24 + rowH * 0.5;
  const yOf = (i: number) => 24 + rowH * (i + 0.5);
  const maxLen = Math.max(...st.tracks.map((t) => t.length_m));
  const throatName = (side: "A" | "B") => `${st.id}:${side}`;
  const kindLabel = st.kind === "terminal" ? "участковая станция" : st.kind === "station" ? "промежуточная станция" : "разъезд";
  const trainsHere = state.trains.filter((t) => t.station_id === st.id);

  return (
    <section className="card" aria-label={`Станция ${st.name}`}>
      <div className="card-head">
        <span className="card-title">{st.name}</span>
        <span className="card-sub">{kindLabel} · {st.km.toFixed(1)} км · путей {st.tracks.length}{st.crew_change ? " · смена бригад" : ""}</span>
      </div>
      <div className="card-body">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Путевое развитие станции ${st.name}`}>
          {(["A", "B"] as const).map((sd) => {
            const holder = throatBusy.get(throatName(sd));
            const x = sd === "A" ? TH : W - TH;
            return (
              <g key={sd}>
                <line x1={sd === "A" ? 36 : W - TH} x2={sd === "A" ? TH : W - 36} y1={yMain} y2={yMain} stroke="var(--rail)" strokeWidth={3} />
                <rect x={x - 12} y={yMain - 12} width={24} height={24} rx={5}
                  fill={holder ? "var(--accent-soft)" : "var(--surface-2)"} stroke={holder ? "var(--accent)" : "var(--border-strong)"} />
                <text x={x} y={yMain + 4} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">{sd === "A" ? "Н" : "Ч"}</text>
                <text x={sd === "A" ? 4 : W - 4} y={H - 4} textAnchor={sd === "A" ? "start" : "end"} fontSize={10} fill="var(--text-muted)">
                  {holder ? `маршрут ${idx.trains.get(holder)?.number ?? ""}` : "горловина свободна"}
                </text>
              </g>
            );
          })}
          {ordered.map((t, i) => {
            const y = yOf(i);
            const ts = trackState.get(t.id);
            const len = ((X1 - X0) * t.length_m) / maxLen;
            const xs = X0 + (X1 - X0 - len) / 2;
            const occ = ts?.occupant ? idx.trains.get(ts.occupant) : undefined;
            const res = ts?.reserved ? idx.trains.get(ts.reserved) : undefined;
            const unavailable = ts && !ts.available;
            return (
              <g key={t.id}>
                {!t.is_main && (
                  <>
                    <line x1={TH + 12} y1={yMain} x2={xs} y2={y} stroke="var(--track)" strokeWidth={2} />
                    <line x1={W - TH - 12} y1={yMain} x2={xs + len} y2={y} stroke="var(--track)" strokeWidth={2} />
                  </>
                )}
                {t.is_main && <line x1={TH + 12} x2={W - TH - 12} y1={y} y2={y} stroke="var(--track)" strokeWidth={2} />}
                <line x1={xs} x2={xs + len} y1={y} y2={y}
                  stroke={unavailable ? (alarms.red.has(`track:${t.id}`) ? "var(--critical)" : "var(--serious)") : res ? "var(--accent)" : "var(--track)"}
                  strokeWidth={unavailable ? 4 : 3} strokeDasharray={res && !occ ? "5 3" : "none"} />
                <text x={4} y={y + 4} textAnchor="start" fontSize={11} fill="var(--text-primary)">
                  {t.name}{t.is_main ? " гл." : ""}
                </text>
                <text x={W - 4} y={y + (t.is_main ? -16 : 4)} textAnchor="end" fontSize={10} fill="var(--text-muted)">{t.length_m} м</text>
                {occ && (() => {
                  const w = Math.min(len, (len * occ.length_m) / t.length_m);
                  return (
                    <g className="train" onClick={() => selectTrain(occ.id)} role="button" aria-label={`Поезд ${occ.number} на пути ${t.name}`}>
                      <rect x={xs + (len - w) / 2} y={y - 7} width={w} height={14} rx={3} fill={GROUP_COLOR[classGroup(occ.cls)]} />
                      <text x={xs + len / 2} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff"
                        style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,.45)", strokeWidth: 2.5 }}>
                        {occ.number} · {occ.length_m} м
                      </text>
                    </g>
                  );
                })()}
                {!occ && res && (
                  <text x={xs + len / 2} y={y - 6} textAnchor="middle" fontSize={10} fill="var(--accent)">
                    закреплён за {res.number}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Длина линии пути пропорциональна полезной длине; прямоугольник поезда — длине состава. Н/Ч — нечётная и чётная горловины, каждая пропускает один маршрут за раз.
        </p>
        <div className="secondary" style={{ fontSize: 12.5, marginBottom: 4 }}>
          На станции: {trainsHere.length ? trainsHere.map((t) => idx.trains.get(t.id)?.number).join(", ") : "нет поездов"}
        </div>
        <table className="sched" aria-label="Ближайшие поезда по расписанию">
          <thead><tr><th>Поезд</th><th>Приб.</th><th>Отпр.</th><th></th></tr></thead>
          <tbody>
            {upcoming.map((r) => (
              <tr key={r.train} onClick={() => selectTrain(r.train)} style={{ cursor: "pointer" }}>
                <td>{r.number}</td><td>{hhmm(r.arr)}</td><td>{hhmm(r.dep)}</td>
                <td className="muted">{r.stop ? "стоянка" : "проследование"}</td>
              </tr>
            ))}
            {upcoming.length === 0 && <tr><td colSpan={4} className="muted">В ближайшие 3 часа поездов нет</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
