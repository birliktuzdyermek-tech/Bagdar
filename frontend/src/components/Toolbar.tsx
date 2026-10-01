import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Scenario } from "../api/types";
import { useSim } from "../store/sim";

const SPEEDS = [1, 2, 5, 10, 30, 60, 100];

export function Toolbar({ theme, onTheme }: { theme: string; onTheme: () => void }) {
  const state = useSim((s) => s.state);
  const world = useSim((s) => s.world);
  const setError = useSim((s) => s.setError);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [seed, setSeed] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.scenarios().then(setScenarios).catch((e) => setError(String(e.message ?? e)));
  }, [setError]);
  useEffect(() => {
    if (world) setSeed(String(world.seed));
  }, [world]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = state?.running ?? false;
  const toggle = () => run(() => api.control({ action: running ? "pause" : "start" }));
  const step = () => run(() => api.control({ action: "step", step_s: 60 }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.code === "ArrowRight") {
        step();
      } else if (e.code === "Escape") {
        useSim.getState().selectTrain(null);
        useSim.getState().selectStation(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const seedNum = Number(seed);
  const seedValid = seed !== "" && Number.isInteger(seedNum) && seedNum >= 0 && seedNum < 2 ** 31;

  return (
    <div className="toolbar" role="toolbar" aria-label="Управление симуляцией">
      <button className="btn btn-primary" onClick={toggle} disabled={!state || busy} title="Пробел">
        {running ? "⏸ Пауза" : "▶ Старт"}
      </button>
      <button className="btn" onClick={step} disabled={!state || busy} title="Шаг на 1 минуту модели (→)">
        ⏭ Шаг 1 мин
      </button>
      <div className="seg" role="group" aria-label="Ускорение времени">
        {SPEEDS.map((s) => (
          <button
            key={s}
            aria-pressed={state?.speed === s}
            onClick={() => run(() => api.control({ action: "speed", speed: s }))}
            disabled={busy}
          >
            ×{s}
          </button>
        ))}
      </div>
      <button className="btn" onClick={() => run(() => api.control({ action: "reset" }))} disabled={busy}
        title="Вернуть сценарий к началу с тем же seed">
        ↺ Сброс
      </button>
      <div className="spacer" />
      <label className="field">
        Сценарий
        <select
          className="input"
          value={world?.scenario_id ?? ""}
          onChange={(e) => run(() => api.load({ scenario_id: e.target.value }))}
          disabled={busy}
        >
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
      </label>
      <label className="field">
        seed
        <input
          className="input input-seed tabular"
          inputMode="numeric"
          value={seed}
          onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
          aria-invalid={!seedValid}
        />
      </label>
      <button
        className="btn"
        disabled={!seedValid || busy}
        onClick={() => run(() => api.load({ scenario_id: world?.scenario_id, seed: seedNum }))}
        title="Сгенерировать участок и график по этому seed"
      >
        Новый мир
      </button>
      <button className="btn" onClick={onTheme} aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}>
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </div>
  );
}
