import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { useSim } from "../store/sim";

const FACTORS: [keyof Settings["weights"], string][] = [
  ["throughput", "Пропускная способность"],
  ["punctuality", "Отклонение от графика"],
  ["track_load", "Загрузка путей"],
  ["resource_idle", "Простой локомотивов и бригад"],
  ["conflicts", "Конфликты маршрутов"],
];
const TARIFFS: [keyof Settings["tariffs"], string][] = [
  ["kwh", "кВт·ч электроэнергии"],
  ["loco_hour", "час простоя локомотива"],
  ["crew_hour", "час простоя бригады"],
  ["delay_min_pax", "минута задержки пассажирского"],
  ["delay_min_freight", "минута задержки грузового"],
];

/** Настройки на лету: веса и пороги индекса, строгий ПТЭ, «подставьте свой тариф». */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const index = useSim((st) => st.state?.index);
  const setError = useSim((st) => st.setError);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setError(String(e.message ?? e)));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, setError]);

  if (!s) return null;
  const wsum = FACTORS.reduce((a, [k]) => a + Math.max(0, s.weights[k]), 0) || 1;
  const save = async (body: Parameters<typeof api.saveSettings>[0]) => {
    try {
      const out = await api.saveSettings(body);
      setS(out);
      setMsg(body.reset ? "Вернули значения из конфига" : "Применено — индекс пересчитан");
      setError(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Настройки" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="card-title">Настройки</span>
          <span className="card-sub">меняются на лету, без перезапуска</span>
          <span className="spacer" />
          <button className="btn btn-small" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="modal-body settings-grid">
          <section>
            <h3>Веса индекса</h3>
            <p className="muted small">Сколько каждый фактор весит в общем числе 0–100. Сумма приводится к 100 %.</p>
            {FACTORS.map(([k, label]) => (
              <label key={k} className="slider-row">
                <span>{label}</span>
                <input type="range" min={0} max={1} step={0.05} value={s.weights[k]}
                  onChange={(e) => setS({ ...s, weights: { ...s.weights, [k]: Number(e.target.value) } })} />
                <span className="tabular">{Math.round((Math.max(0, s.weights[k]) / wsum) * 100)} %</span>
              </label>
            ))}
            <h3>Пороги статуса</h3>
            <div className="row-fields">
              <label className="field">«Норма» от <input className="input input-num" type="number" value={s.thresholds.normal}
                onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, normal: Number(e.target.value) } })} /></label>
              <label className="field">«Внимание» от <input className="input input-num" type="number" value={s.thresholds.warning}
                onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, warning: Number(e.target.value) } })} /></label>
            </div>
            <label className="field small">
              <input type="checkbox" checked={s.pte_strict} onChange={(e) => setS({ ...s, pte_strict: e.target.checked })} />
              Строгий ПТЭ: старший поезд не получает задержку сверх допуска ради младшего
            </label>
          </section>
          <section>
            <h3>Подставьте свой тариф</h3>
            <p className="muted small">Цены для счётчиков денег в режиме «Человек против Бағдара». Все цифры условные (у.е.).</p>
            {TARIFFS.map(([k, label]) => (
              <label key={k} className="slider-row">
                <span>{label}</span>
                <input className="input input-num" type="number" min={0} step="any" value={s.tariffs[k]}
                  onChange={(e) => setS({ ...s, tariffs: { ...s.tariffs, [k]: Number(e.target.value) } })} />
                <span className="muted small">у.е.</span>
              </label>
            ))}
            {index && (
              <div className="settings-index">
                Индекс сейчас: <b className="tabular">{index.value == null ? "—" : Math.round(index.value)}</b> · {index.status_label}
              </div>
            )}
          </section>
        </div>
        <div className="modal-foot">
          {msg && <span className="muted small" role="status">{msg}</span>}
          <span className="spacer" />
          <button className="btn" onClick={() => save({ reset: true })}>Сбросить к конфигу</button>
          <button className="btn btn-primary" onClick={() => save({ weights: s.weights, thresholds: s.thresholds, pte_strict: s.pte_strict, tariffs: s.tariffs, reset: false })}>
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}
