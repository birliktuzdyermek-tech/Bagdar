import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Scenario, State, Versus, VersusScore } from "../api/types";
import { LineScheme, type SchemeSource } from "../components/LineScheme";
import { hhmm, num } from "../lib/format";
import { useSim } from "../store/sim";

// кадры левой (теневой) модели для плавной интерполяции на схеме
const left: SchemeSource = { state: null, prev: null, recvAt: 0, prevRecvAt: 0 };
const leftSource = () => left;

const ROWS: { key: keyof VersusScore; label: string; unit: string; better: "less" | "more"; hint: string }[] = [
  { key: "money_total", label: "Цена сбоев и задержек", unit: "у.е.", better: "less", hint: "Задержки + энергия + простой по тарифам из настроек" },
  { key: "delay_min", label: "Задержка поездов", unit: "поездо-мин", better: "less", hint: "Сумма опозданий всех поездов" },
  { key: "frozen", label: "Стоят на месте больше часа", unit: "п.", better: "less", hint: "Признак «замка» — никто не может двинуться" },
  { key: "late_trains", label: "Опаздывают на 5+ мин", unit: "п.", better: "less", hint: "" },
  { key: "passages", label: "Проследований станций", unit: "", better: "more", hint: "Сколько раз поезда прошли станции — пропускная способность" },
  { key: "energy_kwh", label: "Энергия на лишние остановки", unit: "кВт·ч", better: "less", hint: "E = m·v²/2 на каждую неплановую остановку" },
  { key: "idle_h", label: "Простой сверх графика", unit: "поездо-ч", better: "less", hint: "Локомотивы и бригады ждут" },
];

function fmt(v: number | null | undefined, unit: string): string {
  if (v == null) return "—";
  const n = Math.abs(v) >= 100 ? num(Math.round(v)) : (Math.round(v * 10) / 10).toString().replace(".", ",");
  return unit ? `${n} ${unit}` : n;
}

export function VersusPage() {
  const [v, setV] = useState<Versus | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [pick, setPick] = useState("lock");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const right = useSim((s) => s.state);
  const setError = useSim((s) => s.setError);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.scenarios().then(setScenarios).catch(() => {});
  }, []);

  useEffect(() => {
    let off = false;
    const poll = async () => {
      try {
        const r = await api.versus(true);
        if (off) return;
        setV(r);
        const st = (r.left?.state ?? null) as State | null;
        if (st) {
          const now = performance.now();
          const same = left.state && left.state.run_id === st.run_id && st.t >= left.state.t;
          left.prev = same ? left.state : null;
          left.prevRecvAt = same ? left.recvAt : now;
          left.state = st;
          left.recvAt = now;
        }
      } catch {
        /* сервер перезапускается — следующий опрос */
      }
      if (!off) timer.current = window.setTimeout(poll, 250);
    };
    poll();
    return () => {
      off = true;
      window.clearTimeout(timer.current);
    };
  }, []);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () => run(async () => {
    left.state = left.prev = null;
    await api.versusStart(pick);
    await api.control({ action: "speed", speed: 30 });
    await api.control({ action: "start" });
    setMsg(null);
  });
  const hold = (id: string) => run(async () => {
    const r = await api.versusHold(id, 5);
    setMsg(`Вы: ${r.message}`);
  });
  const busiest = (): string | null => {
    const st = right;
    if (!st) return null;
    const cnt = new Map<string, number>();
    for (const t of st.trains) if (t.section_id) cnt.set(t.section_id, (cnt.get(t.section_id) ?? 0) + 1);
    let best: string | null = null;
    let n = -1;
    for (const [k, c] of cnt) if (c > n) { best = k; n = c; }
    return best;
  };

  const L = v?.left?.score;
  const R = v?.right?.score;
  const d = v?.diff;
  const ahead = d && d.money > 0.5;
  return (
    <div className="page versus">
      <header className="page-head">
        <h1>Человек против Бағдара</h1>
        <p className="lead">
          Один и тот же поток поездов и одни и те же сбои. <b>Сверху</b> участок без умного плана: кто первый
          подошёл к перегону, тот и едет. <b>Снизу</b> тот же участок ведёт Бағдар. Попробуйте помочь верхнему
          участку сами — нажмите на поезд, чтобы придержать его на станции на 5 минут.
        </p>
      </header>

      <div className="versus-controls">
        <label className="field">Сценарий{" "}
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" onClick={start} disabled={busy}>▶ Начать соревнование</button>
        {v?.active && (
          <>
            <button className="btn" onClick={() => run(() => api.control({ action: v.running ? "pause" : "start" }))}>
              {v.running ? "⏸ Пауза" : "▶ Дальше"}
            </button>
            <div className="seg">
              {[10, 30, 100].map((x) => (
                <button key={x} aria-pressed={v.speed === x} onClick={() => run(() => api.control({ action: "speed", speed: x }))}>×{x}</button>
              ))}
            </div>
            <button className="btn" disabled={busy} onClick={() => {
              const sec = busiest();
              if (sec) run(() => api.event({ type: "section_closed", section_id: sec, minutes: 30 }));
            }} title="Закрыть самый загруженный перегон на 30 мин — на обеих сторонах сразу">⚠ Закрыть перегон</button>
            <button className="btn" disabled={busy} onClick={() => run(() => api.event({ type: "add_trains", count: 4, within_min: 30 }))}
              title="Четыре лишних грузовых за 30 мин — на обеих сторонах">+4 поезда</button>
            <button className="btn" onClick={() => run(() => api.versusStop())}>Стоп</button>
            <span className="chip tabular">модель {hhmm(v.t)}</span>
          </>
        )}
      </div>

      {!v?.active ? (
        <div className="versus-empty card">
          <div className="card-body">
            <p>Выберите сценарий и нажмите «Начать соревнование». Лучше всего видно на «Замке» и «Резком росте потока»:
              через час-полтора модели без Бағдара поезда начинают вставать.</p>
          </div>
        </div>
      ) : (
        <>
          <div className={`versus-verdict ${ahead ? "is-ahead" : ""}`} role="status">
            {ahead ? (
              <>Бағдар впереди на <b>{fmt(d!.money, "у.е.")}</b>
                {d!.delay_min > 0 && <> и <b>{fmt(d!.delay_min, "поездо-мин")}</b> задержки</>}
                {d!.frozen > 0 && <>; без него стоят намертво ещё <b>{d!.frozen} п.</b></>}</>
            ) : <>Пока примерно поровну — разница появляется при сбоях и плотном потоке</>}
            <span className="muted small"> · цифры условные, тарифы — в ⚙ Настройках</span>
          </div>
          <div className="versus-board">
            <table className="versus-table">
              <thead><tr><th /><th className="side-l">Без Бағдара</th><th className="side-r">С Бағдаром</th></tr></thead>
              <tbody>
                {ROWS.map((r) => {
                  const a = L?.[r.key] as number | undefined;
                  const b = R?.[r.key] as number | undefined;
                  const win = a != null && b != null && a !== b ? ((r.better === "less" ? b < a : b > a) ? "r" : "l") : "";
                  return (
                    <tr key={r.key} title={r.hint}>
                      <th>{r.label}</th>
                      <td className={win === "l" ? "win" : ""}>{fmt(a, r.unit)}</td>
                      <td className={win === "r" ? "win" : ""}>{fmt(b, r.unit)}</td>
                    </tr>
                  );
                })}
                <tr><th>Индекс эффективности</th>
                  <td>{L?.index != null ? Math.round(L.index) : "—"} {L?.index_status ?? ""}</td>
                  <td>{R?.index != null ? Math.round(R.index) : "—"} {R?.index_status ?? ""}</td></tr>
              </tbody>
            </table>
          </div>
          <section className="card versus-side">
            <div className="card-head">
              <span className="card-title side-l">Без Бағдара — «кто первый пришёл»</span>
              <span className="card-sub">нажмите на поезд, чтобы придержать его на 5 мин</span>
              {L && L.frozen > 0 && <span className="badge badge-warning">стоят намертво: {L.frozen_numbers.join(", ")}</span>}
            </div>
            <LineScheme source={leftSource} stateOverride={left.state} onTrain={hold} selectedOverride={null} />
          </section>
          <section className="card versus-side">
            <div className="card-head">
              <span className="card-title side-r">С Бағдаром</span>
              <span className="card-sub">план пересчитывается сам при каждом событии</span>
              {R && R.frozen > 0 && <span className="badge badge-neutral">долго стоят: {R.frozen_numbers.join(", ")}</span>}
            </div>
            <LineScheme />
          </section>
          {(msg || (v.actions?.length ?? 0) > 0) && (
            <div className="muted small versus-actions">
              {msg}{(v.actions?.length ?? 0) > 0 && ` · ваших решений: ${v.actions!.length}`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
