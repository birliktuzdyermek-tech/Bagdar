import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { HistoryInfo } from "../api/types";
import { hhmm } from "../lib/format";
import { backToLive, rewindTo } from "../lib/rewind";
import { useSim } from "../store/sim";

function hms(t: number): string {
  const s = Math.round(t) % 86400;
  return `${hhmm(s)}:${String(s % 60).padStart(2, "0")}`;
}

/** Перемотка: шкала журнала с метками событий, шаги назад и возврат к текущему моменту. */
export function RewindBar() {
  const past = useSim((s) => s.past);
  const liveT = useSim((s) => (s.live?.state ?? s.state)?.t ?? 0);
  const setError = useSim((s) => s.setError);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open && !past) return;
    api.history().then(setInfo).catch((e) => setError(String(e.message ?? e)));
  }, [open, past?.t, setError]);

  const go = (t: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      rewindTo(t).catch((e) => setError(String(e.message ?? e)));
    }, 120);
  };

  if (!open && !past) {
    return (
      <div className="rewind rewind-closed">
        <button className="btn btn-small" onClick={() => setOpen(true)} title="Посмотреть, что было 1–90 минут назад">
          ⏪ Перемотка
        </button>
      </div>
    );
  }
  const w = info?.window;
  const from = w?.from ?? liveT - 900;
  const to = w?.to ?? liveT;
  const cur = drag ?? past?.t ?? to;
  const span = Math.max(1, to - from);
  return (
    <div className={`rewind ${past ? "rewind-past" : ""}`} role="region" aria-label="Перемотка">
      <span className="rewind-label">
        {past ? <>⏪ Прошлое: <b className="tabular">{hms(past.t)}</b> — просмотр журнала, история не меняется</>
          : <>Перемотка: доступно {Math.round(span / 60)} мин журнала</>}
      </span>
      <div className="rewind-steps">
        {[15, 5, 1].map((m) => (
          <button key={m} className="btn btn-small" onClick={() => go(Math.max(from, (past?.t ?? to) - m * 60))}>−{m} мин</button>
        ))}
        {past && <button className="btn btn-small" onClick={() => go(Math.min(to, past.t + 60))}>+1 мин</button>}
      </div>
      <div className="rewind-track">
        <input type="range" min={from} max={to} step={10} value={cur} aria-label="Момент в прошлом"
          onChange={(e) => { const t = Number(e.target.value); setDrag(t); go(t); }}
          onPointerUp={() => setDrag(null)} />
        <div className="rewind-marks" aria-hidden>
          {(info?.marks ?? []).map((m, i) => (
            <span key={i} className={`mark mark-${m.severity}`} style={{ left: `${((m.t - from) / span) * 100}%` }}
              title={`${hms(m.t)} ${m.message}`} />
          ))}
        </div>
        <div className="rewind-scale tabular"><span>{hms(from)}</span><span>{hms(to)}</span></div>
      </div>
      <button className="btn btn-primary btn-small" onClick={() => { setDrag(null); backToLive().catch(() => {}); setOpen(false); }}>
        ● К текущему моменту
      </button>
    </div>
  );
}
