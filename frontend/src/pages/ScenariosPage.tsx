import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Scenario } from "../api/types";
import { useSim } from "../store/sim";
import { go } from "../lib/route";

const WAVE: Record<number, string> = { 0: "обязательный", 1: "первая волна", 2: "вторая волна", 3: "третья волна" };

/** Сценарии: карточки ситуаций с объяснением простыми словами и запуском в один клик. */
export function ScenariosPage() {
  const [list, setList] = useState<Scenario[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const world = useSim((s) => s.world);
  const setError = useSim((s) => s.setError);

  useEffect(() => {
    api.scenarios().then(setList).catch((e) => setError(String(e.message ?? e)));
  }, [setError]);

  const launch = async (sc: Scenario, speed: number) => {
    setBusy(sc.id);
    try {
      await api.load({ scenario_id: sc.id });
      await api.control({ action: "speed", speed });
      await api.control({ action: "start" });
      go("dispatcher");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const order = (s: Scenario) => (s.id === "normal" ? -1 : s.wave * 10 + s.difficulty);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Сценарии</h1>
        <p className="lead">
          Каждая карточка — готовая ситуация на участке из 20 станций. Нажмите «Запустить»: модель
          загрузится, время пойдёт, а сбой случится сам в указанное время. Всё считается по-настоящему.
        </p>
      </header>
      <div className="scenario-grid">
        {[...list].sort((a, b) => order(a) - order(b)).map((sc) => { const events = sc.events ?? []; return (
          <article key={sc.id} className={`scenario-card ${world?.scenario_id === sc.id ? "is-current" : ""}`}>
            <div className="scenario-top">
              {sc.situation ? <span className="badge badge-neutral">ситуация № {sc.situation}</span> : null}
              <span className="badge badge-neutral">{WAVE[sc.wave] ?? `волна ${sc.wave}`}</span>
              <span className="difficulty" aria-label={`сложность ${sc.difficulty} из 3`}>
                {[1, 2, 3].map((i) => <i key={i} className={i <= sc.difficulty ? "on" : ""} />)}
              </span>
            </div>
            <h2>{sc.title}</h2>
            <p className="scenario-plain">{sc.plain || sc.summary}</p>
            {events.length > 0 && (
              <ol className="scenario-events">
                {events.slice(0, 4).map((e, i) => (
                  <li key={i}><span className="tabular">{e.at}</span> {e.label}</li>
                ))}
                {events.length > 4 && <li className="muted">ещё {events.length - 4}…</li>}
              </ol>
            )}
            <div className="scenario-actions">
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => launch(sc, 30)}>
                {busy === sc.id ? "Загрузка…" : "▶ Запустить"}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => launch(sc, 100)} title="Ускорение ×100">
                быстро ×100
              </button>
              {world?.scenario_id === sc.id && <span className="muted small">сейчас загружен</span>}
            </div>
          </article>
        ); })}
      </div>
    </div>
  );
}
