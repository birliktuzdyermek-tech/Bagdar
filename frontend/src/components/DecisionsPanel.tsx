import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { DecisionCard, PlannerInfo, Variant } from "../api/types";
import { useAlarms } from "../lib/alarms";
import { IncidentReport } from "./IncidentReport";
import { clock, num } from "../lib/format";
import { money, useMoney } from "../store/money";
import { useSim } from "../store/sim";

const LEVEL: Record<string, { label: string; cls: string; hint: string }> = {
  A: { label: "A · само", cls: "badge-neutral", hint: "Мелкая поправка в пределах запаса графика — применена без вопросов" },
  B: { label: "B · сделано", cls: "badge-accent", hint: "Поменялся порядок поездов: применено сразу, 30 секунд на отмену" },
  C: {
    label: "C · с вариантами",
    cls: "badge-warning",
    hint: "Пассажирский всё равно опоздает сверх допуска. Бағдар предлагает варианты с ценой; в «полном авто» сразу применяет лучший",
  },
};

const TYPE: Record<string, string> = {
  crossing: "Скрещение",
  overtake: "Обгон",
  track: "Путь приёма",
  hold: "Удержание",
  no_plan: "План не найден",
  incident: "Нештатная ситуация",
};

const STATUS: Record<string, { text: string; cls: string }> = {
  applied: { text: "применено", cls: "badge-neutral" },
  pending: { text: "ждёт выбора", cls: "badge-warning" },
  proposed: { text: "в предложении", cls: "badge-neutral" },
  cancelled: { text: "отменено диспетчером", cls: "badge-accent" },
  chosen: { text: "выбор диспетчера", cls: "badge-accent" },
  expired: { text: "истекло", cls: "badge-neutral" },
  superseded: { text: "не вступило", cls: "badge-neutral" },
};

const SOLVER: Record<string, string> = {
  cpsat: "решатель CP-SAT", greedy: "быстрая эвристика", repair: "прежний порядок", fifo: "«кто первый пришёл»", hold: "удержание",
  dispatcher: "решение диспетчера",
};
const PLAN_STATUS: Record<string, { text: string; cls: string }> = {
  feasible: { text: "проверен: конфликтов нет", cls: "badge-good" },
  delayed: { text: "проверен, но есть опоздания", cls: "badge-warning" },
  infeasible: { text: "не найден — поезда удержаны", cls: "badge-critical" },
};

function n1(v: number | null | undefined): string {
  return v == null ? "—" : num(v, v < 10 ? 1 : 0);
}

function Pair({ label, a, b, unit, better = "lower" }: { label: string; a: number | null | undefined; b: number | null | undefined; unit: string; better?: "lower" | "higher" }) {
  if (a == null) return null;
  const diff = b == null ? 0 : b - a;
  const worse = better === "lower" ? diff > 0.05 : diff < -0.05;
  return (
    <span className="impact-item" title="с решением → с альтернативой">
      <span className="muted">{label}</span> <b className="tabular">{n1(a)}</b>
      {b != null && <span className={`tabular ${worse ? "" : "muted"}`}> → {n1(b)}</span>} <span className="muted">{unit}</span>
    </span>
  );
}

function useAction() {
  const setError = useSim((s) => s.setError);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ message: string }>) => {
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
  return { busy, run };
}

function VariantRow({ v, card, left, chosen }: { v: Variant; card: DecisionCard; left: number | null | undefined; chosen: boolean }) {
  const { busy, run } = useAction();
  const can = card.can_choose && v.valid;
  return (
    <li className={`variant ${chosen ? "variant-chosen" : ""}`}>
      <div className="variant-title">
        {chosen && <span aria-hidden>✓ </span>}
        {v.title}
      </div>
      <div className="variant-meta muted tabular">
        цена {money(v.J)}
        {v.delta_money != null && v.delta_money > 0.5 && <> · дороже на {money(v.delta_money)}</>}
        {" · "}пассажирских сверх допуска: {v.late_pax}
        {v.pte_violations > 0 && <> · нарушений ПТЭ: {v.pte_violations}</>}
        {!v.valid && <> · недопустим: {v.note}</>}
      </div>
      {can && !chosen && (
        <button className="btn btn-small" disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            run(() => api.decision(card.id, "choose", v.id));
          }}>
          Выбрать{left != null ? ` · ${Math.ceil(left)} с` : ""}
        </button>
      )}
    </li>
  );
}

function Card({ c, left }: { c: DecisionCard; left: number | null | undefined }) {
  const selectTrain = useSim((s) => s.selectTrain);
  const selectStation = useSim((s) => s.selectStation);
  const { busy, run } = useAction();
  const lv = LEVEL[c.level] ?? LEVEL.B;
  const st = STATUS[c.status] ?? STATUS.applied;
  const dm = c.delta_money;
  const im = c.impact;
  return (
    <li
      id={`card-${c.id}`}
      className={`decision lvl-${c.level} st-${c.status}`}
      onClick={() => {
        if (c.trains[0]) selectTrain(c.trains[0]);
        if (c.station_id) selectStation(c.station_id);
      }}
    >
      <div className="decision-head">
        <span className={`badge ${lv.cls}`} title={lv.hint}>{lv.label}</span>
        <span className="decision-type">{TYPE[c.type] ?? c.type}</span>
        <span className={`badge ${st.cls}`}>{st.text}</span>
        <span className="spacer" />
        <span className="muted tabular" title="Когда принято и номер плана">{clock(c.t, false)} · план № {c.plan_version}</span>
      </div>
      <div className="decision-action">{c.action}</div>
      {c.type !== "incident" && <div className="decision-row"><span className="muted">Почему:</span> {c.reason}</div>}
      <div className="decision-row" hidden={c.type === "incident"}>
        <span className="muted">Альтернатива:</span> {c.alternative}
        {c.alt_feasible && dm != null && (
          <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
            {dm >= 0 ? `дороже на ${money(dm)}` : `дешевле на ${money(-dm)}`}
          </span>
        )}
        {(c.alt_pte_violations ?? 0) > 0 && <span className="badge badge-warning" style={{ marginLeft: 6 }}>нарушает ПТЭ</span>}
        {!c.alt_feasible && c.alt_reliable !== false && c.type !== "no_plan" && (
          <span className="badge badge-neutral" style={{ marginLeft: 6 }}>недопустима</span>
        )}
        {c.alt_reliable === false && (
          <span className="badge badge-neutral" style={{ marginLeft: 6 }}
            title="Быстрая модель оценки не воспроизводит этот план для пары поездов — цифры альтернативы были бы артефактом">
            цена не оценена
          </span>
        )}
      </div>
      {im && (
        <div className="impact" aria-label="Влияние решения: с решением → с альтернативой, прогноз на час">
          <Pair label="Задержка" a={im.delay_min_plan} b={im.delay_min_alt} unit="поездо-мин" />
          <Pair label="Энергия остановок" a={im.energy_kwh_plan} b={im.energy_kwh_alt} unit="кВт·ч" />
          <Pair label="Загрузка путей" a={im.track_load_pct_plan} b={im.track_load_pct_alt} unit="%" />
          <Pair label="Простой" a={im.idle_pct_plan} b={im.idle_pct_alt} unit="%" />
          {c.index_after != null && (
            <span className="impact-item" title="Прогноз индекса на час: с альтернативой → с решением">
              <span className="muted">Индекс через час</span>{" "}
              {c.index_before != null && <span className="tabular muted">{Math.round(c.index_before)} → </span>}
              <b className="tabular">{Math.round(c.index_after)}</b>
            </span>
          )}
        </div>
      )}
      {c.note && <div className="decision-row muted">{c.note}</div>}
      {c.type === "incident" && c.report && <IncidentReport report={c.report as never} />}
      {c.variants.length > 0 && (
        <ul className="variants" aria-label="Варианты решения">
          {c.variants.map((v) => (
            <VariantRow key={v.id} v={v} card={c} left={left} chosen={c.chosen_variant === v.id} />
          ))}
        </ul>
      )}
      <div className="decision-foot">
        {c.can_cancel && (
          <button className="btn btn-small" disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              run(() => api.decision(c.id, "cancel"));
            }}
            title="Вернуть прежний порядок поездов. Решение закрепится: следующий пересчёт его не перевернёт">
            ↶ Отменить{left != null ? ` · ${Math.ceil(left)} с` : ""}
          </button>
        )}
        {c.status === "pending" && left == null && <span className="muted">План не применён, пока вы не выберете вариант</span>}
        {c.outcome && <span className="muted">{c.outcome}</span>}
      </div>
    </li>
  );
}

export function DecisionsPanel() {
  const cards = useSim((s) => s.cards);
  const planner = useSim((s) => s.state?.planner);
  const setError = useSim((s) => s.setError);
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
  const left = useMemo(() => new Map((planner?.actions ?? []).map((a) => [a.card_id, a.left_s])), [planner?.actions]);
  const shown = useMemo(() => {
    const recent = cards.slice(-40).reverse();
    const urgent = recent.filter((c) => c.status === "pending");
    return urgent.concat(recent.filter((c) => c.status !== "pending"));
  }, [cards]);
  const alarms = useAlarms();
  useMoney();
  const st0 = planner?.status ? PLAN_STATUS[planner.status] : null;
  const st = st0 && planner?.status === "infeasible" && !alarms.red.has("plan") ? { ...st0, cls: "badge-serious" } : st0;
  const fullAuto = planner?.full_auto ?? true;

  return (
    <section className="card decisions-card" aria-label="Решения Бағдара">
      <div className="card-head">
        <span className="card-title">Решения Бағдара</span>
        <span className="card-sub">{cards.length ? `${cards.length} за прогон · ` : ""}что он поменял в плане и почему; решение остаётся за вами</span>
        <span className="spacer" />
        <label className="switch" title="Включено: Бағдар сам применяет лучший вариант. Выключите — решения уровня C будут ждать вашего выбора">
          <input type="checkbox" checked={fullAuto} disabled={!planner}
            onChange={(e) => api.autonomy(e.target.checked).catch((err) => setError(String(err.message ?? err)))} />
          Полный авто
        </label>
      </div>
      <div className="card-body">
        {planner && planner.version > 0 ? (
          <div className="planner-box">
            <div className="status-line" style={{ margin: 0 }}>
              <b>План № {planner.applied_version}</b>
              {st && <span className={`badge ${st.cls}`}>{st.text}</span>}
              {planner.busy && <span className="badge badge-accent">пересчёт…</span>}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Составлен за {planner.compute_ms != null ? `${(planner.compute_ms / 1000).toFixed(1).replace(".", ",")} с` : "—"}
              {" · "}{SOLVER[planner.solver ?? ""] ?? planner.solver}
              {planner.J != null && <> · цена плана {money(planner.J)}</>}
              {compare?.bestHeur != null && compare.cp != null && compare.bestHeur > 0 && compare.bestHeur > compare.cp * 1.01 && (
                <> — на {Math.max(1, Math.round((1 - compare.cp / compare.bestHeur) * 100))} % дешевле простого перебора</>
              )}
              {planner.overrides > 0 && <> · ваших решений в силе: {planner.overrides}</>}
            </div>
            {planner.awaiting_choice && (
              <div className="wait" style={{ margin: "4px 0 0" }}>
                План № {planner.version} ждёт вашего выбора. Пока действует план № {planner.applied_version}, прогнозные конфликты
                остаются на схеме и графике.
              </div>
            )}
            {planner.reason && <div className="muted" style={{ fontSize: 12 }}>Причина пересчёта: {planner.reason}</div>}
          </div>
        ) : (
          <div className="empty">Планировщик готовит первый план…</div>
        )}
        {shown.length === 0 ? (
          <div className="empty">Пока менять нечего: исходный график без конфликтов. Задержите поезд (нажмите на него) или устройте сбой в карточке «Сбои» — здесь появятся карточки: что Бағдар решил и почему.</div>
        ) : (
          <ul className="decisions">{shown.map((c) => <Card key={c.id} c={c} left={left.get(c.id)} />)}</ul>
        )}
        <div className="muted small" style={{ marginTop: 8 }}>
          Уровни: <b>A</b> — мелочь, сделано само · <b>B</b> — сделано, 30 с на отмену · <b>C</b> — ждёт вашего выбора. Суммы — по условным тарифам (⚙ Настройки).
        </div>
      </div>
    </section>
  );
}
