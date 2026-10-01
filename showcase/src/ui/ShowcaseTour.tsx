import { useCallback, useEffect, useRef, useState } from "react";
import { BgReplay } from "../pages/BgReplay";
import type { RunInfo } from "../replay/types";
import "./showcase-tour.css";

const IDLE_MS = 30_000;
const SCENE_MS = 45_000;

function eligibleRoute(route: string): boolean {
  return route === "#/" || route === "#" || route === "#/gallery" || route === "#/runs";
}

function recordingOrFullscreen(): boolean {
  return Boolean(
    document.fullscreenElement ||
      document.querySelector('[data-recording="true"]') ||
      document.body.dataset.recording === "true" ||
      document.documentElement.dataset.recording === "true",
  );
}

function formHasFocus(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && Boolean(el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

/** Автоматический тур по реально существующим записям. Маршрут не меняется до клика на CTA. */
export function ShowcaseTour({ runs, route }: { runs: RunInfo[]; route: string }) {
  const available = runs.filter((run) => Boolean(run.id && run.file));
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const lastActivity = useRef(Date.now());
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const previousRoute = useRef(route);
  const canTour = eligibleRoute(route) && available.length > 0;
  const run = available[index % Math.max(1, available.length)] ?? null;

  const start = useCallback(() => {
    if (!canTour || recordingOrFullscreen() || document.hidden) return;
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIndex(0);
    setPaused(false);
    setDismissed(false);
    setActive(true);
  }, [canTour]);

  const stop = useCallback(() => {
    setActive(false);
    setPaused(false);
    setDismissed(true);
    lastActivity.current = Date.now();
    window.requestAnimationFrame(() => priorFocus.current?.focus());
  }, []);

  useEffect(() => {
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const onVisible = () => {
      mark();
      if (document.hidden) setActive(false);
    };
    window.addEventListener("pointermove", mark, { passive: true });
    window.addEventListener("pointerdown", mark, { passive: true });
    window.addEventListener("keydown", mark);
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchstart", mark, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pointermove", mark);
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchstart", mark);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!canTour || active || dismissed) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= IDLE_MS && !document.hidden && !recordingOrFullscreen() && !formHasFocus()) start();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [canTour, active, dismissed, start]);

  useEffect(() => {
    if (previousRoute.current !== route) {
      previousRoute.current = route;
      lastActivity.current = Date.now();
      setActive(false);
      setDismissed(false);
    }
  }, [route]);

  useEffect(() => {
    if (!active) return;
    closeButton.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active || paused || available.length < 2) return;
    const timer = window.setTimeout(() => setIndex((i) => (i + 1) % available.length), SCENE_MS);
    return () => window.clearTimeout(timer);
  }, [active, paused, index, available.length]);

  useEffect(() => {
    if (!active) return;
    const onFullscreen = () => {
      if (document.fullscreenElement) stop();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [active, stop]);

  if (!canTour || !run) return null;

  return (
    <>
      {!active && (
        <button type="button" className="showcase-tour-launch" onClick={start} aria-label="Запустить режим витрины">
          ◉ Режим витрины
        </button>
      )}
      {active && (
        <section
          className="showcase-tour"
          role="dialog"
          aria-modal="true"
          aria-label="Режим витрины: записи прогонов"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              stop();
            } else if (e.key === "ArrowRight" && available.length > 1) {
              e.preventDefault();
              setIndex((i) => (i + 1) % available.length);
            } else if (e.key === "ArrowLeft" && available.length > 1) {
              e.preventDefault();
              setIndex((i) => (i - 1 + available.length) % available.length);
            } else if (e.key === "Tab") {
              const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button, a[href]"));
              if (!controls.length) return;
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }}
        >
          {/** BgReplay draws only positions reconstructed from the loaded replay frames. */}
          {!paused && <BgReplay key={run.id} run={run} />}
          <div className="showcase-tour-shade" aria-hidden />
          <div className="showcase-tour-head">
            <span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Запись прогона</span>
            <span className="showcase-tour-mode">Режим витрины</span>
            <button ref={closeButton} type="button" className="btn showcase-tour-close" onClick={stop} aria-label="Закрыть режим витрины">
              ✕ <span>Закрыть</span>
            </button>
          </div>
          <div className="showcase-tour-content" aria-live="polite">
            <p className="showcase-tour-eyebrow">{run.situation == null ? "Штатный прогон" : `Ситуация ${run.situation}`} · seed {run.seed}</p>
            <h2>{run.title}</h2>
            <p>Реальная запись работы симулятора Ядра. Время модели: {run.from}–{run.to}.</p>
            {(run.injected ?? []).map((event) => (
              <p key={`${event.at}-${event.train_id}`} className="showcase-tour-injected">
                В {event.at} введена внешняя задержка поезда {event.train_id} на {event.minutes} мин: {event.reason}.
              </p>
            ))}
            {run.note && <p className="showcase-tour-note">{run.note}</p>}
            {paused && <p className="showcase-tour-paused">Тур на паузе</p>}
          </div>
          <div className="showcase-tour-foot">
            <span className="showcase-tour-count">{index + 1} / {available.length} записей</span>
            <div className="showcase-tour-controls">
              {available.length > 1 && (
                <button type="button" className="btn" onClick={() => setIndex((i) => (i - 1 + available.length) % available.length)} aria-label="Предыдущая запись">←</button>
              )}
              <button type="button" className="btn" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Продолжить тур" : "Приостановить тур"}>
                {paused ? "▶ Продолжить" : "Ⅱ Пауза"}
              </button>
              {available.length > 1 && (
                <button type="button" className="btn" onClick={() => setIndex((i) => (i + 1) % available.length)} aria-label="Следующая запись">→</button>
              )}
              <a className="btn btn-primary" href={`#/play/${run.id}`} onClick={() => setActive(false)}>Открыть запись ↗</a>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
