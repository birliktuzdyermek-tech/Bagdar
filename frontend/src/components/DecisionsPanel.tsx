import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { DecisionCard, PlannerInfo } from "../api/types";
import { clock, num } from "../lib/format";
import { useSim } from "../store/sim";

const LEVEL: Record<string, { label: string; cls: string; hint: string }> = {
  A: { label: "A · авто", cls: "badge-neutral", hint: "Мелкая корректировка в пределах запаса, применена сама" },
  B: { label: "B · авто с уведомлением", cls: "badge-accent", hint: "Меняется порядок поездов: применено, диспетчер уведомлён" },
  C: {
    label: "C · нужен выбор",
    cls: "badge-warning",
    hint: "Пассажирский остаётся сверх допуска. В режиме «полный авто» применён лучший вариант",
  },
};

const TYPE: Record<string, string> = {
  crossing: "Скрещение",
  overtake: "Обгон",
  track: "Путь приёма",
  hold: "Удержание",
  no_plan: "План не найден",
};

const SOLVER: Record<string, string> = { cpsat: "CP-SAT", greedy: "эвристика", repair: "прежний порядок", hold: "удержание" };
const STATUS: Record<string, { text: string; cls: string }> = {
  feasible: { text: "допустим", cls: "badge-good" },
  delayed: { text: "допустим, есть задержки", cls: "badge-warning" },
  infeasible: { text: "не найден — поезда удержаны", cls: "badge-critical" },
};

function Card({ c }: { c: DecisionCard }) {
  const selectTrain = useSim((s) => s.selectTrain);
  const selectStation = useSim((s) => s.selectStation);
  const lv = LEVEL[c.level] ?? LEVEL.B;
  const money = c.delta_money;
  return (
    <li
      className={`decision lvl-${c.level}`}
      onClick={() => {
        if (c.trains[0]) selectTrain(c.trains[0]);
        if (c.station_id) selectStation(c.station_id);
      }}
    >
      <div className="decision-head">
        <span className={`badge ${lv.cls}`} title={lv.hint}>{lv.label}</span>
        <span className="decision-type">{TYPE[c.type] ?? c.type}</span>
        <span className="spacer" />
        <span className="muted tabular">{clock(c.t, false)} · план v{c.plan_version}</span>
      </div>
      <div className="decision-action">{c.action}</div>
      <div className="decision-row"><span className="muted">Почему:</span> {c.reason}</div>
      <div className="decision-row">
        <span className="muted">Альтернатива:</span> {c.alternative}
        {c.alt_feasible && money != null && (
          <span className={`badge ${money >= 0 ? "badge-neutral" : "badge-warning"}`} style={{ marginLeft: 6 }}>
            {money >= 0 ? `дороже на ${num(money)} у.е.` : `дешевле на ${num(-money)} у.е.`}
          </span>
        )}
        {(c.alt_pte_violations ?? 0) > 0 && <span className="badge badge-warning" style={{ marginLeft: 6 }}>нарушает ПТЭ</span>}
        {!c.alt_feasible && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>недопустима</span>}
      </div>
      {c.note && <div className="decision-row muted">{c.note}</div>}
      <div className="decision-foot muted">
        {c.full_auto ? "Применено автоматически (полный авто)" : "Ожидает решения диспетчера"}
      </div>
    </li>
  );
}

export function DecisionsPanel() {
  const cards = useSim((s) => s.cards);
  const planner = useSim((s) => s.state?.planner);
  const [info, setInfo] = useState<PlannerInfo | null>(null);
  const version = planner?.version ?? 0;

  useEffect(() => {
    if (!version) return;
    api.planner().then(setInfo).catch(() => setInfo(null));
  }, [version]);

  const last = info?.history[info.history.length - 1];
  const compare = useMemo(() => {
    if (!last) return null;
    const heur = last.candidates.filter((c) => c.name !== "cpsat" && c.valid && c.J_lex != null);
    const cp = last.candidates.find((c) => c.name === "cpsat");
    const bestHeur = heur.length ? Math.min(...heur.map((c) => c.J_lex as number)) : null;
    return { bestHeur, cp: cp?.valid ? cp.J_lex : null };
  }, [last]);
  const shown = cards.slice(-40).reverse();
  const st = planner?.status ? STATUS[planner.status] : null;

  return (
    <section className="card" aria-label="Решения Бағдара">
      <div className="card-head">
        <span className="card-title">Решения Бағдара</span>
        <span className="card-sub">{cards.length ? `${cards.length} за прогон` : ""}</span>
      </div>
      <div className="card-body">
        {planner && planner.version > 0 ? (
          <div className="planner-box">
            <div className="status-line" style={{ margin: 0 }}>
              <b>План v{planner.version}</b>
              <span className="muted">{SOLVER[planner.solver ?? ""] ?? planner.solver}</span>
              {st && <span className={`badge ${st.cls}`}>{st.text}</span>}
              {planner.busy && <span className="badge badge-accent">пересчёт…</span>}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Пересчёт {planner.compute_ms != null ? `${(planner.compute_ms / 1000).toFixed(1).replace(".", ",")} с` : "—"}
              {planner.J != null && <> · J = {num(planner.J)} у.е.</>}
              {compare?.bestHeur != null && compare.cp != null && compare.bestHeur > 0 && (
                <> · эвристика {num(compare.bestHeur)} → CP-SAT {num(compare.cp)} (−{Math.round((1 - compare.cp / compare.bestHeur) * 100)} %)</>
              )}
            </div>
            {planner.reason && <div className="muted" style={{ fontSize: 12 }}>Причина: {planner.reason}</div>}
          </div>
        ) : (
          <div className="empty">Планировщик готовит первый план…</div>
        )}
        {shown.length === 0 ? (
          <div className="empty">Порядок поездов пока не менялся: исходный график бесконфликтен. Задержите поезд в его карточке — система перестроит план и объяснит решения.</div>
        ) : (
          <ul className="decisions">{shown.map((c) => <Card key={c.id} c={c} />)}</ul>
        )}
      </div>
    </section>
  );
}
