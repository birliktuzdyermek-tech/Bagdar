import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { useMoney } from "../store/money";
import { useSim } from "../store/sim";

const FACTORS: [keyof Settings["weights"], string][] = [
  ["throughput", "Пропускная способность"],
  ["punctuality", "Отклонение от графика"],
  ["track_load", "Загрузка путей"],
  ["resource_idle", "Простой локомотивов и бригад"],
  ["conflicts", "Конфликты маршрутов"],
];
type TariffKey = "kwh" | "loco_hour" | "crew_hour" | "delay_min_pax" | "delay_min_freight";
const TARIFFS: [TariffKey, string, string][] = [
  ["delay_min_pax", "минута опоздания пассажирского поезда", "время людей, компенсации, сорванные пересадки"],
  ["delay_min_freight", "минута опоздания грузового поезда", "штрафы по договору, срыв сроков доставки"],
  ["kwh", "кВт·ч энергии", "каждая лишняя остановка — энергия на торможение и разгон"],
  ["loco_hour", "час простоя локомотива", "локомотив стоит и не везёт"],
  ["crew_hour", "час простоя бригады", "машинист с помощником ждут, смена уходит"],
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
  const cur = s.tariffs.currency ?? "₸";
  const k = cur === "₸" ? (s.tariffs.tenge_per_unit ?? 1000) : 1;   // тарифы редактируются в валюте показа
  const setTariff = (key: TariffKey, shown: number) => setS({ ...s, tariffs: { ...s.tariffs, [key]: shown / k } });
  const save = async (body: Parameters<typeof api.saveSettings>[0]) => {
    try {
      const out = await api.saveSettings(body);
      setS(out);
      useMoney.getState().set(out.tariffs.currency ?? "₸", out.tariffs.tenge_per_unit ?? 1000);
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
            <h3>Деньги: откуда берутся суммы</h3>
            <p className="muted small">
              Модель не знает настоящих расценок. Она считает минуты опозданий, кВт·ч лишних остановок и часы простоя
              и умножает их на тарифы ниже. Подставьте свои — все суммы в «Сводке», «Человек против Бағдара» и в карточках пересчитаются.
            </p>
            <div className="row-fields">
              <label className="field">Показывать в
                <select className="input" value={cur} onChange={(e) => setS({ ...s, tariffs: { ...s.tariffs, currency: e.target.value as "₸" | "у.е." } })}>
                  <option value="₸">тенге (₸)</option>
                  <option value="у.е.">условных единицах (у.е.)</option>
                </select>
              </label>
              {cur === "₸" && (
                <label className="field" title="Внутри модели всё в условных единицах; это курс для показа">1 у.е. =
                  <input className="input input-num" type="number" min={1} step="any" value={s.tariffs.tenge_per_unit ?? 1000}
                    onChange={(e) => setS({ ...s, tariffs: { ...s.tariffs, tenge_per_unit: Math.max(1, Number(e.target.value) || 1) } })} /> ₸
                </label>
              )}
            </div>
            {TARIFFS.map(([key, label, why]) => (
              <label key={key} className="slider-row" title={why}>
                <span>{label}<br /><span className="muted small">{why}</span></span>
                <input className="input input-num" type="number" min={0} step="any" value={Math.round((s.tariffs[key] ?? 0) * k * 100) / 100}
                  onChange={(e) => setTariff(key, Number(e.target.value) || 0)} />
                <span className="muted small">{cur}</span>
              </label>
            ))}
            <div className="settings-money">
              <b>Как читать цифры.</b> Карточки решений и «Кто первым?» считают цену варианта по весам планировщика:
              минута пассажирского поезда — 50–100 у.е. в зависимости от класса, × пассажиров/500; грузового — 5–30 у.е.,
              × 1,5 за срочный груз, × 2 за истекающий срок доставки или усталую бригаду; остановка — 0,5 у.е. за кВт·ч, простой — 2 у.е. в минуту.
              Нарушение ПТЭ не покупается ни за какие деньги. Тарифы выше — упрощённая «бухгалтерия» для счётчиков потерь.
            </div>
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
