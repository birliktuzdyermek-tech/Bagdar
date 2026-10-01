import { useMemo } from "react";
import { computeAlarms, RED_BUDGET } from "../lib/alarms";
import { clock, minutes, simDate } from "../lib/format";
import { useSim } from "../store/sim";

const MODE_LABEL: Record<string, string> = { light: "Лёгкий · Участок", medium: "Средний · Регион", ultra: "Ультра · Сеть" };

export function TopBar() {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const state = useSim((s) => s.state);
  const conn = useSim((s) => s.conn);
  const alarms = useMemo(() => computeAlarms(world, idx, state), [world, idx, state]);
  const m = state?.metrics;
  const extra = Math.max(0, alarms.all.length - RED_BUDGET);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">БАҒДАР</span>
      </div>
      <div className="clock" aria-live="off">
        <span className="clock-time">{state ? clock(state.t) : "--:--:--"}</span>
        <span className="clock-date">
          {state ? simDate(state.t) : ""} · UTC+5 ·{" "}
          {state ? (state.running ? `идёт ×${state.speed}` : "пауза") : "нет данных"}
        </span>
      </div>
      <span className="chip chip-strong" title="Режим моделирования">{world ? MODE_LABEL[world.mode] ?? world.mode : "—"}</span>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Поездов на участке</span>
          <span className="kpi-value">{m?.active_trains ?? "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Средняя задержка</span>
          <span className="kpi-value">{m ? `${minutes(m.avg_delay_s)} мин` : "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Максимальная</span>
          <span className="kpi-value">{m ? `${minutes(m.max_delay_s, 0)} мин` : "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">В допуске</span>
          <span className="kpi-value">{m ? `${Math.round(m.on_time_share * 100)} %` : "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Ожидают</span>
          <span className="kpi-value">{m?.waiting_trains ?? "—"}</span>
        </div>
        <div className="kpi" title="Проблемы, отсортированные по цене. Красными показываются только три самых дорогих.">
          <span className="kpi-label">Проблемы</span>
          <span className="kpi-value">
            {alarms.all.length}
            {extra > 0 && <span className="muted" style={{ fontSize: 12 }}> (+{extra} в счётчике)</span>}
          </span>
        </div>
      </div>
      <div className="spacer" />
      <span className="chip" role="status" aria-live="polite">
        <span className="dot" style={{ background: conn === "open" ? "var(--good)" : conn === "connecting" ? "var(--warning)" : "var(--critical)" }} />
        {conn === "open" ? "связь есть" : conn === "connecting" ? "подключение…" : "нет связи"}
      </span>
      <span className="chip chip-disclaimer" title="Не управляет реальными сигналами, стрелками и поездами и не заменяет СЦБ. Данные синтетические, веса и цены условные.">
        ⓘ Консультативный прототип — не система управления движением
      </span>
    </header>
  );
}
