import { useState } from "react";
import { api } from "../api/client";
import { CARGO_LABEL, delayLabel, DISPLAY_LABEL, duration, hhmm, num } from "../lib/format";
import { classGroup, GROUP_COLOR } from "../lib/palette";
import { trainShape } from "../lib/geometry";
import { useAlarms } from "../lib/alarms";
import { money } from "../store/money";
import { useSim } from "../store/sim";
import { AdviceBox } from "./AdviceBox";

export function TrainDetail() {
  const id = useSim((s) => s.selectedTrain);
  const idx = useSim((s) => s.idx);
  const world = useSim((s) => s.world);
  const state = useSim((s) => s.state);
  const selectStation = useSim((s) => s.selectStation);
  const setError = useSim((s) => s.setError);
  const alarms = useAlarms();
  const [sent, setSent] = useState<string | null>(null);

  const tr = id && idx ? idx.trains.get(id) : undefined;
  const ts = id && state ? state.trains.find((t) => t.id === id) : undefined;

  if (!tr || !idx || !world) {
    return (
      <section className="card" aria-label="Поезд">
        <div className="card-head"><span className="card-title">Поезд</span></div>
        <div className="card-body"><div className="empty">Нажмите на поезд на схеме, чтобы увидеть его состояние, состав и расписание.</div></div>
      </section>
    );
  }
  const cls = world.classes.find((c) => c.key === tr.cls);
  const tol = (cls?.tolerance_min ?? 30) * 60;
  const group = classGroup(tr.cls);
  const st = (sid: string | null | undefined) => (sid ? idx.stations.get(sid)?.name ?? sid : "—");
  const delay = ts?.delay_s ?? 0;
  // красный — только если поезд в бюджете трёх самых дорогих тревог
  const delayBadge = delay < 60 ? "badge-good" : delay < tol ? "badge-warning"
    : alarms.red.has(`train:${tr.id}`) ? "badge-critical" : "badge-serious";
  const crewLeft = ts?.crew_left_s ?? (tr.crew_shift_end ?? 0) - (state?.t ?? 0);
  const where = ts
    ? ts.section_id
      ? (() => {
          const sec = idx.sections.get(ts.section_id)!;
          return `перегон ${st(sec.a)} — ${st(sec.b)}`;
        })()
      : `ст. ${st(ts.station_id)}, путь ${ts.track_id ? idx.stations.get(ts.station_id!)?.tracks.find((t) => t.id === ts.track_id)?.name : "—"}`
    : "не на участке";
  const k = ts?.k ?? -1;
  const onSection = ts?.status === "section";

  return (
    <section className="card" aria-label={`Поезд ${tr.number}`}>
      <div className="card-head">
        <svg width="28" height="16" viewBox="-14 -8 28 16" aria-hidden>
          <path d={trainShape(group, tr.direction)} fill={GROUP_COLOR[group]} />
        </svg>
        <span className="card-title">№ {tr.number}</span>
        <span className="card-sub">{tr.cls_label}{tr.suburban ? " (пригородный)" : ""} · {tr.direction > 0 ? "нечётное →" : "← чётное"}</span>
      </div>
      <div className="card-body">
        <div className="status-line">
          <span className={`badge ${delayBadge}`}>{delay < 60 ? "✓" : "⚠"} {delayLabel(delay)}</span>
          <span className="badge badge-neutral">{ts ? DISPLAY_LABEL[ts.display] ?? ts.display : "не на участке"}</span>
          <span className="muted" title="Допуск — на сколько минут поезд этого класса может опоздать без нарушения ПТЭ. Вес — цена минуты его задержки, у.е.">допуск опоздания {Math.round(tol / 60)} мин · минута опоздания стоит {cls ? money(cls.weight) : "—"}</span>
        </div>
        {ts?.wait_reason && <div className="wait">Ожидает: {ts.wait_reason}</div>}
        {ts?.advice && <AdviceBox a={ts.advice} />}
        {ts && ts.display !== "terminated" && (
          <div className="inject" aria-label="Внешнее событие">
            <span className="muted">Задержать этот поезд:</span>
            {[5, 10, 15].map((m) => (
              <button key={m} className="btn btn-small" onClick={async () => {
                try {
                  const r = await api.event({ type: "train_delay", train_id: tr.id, minutes: m });
                  setSent(`${r.message}: +${m} мин, план пересчитывается`);
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}>+{m} мин</button>
            ))}
            {sent && <div className="muted" style={{ width: "100%", fontSize: 12 }}>{sent}</div>}
          </div>
        )}
        <dl className="kv">
          <dt>Где</dt><dd>{where}</dd>
          <dt>Скорость</dt><dd>{ts ? `${Math.round(ts.v_kmh)} км/ч (цель ${Math.round(ts.v_target_kmh)}, макс. ${tr.vmax_kmh})` : "—"}</dd>
          <dt>Маршрут</dt><dd>{st(tr.route[0])} → {st(tr.route[tr.route.length - 1])}</dd>
          <dt>Бригада</dt>
          <dd>
            {tr.crew_id} · осталось{" "}
            <span className={crewLeft < 3600 ? "badge badge-warning" : ""}>{duration(crewLeft)}</span>
          </dd>
          <dt>Локомотив</dt><dd>{tr.loco_id} ({tr.traction === "electric" ? "электровоз" : "тепловоз"})</dd>
          <dt>Состав</dt><dd>{num(tr.mass_t)} т · {num(tr.length_m)} м{tr.passengers ? ` · ${num(tr.passengers)} пасс.` : ""}</dd>
          {tr.cargo.length > 0 && (<><dt>Груз</dt><dd>{tr.cargo.map((c) => CARGO_LABEL[c] ?? c).join(", ")}</dd></>)}
          {ts && (<><dt>Остановки</dt><dd>{ts.stops} всего, {ts.unplanned_stops} неплановых{ts.stop_energy_kwh > 0 ? ` · потеряно ≈${Math.round(ts.stop_energy_kwh)} кВт·ч (усл.)` : ""}</dd></>)}
        </dl>
        <table className="sched" aria-label="Расписание">
          <thead>
            <tr><th>Станция</th><th>Приб.</th><th>Отпр.</th><th>Путь</th></tr>
          </thead>
          <tbody>
            {tr.schedule.map((s, i) => {
              const passed = i < k || (i === k && onSection);
              const current = i === k && !onSection;
              const next = onSection && i === k + 1;
              const track = idx.stations.get(s.station_id)?.tracks.find((t) => t.id === s.track_id);
              return (
                <tr key={s.station_id} className={passed ? "passed" : current || next ? "current" : ""}>
                  <td>
                    <button className="linklike" onClick={() => selectStation(s.station_id)}
                      style={{ all: "unset", cursor: "pointer" }}>
                      {s.stop ? "● " : "○ "}{st(s.station_id)}
                    </button>
                  </td>
                  <td>{hhmm(s.arr)}</td>
                  <td>{hhmm(s.dep)}</td>
                  <td>{track?.name ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12 }}>● — плановая остановка, ○ — проследование. Время — исходное расписание.</p>
      </div>
    </section>
  );
}
