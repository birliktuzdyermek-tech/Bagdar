// Сводка прогона: одно место, где видно, как участок работает в целом — индекс, движение,
// деньги по тарифам, работа планировщика, сбои. Данные — GET /api/dashboard, обновляются сами.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Dashboard } from "../api/types";
import { useEChart } from "../lib/echarts";
import { clock, hhmm, num } from "../lib/format";
import { go } from "../lib/route";
import { useTokens } from "../lib/theme";
import { money, rate, useMoney } from "../store/money";
import { useSim } from "../store/sim";

const CO2_KG_PER_KWH = 0.62;   // средний коэффициент выбросов энергосистемы, условно

const MONEY_ROWS: { key: string; label: string; what: string; color: string }[] = [
  { key: "delay_pax", label: "Опоздания пассажирских", what: "минуты задержки × тариф минуты пассажирского", color: "#4b8fe8" },
  { key: "delay_freight", label: "Опоздания грузовых", what: "минуты задержки × тариф минуты грузового", color: "#c9a227" },
  { key: "energy", label: "Энергия на лишние остановки", what: "кВт·ч на торможение и разгон × тариф кВт·ч", color: "#ec835a" },
  { key: "idle", label: "Простой локомотивов и бригад", what: "часы стоянки сверх графика × (тариф локомотива + бригады)", color: "#9a6fd0" },
];
const TYPE_LABEL: Record<string, string> = {
  crossing: "скрещения", overtake: "обгоны", track: "выбор пути", hold: "удержания", no_plan: "план не найден", incident: "сбои",
};
const CLS_LABEL: Record<string, string> = {
  high_speed_passenger: "скоростной", fast_passenger: "скорый", passenger: "пассажирский", express_freight: "ускоренный грузовой",
  freight: "грузовой", local_freight: "сборный", light_engine: "резервный локомотив", extraordinary: "внеочередной",
};

function Kpi({ label, value, sub, tone, hint }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad"; hint?: string }) {
  return (
    <div className={`dash-kpi ${tone ?? ""}`} title={hint}>
      <span className="dash-kpi-label">{label}</span>
      <span className="dash-kpi-value tabular">{value}</span>
      {sub && <span className="dash-kpi-sub">{sub}</span>}
    </div>
  );
}

function IndexChart({ d }: { d: Dashboard }) {
  const tokens = useTokens();
  const { ref, chart } = useEChart();
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const pts = d.index.history;
    const band = (a: number, b: number, color: string) => [{ yAxis: a, itemStyle: { color, opacity: 0.08 } }, { yAxis: b }];
    c.setOption({
      animation: false,
      grid: { left: 34, right: 12, top: 10, bottom: 24 },
      tooltip: { trigger: "axis", backgroundColor: tokens["--surface-3"], borderColor: tokens["--border-strong"],
        textStyle: { color: tokens["--text-primary"], fontSize: 12 },
        formatter: (ps: { value: number[] }[]) => (ps[0] ? `<b>${Math.round(ps[0].value[1])}</b> · ${clock(ps[0].value[0], false)}` : "") },
      xAxis: { type: "value", min: pts.length ? pts[0][0] : d.run.start_t, max: Math.max(d.run.t, pts.length ? pts[pts.length - 1][0] : d.run.t),
        axisLabel: { formatter: (v: number) => clock(v, false), color: tokens["--text-muted"], fontSize: 11 },
        axisLine: { lineStyle: { color: tokens["--border-strong"] } }, splitLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: "value", min: 0, max: 100, interval: 25, axisLabel: { color: tokens["--text-muted"], fontSize: 11 },
        splitLine: { lineStyle: { color: tokens["--border"], opacity: 0.6 } } },
      series: [{ type: "line", data: pts, symbol: "none", smooth: 0.2, lineStyle: { width: 2.5, color: tokens["--accent"] },
        areaStyle: { color: tokens["--accent"], opacity: 0.1 },
        markArea: { silent: true, data: [band(75, 100, tokens["--good"]), band(50, 75, tokens["--warning"]), band(0, 50, tokens["--critical"])] } }],
    }, { replaceMerge: ["series"] });
  }, [chart, d, tokens]);
  return <div className="dash-chart" ref={ref} role="img" aria-label="Индекс участка во времени" />;
}

function MoneyBars({ d }: { d: Dashboard }) {
  const total = Math.max(1e-9, d.money.total);
  return (
    <div className="dash-money">
      {MONEY_ROWS.map((r) => {
        const v = d.money.by[r.key] ?? 0;
        return (
          <div key={r.key} className="dash-money-row" title={r.what}>
            <span className="dash-money-label">{r.label}</span>
            <span className="dash-money-bar"><span style={{ width: `${Math.round((100 * v) / total)}%`, background: r.color }} /></span>
            <span className="dash-money-val tabular">{money(v)}</span>
            <span className="dash-money-what">{r.what}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DashboardPage() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const selectTrain = useSim((s) => s.selectTrain);
  useMoney();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let off = false;
    const poll = async () => {
      try {
        const r = await api.dashboard();
        if (!off) { setD(r); setErr(null); }
      } catch (e) {
        if (!off) setErr(e instanceof Error ? e.message : String(e));
      }
      if (!off) timer.current = window.setTimeout(poll, 2000);
    };
    poll();
    return () => { off = true; window.clearTimeout(timer.current); };
  }, []);

  if (err && !d) return <div className="page"><p className="error">Сводка недоступна: {err}</p></div>;
  if (!d) return <div className="page"><p className="muted">Собираю сводку…</p></div>;

  const t = d.traffic;
  const onTime = t.on_time_share == null ? "—" : `${Math.round(t.on_time_share * 100)} %`;
  const idxTone = d.index.value == null ? undefined : d.index.value >= 75 ? "good" : d.index.value >= 50 ? "warn" : "bad";
  const levels = d.planner.levels;
  const perHour = Object.values(d.money.per_hour).reduce((a, b) => a + b, 0);
  const lossTone = d.money.total <= 0.5 ? "good" : undefined;
  const tar = d.money.tariffs;

  return (
    <div className="page dash">
      <header className="page-head dash-head">
        <div>
          <h1>Сводка прогона</h1>
          <p className="lead">
            Как участок отработал с начала прогона: <b>{d.run.scenario}</b>, участок № {d.run.seed}, {clock(d.run.start_t, false)}–{clock(d.run.t, false)} модели
            ({num(d.run.hours, 1)} ч), поездов в графике {d.run.trains_total}. Обновляется каждые 2 секунды.
          </p>
        </div>
        <div className="dash-actions">
          <a className="btn btn-primary" href="/api/export/report.pdf" target="_blank" rel="noreferrer" title="Отчёт за весь прогон: показатели, график индекса, сбои, изменения плана, вывод">📄 Отчёт PDF</a>
          <a className="btn" href="/api/export/events.csv" download title="Все события прогона таблицей">⬇ CSV события</a>
          <a className="btn" href="/api/export/plan.csv" download title="Действующий план по каждому поезду">⬇ CSV план</a>
          <button className="btn" onClick={() => go("review")} title="Хронология с перемоткой к любому событию">Разбор →</button>
        </div>
      </header>

      <div className="dash-kpis">
        <Kpi label="Индекс участка" value={d.index.value == null ? "—" : String(Math.round(d.index.value))}
          sub={d.index.value == null ? "нет данных" : `${d.index.status_label ?? ""} · минимум ${d.index.min == null ? "—" : Math.round(d.index.min)} · средний ${d.index.avg == null ? "—" : Math.round(d.index.avg)}`}
          tone={idxTone} hint="0–100: насколько хорошо работает участок. 100 — всё по графику" />
        <Kpi label="Поездов вовремя" value={onTime} sub={`${t.active ?? 0} на участке · ${t.finished} прошли · задерживаются ${t.late_trains}`}
          tone={t.on_time_share != null && t.on_time_share >= 0.9 ? "good" : t.on_time_share != null && t.on_time_share < 0.7 ? "bad" : undefined}
          hint="Доля поездов на участке, которые идут в пределах допуска своего класса" />
        <Kpi label="Задержка" value={`${num(t.delay_pax_min + t.delay_freight_min)} мин`}
          sub={`пассажирские ${num(t.delay_pax_min)} · грузовые ${num(t.delay_freight_min)} · в среднем ${num(t.avg_delay_min, 1)} мин на поезд`}
          hint="Сумма опозданий всех поездов, поездо-минуты" />
        <Kpi label="Потери по тарифам" value={money(d.money.total)} sub={`≈ ${money(perHour)} в час модели`} tone={lossTone}
          hint="Опоздания, лишние остановки и простой, переведённые в деньги по тарифам из настроек. Условные цифры" />
        <Kpi label="Лишние остановки" value={String(t.unplanned_stops)} sub={`${num(t.energy_kwh)} кВт·ч потеряно ≈ ${num(t.energy_kwh * CO2_KG_PER_KWH)} кг CO₂ · простой ${num(t.idle_h, 1)} ч`}
          hint="Остановки, которых не было в графике: каждая — потерянная энергия на торможение и разгон. CO₂ — по среднему коэффициенту сети 0,62 кг/кВт·ч, условно" />
        <Kpi label="План пересчитан" value={`${d.planner.plans} раз`}
          sub={d.planner.replan_avg_s != null ? `в среднем за ${num(d.planner.replan_avg_s, 1)} с, максимум ${num(d.planner.replan_max_s ?? 0, 1)} с` : "ещё не пересчитывался"}
          hint="Каждый пересчёт — новый план для всех поездов на 3 часа вперёд, проверенный на конфликты" />
        <Kpi label="Решений Бағдара" value={String(d.planner.cards)} sub={`A ${levels.A ?? 0} · B ${levels.B ?? 0} · C ${levels.C ?? 0}${d.planner.overrides ? ` · ваших ${d.planner.overrides}` : ""}`}
          hint="A — мелочь, сделано само; B — сделано, можно отменить; C — с вариантами на выбор" />
        <Kpi label="Стоят намертво" value={String(t.frozen)} sub={t.frozen ? t.frozen_numbers.join(", ") : "никто не стоит больше часа"}
          tone={t.frozen ? "bad" : "good"} hint="Поезда, которые не сдвинулись больше часа — признак «замка»" />
      </div>

      <div className="dash-grid">
        <section className="card">
          <div className="card-head"><span className="card-title">Индекс участка во времени</span>
            <span className="card-sub">зелёная зона — норма (от 75), жёлтая — внимание, красная — плохо</span></div>
          <div className="card-body"><IndexChart d={d} /></div>
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Из чего складываются потери</span>
            <span className="card-sub">всего {money(d.money.total)} · тарифы условные, меняются в ⚙ Настройках</span></div>
          <div className="card-body">
            <MoneyBars d={d} />
            <div className="dash-tariffs small muted">
              Тарифы: минута пассажирского {rate(tar.delay_min_pax, "мин")}, грузового {rate(tar.delay_min_freight, "мин")}, {rate(tar.kwh, "кВт·ч")},
              простой локомотива {rate(tar.loco_hour, "ч")}, бригады {rate(tar.crew_hour, "ч")}.
              {d.money.currency === "₸" && <> Курс показа: 1 у.е. модели = {num(d.money.per_unit)} ₸.</>}
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Сбои за прогон</span>
            <span className="card-sub">{d.incidents.length ? `${d.incidents.length} · по каждому план перестроен автоматически` : "сбоев не было"}</span></div>
          <div className="card-body">
            {d.incidents.length === 0 ? <div className="empty">Устройте сбой в карточке «Сбои» на экране диспетчера или запустите сценарий.</div> : (
              <table className="dash-table">
                <thead><tr><th>Когда</th><th>Что</th><th>Задето</th><th>График восстановится</th><th>Статус</th></tr></thead>
                <tbody>
                  {d.incidents.slice().reverse().map((i, k) => (
                    <tr key={k}>
                      <td className="tabular">{hhmm(i.t)}</td>
                      <td><span className={`badge ${i.level === "C" ? "badge-warning" : "badge-neutral"}`}>{i.level}</span> {i.title}</td>
                      <td className="tabular">{i.affected ?? "—"} п.</td>
                      <td className="tabular">{i.recovery_at != null ? hhmm(i.recovery_at) : "—"}</td>
                      <td>{i.status === "active" ? "действует" : i.status === "resolved" ? "снят" : "завершён"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Кто опаздывает больше всех</span>
            <span className="card-sub">сейчас на участке · нажмите, чтобы открыть поезд</span></div>
          <div className="card-body">
            {d.top_delayed.length === 0 ? <div className="empty">Все поезда идут по графику.</div> : (
              <table className="dash-table">
                <thead><tr><th>Поезд</th><th>Класс</th><th>Опоздание</th><th>Пассажиров</th></tr></thead>
                <tbody>
                  {d.top_delayed.map((x) => (
                    <tr key={x.id} className="clickable" onClick={() => { selectTrain(x.id); go("dispatcher"); }}>
                      <td><b>№ {x.number}</b></td><td>{CLS_LABEL[x.cls] ?? x.cls}</td>
                      <td className="tabular">+{num(x.delay_min)} мин</td><td className="tabular">{x.passengers ? num(x.passengers) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {Object.keys(d.planner.by_type).length > 0 && (
              <p className="small muted" style={{ marginTop: 10 }}>
                Решения по типам: {Object.entries(d.planner.by_type).map(([k, v]) => `${TYPE_LABEL[k] ?? k} ${v}`).join(" · ")}
                {d.planner.cpsat_share != null && <> · точный решатель CP-SAT выбран в {Math.round(d.planner.cpsat_share * 100)} % пересчётов</>}
              </p>
            )}
          </div>
        </section>
        {d.versus && (
          <section className="card dash-versus">
            <div className="card-head"><span className="card-title">Человек против Бағдара — идёт соревнование</span>
              <span className="card-sub">тот же поток поездов без Бағдара и с ним</span></div>
            <div className="card-body dash-versus-body">
              <div><span className="muted">Без Бағдара</span><b className="tabular">{money(d.versus.left_total)}</b></div>
              <div><span className="muted">С Бағдаром</span><b className="tabular">{money(d.versus.right_total)}</b></div>
              <div><span className="muted">Разница</span><b className="tabular good">{money(d.versus.left_total - d.versus.right_total, { sign: true })}</b></div>
              <button className="btn btn-small" onClick={() => go("versus")}>Открыть →</button>
            </div>
          </section>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Все суммы — условные: модель умножает минуты, кВт·ч и часы на тарифы из настроек, реальных расценок перевозчика здесь нет.
        Консультативный прототип, сигналами и стрелками не управляет.
      </p>
    </div>
  );
}
