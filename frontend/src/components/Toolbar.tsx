import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Scenario } from "../api/types";
import { focusMostImportant } from "../lib/focus";
import { useSim } from "../store/sim";

const SPEEDS = [1, 10, 30, 100];

export function Toolbar({ theme, onTheme }: { theme: string; onTheme: () => void }) {
  const state = useSim((s) => s.state);
  const world = useSim((s) => s.world);
  const setError = useSim((s) => s.setError);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [seed, setSeed] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [focusMsg, setFocusMsg] = useState<string | null>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const d = moreRef.current;
      if (d?.open && !(e.target instanceof Node && d.contains(e.target))) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && moreRef.current) moreRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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
      } else if (e.code === "KeyF") {
        setFocusMsg(focusMostImportant());
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
      <span className="tb-group" aria-label="Время модели">
        <button className="btn btn-primary" onClick={toggle} disabled={!state || busy}
          title={running ? "Остановить время модели (пробел)" : "Запустить время модели: поезда поедут (пробел)"}>
          {running ? "⏸ Пауза" : "▶ Старт"}
        </button>
        <button className="btn" onClick={step} disabled={!state || busy} title="Промотать модель на 1 минуту вперёд (→)">
          ⏭ +1 мин
        </button>
        <span className="tb-label" title="Во сколько раз время модели быстрее настоящего">скорость</span>
        <div className="seg" role="group" aria-label="Ускорение времени">
          {SPEEDS.map((s) => (
            <button key={s} aria-pressed={state?.speed === s} onClick={() => run(() => api.control({ action: "speed", speed: s }))}
              disabled={busy} title={s === 1 ? "Как в жизни" : s === 100 ? "Час модели за 36 секунд" : `В ${s} раз быстрее настоящего`}>
              ×{s}
            </button>
          ))}
        </div>
      </span>
      <span className="tb-group">
        <button className="btn" onClick={() => run(() => api.control({ action: "reset" }))} disabled={busy}
          title="Вернуть эту же ситуацию к 06:00 — поезда и сбои начнутся заново">
          ↺ Сначала
        </button>
        <button className="btn" onClick={() => run(() => api.replan())} disabled={busy || !state || state.planner.busy}
          title="Попросить Бағдар пересчитать план прямо сейчас. Обычно он делает это сам: при сбое, опоздании и каждые 5 минут модели">
          ⟳ Пересчитать план
        </button>
        <button className="btn btn-focus" onClick={() => setFocusMsg(focusMostImportant())} disabled={!state}
          title="Подсветит самое срочное на экране: решение, которое ждёт выбора, ближайший конфликт или самый опоздавший поезд (клавиша F)">
          ◎ Что сейчас важно?
        </button>
        {focusMsg && (
          <span className="chip focus-msg" role="status" onClick={() => setFocusMsg(null)} title={`${focusMsg} — нажмите, чтобы скрыть`}>
            {focusMsg}
          </span>
        )}
      </span>
      <div className="spacer" />
      <label className="field" title="Готовая ситуация со своими сбоями. Все описания — на вкладке «Сценарии»">
        Ситуация
        <select className="input" value={world?.scenario_id ?? ""} onChange={(e) => run(() => api.load({ scenario_id: e.target.value }))}
          disabled={busy}>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
      </label>
      <details className="tb-more" ref={moreRef}>
        <summary className="btn btn-small" title="Другой участок: сгенерировать станции и поезда по другому номеру">⋯ другой участок</summary>
        <div className="tb-more-body">
          <label className="field" title="Номер, из которого генерируются станции, пути и расписание. Один номер — всегда один и тот же участок">
            № участка
            <input className="input input-seed tabular" inputMode="numeric" value={seed}
              onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))} aria-invalid={!seedValid} />
          </label>
          <button className="btn btn-small" disabled={!seedValid || busy}
            onClick={() => run(() => api.load({ scenario_id: world?.scenario_id, seed: seedNum }))}>
            Сгенерировать
          </button>
        </div>
      </details>
      <button className="btn" onClick={onTheme} aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}>
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </div>
  );
}
