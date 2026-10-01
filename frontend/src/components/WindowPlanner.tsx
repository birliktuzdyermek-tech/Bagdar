// Подбор времени технологического «окна»: когда закрыть перегон на N минут, чтобы потерять меньше.
// Бағдар перебирает старты окна на ближайшие часы и честно считает план для каждого.
import { useState } from "react";
import { api } from "../api/client";
import type { WindowPlan } from "../api/types";
import { hhmm, num } from "../lib/format";
import { money, useMoney } from "../store/money";
import { useSim } from "../store/sim";

export function WindowPlanner({ sections, defaultSection }: { sections: { id: string; label: string }[]; defaultSection: string }) {
  const [section, setSection] = useState(defaultSection);
  const [minutes, setMinutes] = useState("60");
  const [res, setRes] = useState<WindowPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const setError = useSim((s) => s.setError);
  const t = useSim((s) => s.state?.t ?? 0);
  useMoney();

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setRes(await api.window(section || defaultSection, Number(minutes) || 60));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const schedule = async (start: number) => {
    try {
      const r = await api.windowSchedule(res!.section_id, start, res!.minutes);
      setMsg(r.message);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const max = res ? Math.max(1, ...res.options.map((o) => o.delta_J)) : 1;
  return (
    <div className="window-box">
      <div className="window-head">
        <b>🛠 Окно на ремонт</b>
        <span className="muted small">путейцам нужно закрыть перегон — Бағдар подберёт время, когда это дешевле всего</span>
      </div>
      <div className="disrupt-form">
        <label className="field">Перегон
          <select className="input" value={section || defaultSection} onChange={(e) => setSection(e.target.value)}>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field"><input className="input input-num" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} /> мин</label>
        <button className="btn btn-primary btn-small" onClick={run} disabled={busy} title="Перебрать старты окна в ближайшие 3 часа и посчитать план для каждого">
          {busy ? "считаю…" : "Подобрать время"}
        </button>
      </div>
      {res && (
        <div className="window-res">
          <div className="small muted">
            Перегон {res.section}, окно {res.minutes} мин, старты каждые 15 минут на 3 часа вперёд. Для каждого — план всех поездов
            с окном против плана без окна (цена сейчас {money(res.baseline.J)}). Считалось той же моделью, что и варианты решений.
          </div>
          <table className="window-table">
            <thead><tr><th>Начало</th><th>Дороже на</th><th>Задето</th><th>+ задержка</th><th>Сверх допуска</th><th /></tr></thead>
            <tbody>
              {res.options.map((o) => {
                const best = o.id === res.best;
                const past = o.start <= t;
                return (
                  <tr key={o.id} className={best ? "best" : o.stuck > 0 ? "bad" : ""}>
                    <td className="tabular"><b>{hhmm(o.start)}</b>–{hhmm(o.end)}{best && <span className="badge badge-good" style={{ marginLeft: 6 }}>лучшее</span>}</td>
                    <td>
                      <span className="window-bar"><span style={{ width: `${Math.round((100 * Math.max(0, o.delta_J)) / max)}%` }} /></span>
                      <span className="tabular">{money(o.delta_J)}</span>
                    </td>
                    <td className="tabular">{o.affected} п.{o.numbers.length ? <span className="muted small"> ({o.numbers.slice(0, 3).join(", ")}{o.numbers.length > 3 ? "…" : ""})</span> : null}</td>
                    <td className="tabular">{num(o.delay_add_min)} мин</td>
                    <td className="tabular">{o.late_trains}{o.stuck > 0 && <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Часть поездов план бросил бы — такое окно опасно">застрянет {o.stuck}</span>}</td>
                    <td><button className="btn btn-small" disabled={past} onClick={() => schedule(o.start)} title="Закрытие случится само в это время модели">Запланировать</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {res.best && res.worst && res.best !== res.worst && (() => {
            const b = res.options.find((o) => o.id === res.best)!;
            const w = res.options.find((o) => o.id === res.worst)!;
            return <div className="window-verdict">
              Лучшее время — <b>{hhmm(b.start)}</b>: задето {b.affected} п., потери {money(b.delta_J)}. Худшее — {hhmm(w.start)}: {money(w.delta_J)}.
              Разница <b>{money(w.delta_J - b.delta_J)}</b> за одно и то же окно — только за счёт выбора момента.
            </div>;
          })()}
          {msg && <div className="small" role="status">✓ {msg}</div>}
        </div>
      )}
    </div>
  );
}
