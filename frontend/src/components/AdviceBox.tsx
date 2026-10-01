import type { SpeedAdvice } from "../api/types";

/** Совет машинисту: рекомендуемая скорость против полного хода и условный расход. */
export function AdviceBox({ a }: { a: SpeedAdvice }) {
  const slower = a.v_rec_kmh < a.v_full_kmh;
  const max = Math.max(a.e_full_kwh, 1);
  return (
    <div className={`advice ${slower ? "advice-on" : ""}`} aria-label="Совет машинисту">
      <div className="advice-head">
        <span className="advice-title">Совет машинисту</span>
        <span className="advice-speed tabular">{a.v_rec_kmh} км/ч</span>
        <span className="muted small">полный ход {a.v_full_kmh} · лимит {a.v_limit_kmh}</span>
      </div>
      <div className="advice-text">{a.text}</div>
      {slower && (
        <div className="advice-bars" aria-label="Условный расход на остаток перегона">
          <div className="advice-bar">
            <span className="advice-bar-label">полный ход</span>
            <span className="advice-bar-track"><span style={{ width: `${(a.e_full_kwh / max) * 100}%` }} className="fill-full" /></span>
            <span className="tabular small">{Math.round(a.e_full_kwh)} кВт·ч</span>
          </div>
          <div className="advice-bar">
            <span className="advice-bar-label">по совету</span>
            <span className="advice-bar-track"><span style={{ width: `${(a.e_rec_kwh / max) * 100}%` }} className="fill-rec" /></span>
            <span className="tabular small">{Math.round(a.e_rec_kwh)} кВт·ч</span>
          </div>
          <div className="small">
            Экономия ≈ <b>{Math.round(a.saving_kwh)} кВт·ч</b> ({a.saving_pct.toFixed(0)} %)
            {a.stop_avoided ? " и без остановки у входного" : ""}
          </div>
        </div>
      )}
      <div className="muted small">Модель относительная (ход + E = m·v²/2 на остановку), не тяговый расчёт. Выше лимита не советуется никогда.</div>
    </div>
  );
}
