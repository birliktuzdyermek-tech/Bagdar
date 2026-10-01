import { INDEX_STATUS } from "../charts/IndexPanel";
import { RED_BUDGET, useAlarms } from "../lib/alarms";
import { clock, minutes, simDate } from "../lib/format";
import { useSim } from "../store/sim";

const MODE_LABEL: Record<string, string> = { light: "Лёгкий · Участок", medium: "Средний · Регион", ultra: "Ультра · Сеть" };

function Recovery() {
  const rec = useSim((s) => s.state?.planner.recovery);
  const t = useSim((s) => s.state?.t ?? 0);
  if (!rec) return null;
  let text = "уже в норме";
  let title = "Ни один поезд по плану не выходит за допуск по опозданию";
  if (rec.affected > 0) {
    const parts: string[] = [];
    if (rec.recovery_at != null) {
      const m = Math.max(1, Math.round((rec.recovery_at - t) / 60));
      parts.push(m >= 90 ? `через ${Math.floor(m / 60)} ч ${m % 60} мин` : `через ${m} мин`);
    }
    if (rec.beyond_horizon > 0) parts.push(`${rec.beyond_horizon} п. — позже 3 ч`);
    text = parts.join(", ") || "—";
    title = `По действующему плану за допуск выходят ${rec.affected} поезд(ов); вне допуска сейчас: ${rec.late_now}. `
      + "Время — когда восстановятся те, кто восстанавливается на горизонте 3 ч.";
  }
  return (
    <div className="kpi" title={title}>
      <span className="kpi-label">График восстановится{rec.affected > 0 ? ` · задето ${rec.affected}` : ""}</span>
      <span className="kpi-value kpi-small">{text}</span>
    </div>
  );
}

export function TopBar() {
  const world = useSim((s) => s.world);
  const state = useSim((s) => s.state);
  const conn = useSim((s) => s.conn);
  const alarms = useAlarms();
  const m = state?.metrics;
  const extra = Math.max(0, alarms.all.length - RED_BUDGET);
  const index = state?.index;
  const ist = index ? INDEX_STATUS[index.status] : INDEX_STATUS.no_data;
  const indexCls = index?.status === "critical" && !alarms.red.has("index") ? "badge-serious" : ist.cls;

  return (
    <header className="topbar">
      <div className="brand brand-col">
        <span className="brand-name">БАҒДАР</span>
        <span className="brand-sub" title="Режим моделирования">{world ? MODE_LABEL[world.mode] ?? world.mode : "—"}</span>
      </div>
      <div className="clock" aria-live="off">
        <span className="clock-time">{state ? clock(state.t) : "--:--:--"}</span>
        <span className="clock-date">
          {state ? simDate(state.t) : ""} · UTC+5 ·{" "}
          {state ? (state.running ? `идёт ×${state.speed}` : "пауза") : "нет данных"}
        </span>
      </div>
      <div className="top-index" title={"Насколько хорошо работает участок, 0–100: 100 — всё по графику. " + (index?.reasons.join("\n") || "")}>
        <span className="kpi-label">Индекс участка</span>
        <span className="top-index-row">
          <span className="top-index-value">{index?.value != null ? Math.round(index.value) : "—"}</span>
          <span className={`badge ${indexCls}`}><span aria-hidden>{ist.icon}</span> {index?.status_label ?? "нет данных"}</span>
        </span>
      </div>
      <div className="kpis">
        <div className="kpi" title="Сколько поездов сейчас на станциях и перегонах участка">
          <span className="kpi-label">Поездов на участке</span>
          <span className="kpi-value">{m?.active_trains ?? "—"}</span>
        </div>
        <div className="kpi" title="В среднем на один поезд, относительно расписания">
          <span className="kpi-label">Средняя задержка</span>
          <span className="kpi-value">{m ? `${minutes(m.avg_delay_s)} мин` : "—"}</span>
        </div>
        <div className="kpi" title="Конфликты на ближайший час, если ничего не перепланировать. Найденный конфликт запускает пересчёт.">
          <span className="kpi-label">Конфликтов впереди</span>
          <span className="kpi-value">
            {state && state.planner.conflicts > 0 && <span className="warn-mark" aria-hidden>▲ </span>}
            {state ? state.planner.conflicts : "—"}
          </span>
        </div>
        <div className="kpi" title="Сколько секунд Бағдар считал последний план: решатель, проверка, карточки с объяснениями">
          <span className="kpi-label">План пересчитан за</span>
          <span className="kpi-value">
            {state?.planner.busy ? "считает…" : state?.planner.compute_ms != null
              ? `${(state.planner.compute_ms / 1000).toFixed(1).replace(".", ",")} с` : "—"}
          </span>
        </div>
        <Recovery />
        <div className="kpi" title={"Опоздания сверх допуска, конфликты, сбои — по убыванию цены. Красным на экране только три самых дорогих.\n"
          + alarms.all.slice(0, 8).map((a) => `• ${a.label}`).join("\n")}>
          <span className="kpi-label">Проблемы</span>
          <span className="kpi-value">
            {alarms.all.length}
            {extra > 0 && <span className="muted" style={{ fontSize: 12 }}> (+{extra} в счётчике)</span>}
          </span>
        </div>
      </div>
      <div className="spacer" />
      {state?.planner.awaiting_choice && (
        <span className="badge badge-warning" title="План ждёт выбора диспетчера по карточке C">C · ждёт выбора</span>
      )}
      <span className="chip" role="status" aria-live="polite">
        <span className="dot" style={{ background: conn === "open" ? "var(--good)" : conn === "connecting" ? "var(--warning)" : "var(--critical)" }} />
        {conn === "open" ? "связь" : conn === "connecting" ? "подключение…" : "нет связи"}
      </span>
      <span className="chip chip-disclaimer" title="Не управляет реальными сигналами, стрелками и поездами и не заменяет СЦБ. Данные синтетические, веса и цены условные.">
        ⓘ Консультативный прототип — не система управления движением
      </span>
    </header>
  );
}
