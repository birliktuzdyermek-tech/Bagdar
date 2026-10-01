import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clock, num } from "../lib/format";
import { reducedMotionNow, useCountUp } from "../lib/motion";
import { drawGraph } from "../player/graph";
import { drawScheme } from "../player/scheme";
import { loadReplay } from "../replay/load";
import { ReplayModel } from "../replay/model";
import type { DecisionCard, IncidentSummary, RunInfo } from "../replay/types";
import { MeetScene } from "../meet/MeetScene";
import { withDefaults } from "../meet/model";
import { useMeet } from "../meet/useMeet";
import { money as fmtMoney, perMin } from "../lib/money";
import { BgReplay } from "./BgReplay";
import { IntroVideo } from "./IntroVideo";
import "./presentation.css";

const TITLES = [
  "Проблема", "Что такое Бағдар", "Кто поедет первым?", "Живой участок", "Сбой — и новый план за секунды", "Почему именно так",
  "С Бағдаром и без", "Приоритеты", "Индекс участка", "Архитектура", "Масштаб", "Экономика", "Чего не ждали", "Ограничения и развитие",
] as const;

// насыщенные слайды: заголовок меньше, колонки прижаты кверху, чтобы всё влезло в 16:9
const COMPACT = new Set([2, 4, 5, 6, 8, 11, 12]);

const NOTES = [
  "Это количество возможных пар поездов, а не число конфликтов: n·(n−1)/2. Каждая пара может встретиться на одном пути. Фон — настоящая запись прогона.",
  "Бағдар как навигатор: видит весь участок, строит план без конфликтов, объясняет каждое решение и советует машинистам скорость. Сигналами и поездами не управляет.",
  "Основа всего проекта в одной сцене. Путь один, навстречу пассажирский и грузовой. Сверху — пропускаем пассажирский, снизу — грузовой. Счётчики показывают, во что обходится каждая минута ожидания: время людей, энергия на остановку тяжёлого состава, простой бригады. Бағдар выбирает дешёвый вариант, но сначала проверяет ПТЭ. На странице «Кто первым?» можно поменять условия и угадать самому.",
  "Это кадры настоящего прогона Ядра. Пунктир на графике — план Бағдара, сплошная — как поезда ехали на самом деле. Индекс — из тех же кадров.",
  "В 06:30 по сценарию закрыт перегон. Таблица — из отчёта «до / после», который Ядро строит само: план Бағдара, «ничего не менять» и «кто первый пришёл».",
  "Настоящая карточка из записи: что сделано, почему, какая была альтернатива и на сколько она дороже. Цены — условные единицы.",
  "Один и тот же поток поездов и одно событие, две записи. Слева — без плана, поезда занимают пути «кто первый пришёл». Справа — Бағдар. Цифры внизу — итог четырёх часов модели по одинаковым правилам.",
  "Четыре слоя сверху вниз: нижний слой никогда не отменяет верхний. Порядок классов — настраиваемое допущение модели.",
  "Формула и веса — из конфига Ядра, меняются на лету в симуляторе. Кривая — индекс из кадров записи закрытия перегона: видно, как он проседает и восстанавливается.",
  "Ядро — FastAPI: симулятор, планировщик CP-SAT с запасной эвристикой, независимый валидатор, индекс, журнал SQLite. Экран диспетчера получает поток по WebSocket. Витрина читает записи прогонов.",
  "Каждая зона из 20 станций планируется своим диспетчером, зоны — параллельно. Замер — scripts/bench_scale.py, таблица в docs/BENCHMARK_SCALE.md.",
  "Достык — Мойынты: проектная оценка второго пути — с 12 до 60 пар. Пересчёт по тарифу — разница двух записей «Замка» в нашей модели, не обещание реальной экономии.",
  "Четыре настоящие задачи диспетчера, которых от хакатонного прототипа не ждут: подбор времени окна с ценой каждого варианта, контроль рабочего времени бригад по плану, предсказание замка в плане-кандидате, радар насыщения с вариантами придержания. Всё это — в симуляторе, покажем живьём: окно на ремонт.",
  "Консультативный прототип с синтетическим движением. QR открывает симулятор: можно самому закрыть перегон и посмотреть, как Бағдар перестроит план.",
] as const;

function useReplay(run: RunInfo | null): ReplayModel | null {
  const [model, setModel] = useState<ReplayModel | null>(null);
  useEffect(() => {
    if (!run) return;
    let alive = true;
    setModel(null);
    loadReplay(run.file).then((r) => { if (alive) setModel(new ReplayModel(r)); }, () => {});
    return () => { alive = false; };
  }, [run]);
  return model;
}

function PairNumbers() {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const n20 = useCountUp(go ? 190 : 0, 1400);
  const n100 = useCountUp(go ? 4950 : 0, 1400);
  const n1000 = useCountUp(go ? 499500 : 0, 1400);
  return <div className="pres-pairs" aria-label="Количество возможных пар поездов">
    <div><strong>{num(Math.round(n20))}</strong><span>пар при 20 поездах</span></div>
    <div><strong>{num(Math.round(n100))}</strong><span>пар при 100 поездах</span></div>
    <div><strong>{num(Math.round(n1000))}</strong><span>пар при 1 000 поездах</span></div>
  </div>;
}

/** Канвас с подгонкой под размер и devicePixelRatio. */
function useCanvases(n: number) {
  const refs = useRef<(HTMLCanvasElement | null)[]>(Array(n).fill(null));
  const dims = useRef(new Map<HTMLCanvasElement, { w: number; h: number }>());
  useEffect(() => {
    const cvs = refs.current.filter((x): x is HTMLCanvasElement => !!x);
    const resize = () => {
      for (const cv of cvs) {
        const rect = cv.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
        cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
        dims.current.set(cv, { w: rect.width, h: rect.height });
      }
    };
    const ro = new ResizeObserver(resize);
    cvs.forEach((cv) => ro.observe(cv));
    resize();
    return () => ro.disconnect();
  });
  return { refs, dims };
}

/** Схема и график из кадров записи; focusT — с какого момента крутить (по кругу). */
function ReplayStage({ model, run, focusT, speed = 60, graph = true }: {
  model: ReplayModel | null; run: RunInfo | null; focusT?: number | null; speed?: number; graph?: boolean;
}) {
  const { refs, dims } = useCanvases(2);
  const [t, setT] = useState<number | null>(null);
  useEffect(() => {
    if (!model) return;
    const begin = focusT != null ? Math.max(model.start, focusT - 120) : model.start + 1800;
    let cur = begin;
    let last = 0;
    let lastUi = 0;
    let raf = 0;
    const render = (now: number) => {
      const reduced = reducedMotionNow();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!reduced) {
        cur += dt * speed;
        if (cur >= model.end) cur = begin;
      }
      const projector = document.documentElement.classList.contains("projector");
      const frame = model.frameAt(cur).frame;
      const [sc, gc] = refs.current;
      const sd = sc && dims.current.get(sc);
      if (sc && sd?.w) drawScheme(sc.getContext("2d")!, sd.w, sd.h, model, model.trainsAt(cur, !reduced), frame,
        { projector, selected: null, hover: null, flashes: [], now });
      const gd = gc && dims.current.get(gc);
      if (gc && gd?.w) drawGraph(gc.getContext("2d")!, gd.w, gd.h, model, cur,
        { projector, selected: null, before: 1800, after: 1800, morph: null, now, reduced });
      if (now - lastUi > 250) { lastUi = now; setT(cur); }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [model, focusT, speed]);

  if (!run) return <p className="pres-empty">Записи пока нет.</p>;
  if (!model) return <p className="pres-empty" role="status">Загружается запись «{run.title}»…</p>;
  const fr = model.frameAt(t ?? model.start).frame;
  const plan = model.planAt(t ?? model.start);
  return <div className="pres-replay">
    <div className="pres-replay-head">
      <span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Запись прогона</span>
      <strong>{run.title}</strong>
      <span className="pres-time">{clock(t ?? model.start)} · ×{speed}</span>
    </div>
    <canvas ref={(el) => { refs.current[0] = el; }} className="pres-scheme" role="img" aria-label="Схема участка из кадров записи" />
    {graph && <canvas ref={(el) => { refs.current[1] = el; }} className="pres-graph" role="img" aria-label="График движения из плана и кадров записи" />}
    <div className="pres-replay-foot">
      <span>Поездов: <b>{fr.state.metrics.active_trains}</b></span>
      <span>Ср. задержка: <b>{num(fr.state.metrics.avg_delay_s / 60, 1)} мин</b></span>
      <span>Индекс: <b>{fr.index ? Math.round(fr.index.value) : "—"}</b></span>
      <span>План: <b>{plan ? `v${plan.plan.version}` : "—"}</b></span>
    </div>
  </div>;
}

/** Две записи одного потока рядом, на общих часах: без плана и с Бағдаром. */
function PairStage({ a, b, runA, runB }: { a: ReplayModel | null; b: ReplayModel | null; runA: RunInfo | null; runB: RunInfo | null }) {
  const { refs, dims } = useCanvases(2);
  const [t, setT] = useState<number | null>(null);
  useEffect(() => {
    if (!a || !b) return;
    const begin = Math.max(a.start, b.start);
    const end = Math.min(a.end, b.end);
    let cur = begin;
    let last = 0;
    let lastUi = 0;
    let raf = 0;
    const render = (now: number) => {
      const reduced = reducedMotionNow();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!reduced) {
        cur += dt * 150;                       // 4 часа модели — примерно за полторы минуты
        if (cur >= end) cur = begin;
      } else cur = end;
      const projector = document.documentElement.classList.contains("projector");
      [a, b].forEach((m, i) => {
        const cv = refs.current[i];
        const d = cv && dims.current.get(cv);
        if (cv && d?.w) drawScheme(cv.getContext("2d")!, d.w, d.h, m, m.trainsAt(cur, !reduced), m.frameAt(cur).frame,
          { projector, selected: null, hover: null, flashes: [], now });
      });
      if (now - lastUi > 250) { lastUi = now; setT(cur); }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [a, b]);
  if (!runA || !runB) return <p className="pres-empty">Парных записей пока нет.</p>;
  if (!a || !b) return <p className="pres-empty" role="status">Загружаются две записи…</p>;
  const side = (m: ReplayModel) => {
    const fr = m.frameAt(t ?? m.start).frame;
    return { wait: fr.state.metrics.waiting_trains, delay: fr.state.metrics.avg_delay_s / 60, index: fr.index?.value };
  };
  const sa = side(a);
  const sb = side(b);
  return <div className="pres-pair">
    <div className="pres-pair-clock"><span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Две записи одного потока</span>
      <span className="pres-time">{clock(t ?? a.start, false)} · ×150</span></div>
    {([[a, sa, "Без Бағдара — «кто первый пришёл»", "pair-bad"], [b, sb, "С Бағдаром", "pair-good"]] as const).map(([, s, label, cls], i) => (
      <div key={label} className={`pres-pair-side ${cls}`}>
        <div className="pres-pair-head"><b>{label}</b>
          <span>ждут: <b>{s.wait}</b> · ср. задержка <b>{num(s.delay, 1)} мин</b> · индекс <b>{s.index != null ? Math.round(s.index) : "—"}</b></span></div>
        <canvas ref={(el) => { refs.current[i] = el; }} className="pres-scheme pres-scheme-pair" role="img" aria-label={`Схема: ${label}`} />
      </div>
    ))}
  </div>;
}

function PairTotals({ a, b }: { a: ReplayModel | null; b: ReplayModel | null }) {
  const A = a?.r.summary;
  const B = b?.r.summary;
  if (!A || !B) return null;
  const rows: [string, number, number, string, "less" | "more"][] = [
    ["Стоят на месте больше часа", A.frozen, B.frozen, "п.", "less"],
    ["Задержка поездов", A.delay_min, B.delay_min, "поездо-мин", "less"],
    ["Простой сверх графика", A.idle_h, B.idle_h, "поездо-ч", "less"],
    ["Проследований станций", A.passages, B.passages, "", "more"],
    ["Потери по тарифам", A.money_total, B.money_total, "money", "less"],
  ];
  return <table className="pres-totals"><thead><tr><th>Итог 4 часов модели</th><th className="pair-bad">Без Бағдара</th><th className="pair-good">С Бағдаром</th></tr></thead>
    <tbody>{rows.map(([label, x, y, unit, better]) => {
      const win = x === y ? "" : (better === "less" ? y < x : y > x) ? "b" : "a";
      const f = (v: number) => (unit === "money" ? fmtMoney(v) : `${num(v, v < 100 && v % 1 ? 1 : 0)} ${unit}`);
      return <tr key={label}><th>{label}</th><td className={win === "a" ? "win" : ""}>{f(x)}</td>
        <td className={win === "b" ? "win" : ""}>{f(y)}</td></tr>;
    })}</tbody></table>;
}

function pickCard(models: (ReplayModel | null)[]): DecisionCard | null {
  for (const m of models) {
    const c = (m?.r.cards ?? []).filter((x) => x.type !== "incident" && x.type !== "no_plan" && (x.delta_money ?? 0) > 50 && x.reason);
    if (c.length) return c.sort((p, q) => (q.delta_money ?? 0) - (p.delta_money ?? 0))[0];
  }
  return null;
}

function CardView({ card }: { card: DecisionCard | null }) {
  if (!card) return <p className="pres-empty">В записях нет карточки с ценой альтернативы.</p>;
  // первые два предложения: точка, пробел и заглавная буква (не рвём «у.е.» и «ст.»)
  const reason = card.reason.split(/(?<=\.)\s+(?=[А-ЯЁA-Z«])/).slice(0, 2).join(" ");
  return <div className="pres-dcard">
    <div className="pres-dcard-top"><span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Карточка из записи</span>
      <span className="pres-dcard-lvl">уровень {card.level} · {clock(card.t, false)}</span></div>
    <div className="pres-dcard-row"><span>Что сделано</span><b>{card.action}</b></div>
    <div className="pres-dcard-row"><span>Почему</span><p>{reason}</p></div>
    <div className="pres-dcard-row"><span>Альтернатива</span><p>{card.alternative}</p></div>
    {card.delta_money != null && <div className="pres-dcard-price">Альтернатива дороже на <b>{fmtMoney(card.delta_money)}</b></div>}
  </div>;
}

function IncidentView({ model }: { model: ReplayModel | null }) {
  const inc = model?.r.incidents?.[0];
  const card = model?.r.cards?.find((c) => c.type === "incident");
  if (!model) return <p className="pres-empty" role="status">Загружается запись…</p>;
  if (!inc?.after) return <p className="pres-empty">В записи нет сбоя.</p>;
  const P = inc.after.plan;
  const cols: [string, IncidentSummary | null | undefined, string][] = [
    ["Бағдар", P, "good"], ["Ничего не менять", inc.after.no_change, ""], ["«Кто первый пришёл»", inc.after.fifo, "bad"],
  ];
  const ms = model.r.plans.find((p) => p.t >= inc.t)?.plan.compute_ms;
  return <div className="pres-incident">
    <dl className="pres-stats">
      <dt>Что случилось</dt><dd>{clock(inc.t, false)} · {inc.title}</dd>
      <dt>Новый план</dt><dd>{ms != null ? `${num(ms / 1000, 1)} с` : "—"} на расчёт и проверку</dd>
      <dt>Задето поездов</dt><dd>{P.affected}</dd>
      <dt>График восстановится</dt><dd>{P.recovery_at ? clock(P.recovery_at, false) : "за горизонтом 3 ч"}</dd>
    </dl>
    <table className="pres-totals pres-totals-sm"><thead><tr><th>План после сбоя</th>{cols.map(([n, , c]) => <th key={n} className={c ? `pair-${c}` : ""}>{n}</th>)}</tr></thead>
      <tbody>
        <tr><th>Задето волной</th>{cols.map(([n, s]) => <td key={n}>{s ? `${s.affected} п.` : "—"}</td>)}</tr>
        <tr><th>Нарушений ПТЭ</th>{cols.map(([n, s]) => <td key={n}>{s ? s.pte : "—"}</td>)}</tr>
        <tr><th>Цена плана</th>{cols.map(([n, s]) => <td key={n} className={n === "Бағдар" ? "win" : ""}>{s?.J_lex != null ? fmtMoney(s.J_lex) : "—"}</td>)}</tr>
      </tbody></table>
    {card && <p className="pres-small">{card.action}</p>}
  </div>;
}

function IndexSpark({ model }: { model: ReplayModel | null }) {
  const pts = useMemo(() => (model?.r.frames ?? []).filter((f, i) => f.index && i % 3 === 0).map((f) => [f.t, f.index!.value] as const), [model]);
  if (pts.length < 2) return <p className="pres-empty">Индекс загружается…</p>;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const W = 640, H = 200;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - (v / 100) * H;
  const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const inc = model?.r.incidents?.[0];
  return <figure className="pres-spark">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Индекс по кадрам записи">
      <rect x="0" y={y(100)} width={W} height={y(75) - y(100)} className="band-ok" />
      <rect x="0" y={y(75)} width={W} height={y(50) - y(75)} className="band-warn" />
      <rect x="0" y={y(50)} width={W} height={H - y(50)} className="band-crit" />
      {inc && <line x1={x(inc.t)} x2={x(inc.t)} y1="0" y2={H} className="spark-mark" />}
      <path d={d} className="spark-line" />
    </svg>
    <figcaption>Индекс из кадров записи «{model?.r.scenario.title}» {inc ? `· линия — ${clock(inc.t, false)}, ${inc.title.toLowerCase()}` : ""}</figcaption>
  </figure>;
}

const FACTORS = [
  ["Пропускная способность", 30], ["Отклонение от графика", 25], ["Загрузка путей", 20],
  ["Простой ресурсов", 15], ["Конфликты маршрутов", 10],
] as const;

function WeightEditor() {
  const [weights, setWeights] = useState<number[]>(FACTORS.map((f) => f[1]));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return <div className="pres-weight-box">
    {FACTORS.map(([label], i) => <label className="pres-weight" key={label}>
      <span>{label}</span>
      <input type="range" min="0" max="50" step="1" value={weights[i]}
        onChange={(e) => setWeights((w) => w.map((x, j) => j === i ? Number(e.target.value) : x))} />
      <strong>{Math.round((weights[i] / sum) * 100)} %</strong>
    </label>)}
    <p className="pres-small">Веса приводятся к 100 %. В симуляторе меняются на лету: ⚙ Настройки.</p>
  </div>;
}

function TariffEconomy({ a, b }: { a: ReplayModel | null; b: ReplayModel | null }) {
  const [delay, setDelay] = useState("5000");
  const [hour, setHour] = useState("45000");
  const A = a?.r.summary;
  const B = b?.r.summary;
  if (!A || !B) return <p className="pres-empty">Парные записи загружаются…</p>;
  const dDelay = A.delay_min - B.delay_min;
  const dIdle = A.idle_h - B.idle_h;
  const r1 = Number(delay), r2 = Number(hour);
  const ok = Number.isFinite(r1) && Number.isFinite(r2) && r1 >= 0 && r2 >= 0;
  const total = ok ? dDelay * r1 + dIdle * r2 : null;
  return <div className="pres-tariff">
    <p className="pres-small">Разница двух записей «Замка» (4 ч модели): задержка {num(dDelay, 0)} поездо-мин, простой {num(dIdle, 1)} поездо-ч.</p>
    <label>Минута задержки поезда, ₸ <input type="number" min="0" step="500" value={delay} onChange={(e) => setDelay(e.target.value)} /></label>
    <label>Час простоя локомотива и бригады, ₸ <input type="number" min="0" step="1000" value={hour} onChange={(e) => setHour(e.target.value)} /></label>
    <strong>{total != null ? `${total >= 0 ? "Бағдар экономит" : "Бағдар дороже на"} ${num(Math.abs(total))} ₸ за 4 часа` : "Введите неотрицательные тарифы"}</strong>
    <span>В нашей модели, на одном сценарии. Не обещание реальной экономии.</span>
  </div>;
}

function recordLink(run: RunInfo | null, label = "Открыть полную запись") {
  return run ? <a className="btn btn-primary pres-link" href={`#/play/${run.id}`}>{label} ↗</a> : null;
}

interface Models {
  normal: RunInfo | null; closure: RunInfo | null; lockA: RunInfo | null; lockB: RunInfo | null;
  mNormal: ReplayModel | null; mClosure: ReplayModel | null; mLockA: ReplayModel | null; mLockB: ReplayModel | null;
}

const MEET_PARAMS = withDefaults({});

function MeetSlide() {
  const { res } = useMeet(MEET_PARAMS, true);
  const a = res.options.find((o) => o.id === "pax_first")!;
  const b = res.options.find((o) => o.id === "freight_first")!;
  const money = (x: number) => fmtMoney(x);
  return <div className="pres-meet">
    <MeetScene res={res} runKey="pres" compact autoplay loop />
    <div className="pres-meet-row">
      <div><b className="pax">Минута 600 пассажиров</b><span>{perMin(res.trains.pax.weight)}</span></div>
      <div><b className="fr">Минута грузового</b><span>{perMin(res.trains.freight.weight)}</span></div>
      <div><b>Остановить 5 000 т</b><span>{num(res.trains.freight.stop_kwh)} кВт·ч</span></div>
      <div className="win"><b>1. Первым пассажирский</b><span>{money(a.econ)}</span></div>
      <div className="lose"><b>2. Первым грузовой</b><span>{money(b.econ)} + ПТЭ ✕</span></div>
    </div>
    <p className="pres-plain">Бағдар считает цену каждого порядка — время людей, энергию, простой, правила ПТЭ — и выбирает дешёвый допустимый. На участке таких решений сотни в час. <a href="#/meet">Покрутить самому →</a></p>
  </div>;
}

function SurpriseSlide() {
  return <>
    <p className="pres-hero">Четыре задачи диспетчера, которых от прототипа не ждут. Все уже решаются.</p>
    <div className="pres-steps4 pres-surprise">
      <div><i>🛠</i><b>Окно на ремонт — когда?</b><span>Путейцам нужно закрыть перегон на час. Бағдар перебирает старты на 3 часа вперёд, считает план для каждого и показывает: в 08:30 задето 10 поездов и 9,6 млн ₸, в 06:45 — 17 поездов и 22 млн ₸. Кнопка «Запланировать» — и окно случится само.</span></div>
      <div><i>👷</i><b>Бригада не доедет</b><span>Смотрит на план и конец смены каждой бригады: кто по плану придёт на пункт смены позже, чем выработает время. Предупреждает заранее, сам удваивает приоритет такого поезда.</span></div>
      <div><i>🔒</i><b>Замок за полчаса до замка</b><span>Два длинных грузовых навстречу и ни одного пути нужной длины — классический тупик. Бағдар видит его в плане-кандидате, штрафует и выбирает другой порядок: в «Замке» без него встали 6 поездов, с ним — 0.</span></div>
      <div><i>📈</i><b>Тихое насыщение</b><span>Ничего не сломалось, но задержка растёт по минуте в час. Радар предупреждает за час, что участок захлебнётся, и предлагает, каких два грузовых придержать на станциях отправления — с ценой каждого варианта.</span></div>
    </div>
    <p className="pres-caveat">И ещё: совет машинисту «ехать 62 вместо 90 — придёшь к открытому сигналу», объявление пассажирам на двух языках, CO₂ и тенге за каждым решением, «Человек против Бағдара».</p>
  </>;
}

function SlideBody({ index: raw, m }: { index: number; m: Models }) {
  if (raw === 2) return <MeetSlide />;
  if (raw === 12) return <SurpriseSlide />;
  const index = raw === 13 ? 11 : raw > 2 ? raw - 1 : raw;
  switch (index) {
    case 0: return <>
      <p className="pres-hero">Каждый поезд может помешать каждому — на одном пути двоим не разъехаться.</p>
      <PairNumbers />
      <p className="pres-plain">Диспетчер держит это в голове и решает за секунды. Чем больше поездов, тем быстрее растёт число пар — человеку физически не успеть пересчитать все последствия.</p>
    </>;
    case 1: return <>
      <p className="pres-hero">Навигатор для диспетчера: видит весь участок, предлагает план и объясняет, почему.</p>
      <div className="pres-steps4">
        <div><i>👁</i><b>Видит</b><span>Каждый поезд, путь и перегон — в реальном времени</span></div>
        <div><i>🧭</i><b>Планирует</b><span>План без конфликтов на 3 часа вперёд за 1–2 секунды</span></div>
        <div><i>💬</i><b>Объясняет</b><span>Что сделано, почему, и сколько стоила бы альтернатива</span></div>
        <div><i>⚡</i><b>Советует</b><span>Машинисту — скорость, чтобы не стоять зря и экономить энергию</span></div>
      </div>
      <p className="pres-caveat">Консультативный прототип: решение остаётся за человеком. Сигналами, стрелками и поездами не управляет.</p>
    </>;
    case 2: return <div className="pres-two-col">
      <ReplayStage model={m.mNormal} run={m.normal} />
      <div className="pres-col-copy"><p className="pres-hero">Утро на участке из 20 станций.</p>
        <ul className="pres-legend">
          <li><b>Значок</b> — поезд: синий скорый, зелёный пассажирский, серый грузовой</li>
          <li><b>Пунктир</b> на графике — план Бағдара, <b>сплошная</b> — как ехали на самом деле</li>
          <li><b>Индекс</b> 0–100 — насколько хорошо работает участок</li>
        </ul>
        {recordLink(m.normal)}</div>
    </div>;
    case 3: return <div className="pres-two-col">
      <ReplayStage model={m.mClosure} run={m.closure} focusT={m.mClosure?.r.incidents?.[0]?.t ?? null} graph={false} speed={45} />
      <div className="pres-col-copy"><p className="pres-lead">Перегон закрыт — Бағдар сам перестроил план для всех поездов и сравнил с другими вариантами.</p>
        <IncidentView model={m.mClosure} />
        {recordLink(m.closure)}</div>
    </div>;
    case 4: return <>
      <p className="pres-hero">Каждое решение — с причиной и ценой альтернативы.</p>
      <CardView card={pickCard([m.mClosure, m.mNormal, m.mLockA])} />
    </>;
    case 5: return <>
      <PairStage a={m.mLockB} b={m.mLockA} runA={m.lockB} runB={m.lockA} />
      <PairTotals a={m.mLockB} b={m.mLockA} />
    </>;
    case 6: return <>
      <p className="pres-hero">Решение принимается сверху вниз — нижний слой не отменяет верхний.</p>
      <ol className="pres-layers">
        <li><b>0 · Безопасность</b><span>Никогда два поезда на одном пути навстречу; длинный не ставится на короткий путь</span></li>
        <li><b>1 · Внеочередные</b><span>Восстановительные и пожарные поезда идут первыми</span></li>
        <li><b>2 · Класс поезда</b><span>Старший не опаздывает сверх допуска ради младшего (строгий режим ПТЭ)</span></li>
        <li><b>3 · Экономика</b><span>Среди допустимых — самый дешёвый: задержки, остановки, простой — в тенге по условным тарифам</span></li>
      </ol>
    </>;
    case 7: return <div className="pres-two-col pres-two-col-index">
      <div className="pres-col-copy"><p className="pres-hero">Индекс = 100 × Σ (вес × оценка)</p>
        <p className="pres-plain">Пять показателей, каждый от 0 до 1. 75 и выше — норма, 50–74 — внимание, ниже — критично. Нет данных — фактор помечается, веса перераспределяются.</p>
        <IndexSpark model={m.mClosure} /></div>
      <WeightEditor />
    </div>;
    case 8: return <>
      <p className="pres-hero">Всё считает сервер — экран только показывает и управляет.</p>
      <div className="pres-arch">
        <div className="arch-box"><b>Симулятор</b><span>поезда, пути, СЦБ, шаг 1 с</span></div>
        <i>→</i>
        <div className="arch-box arch-main"><b>Планировщик</b><span>CP-SAT + эвристика, 1–2 с</span></div>
        <i>→</i>
        <div className="arch-box"><b>Валидатор</b><span>независимая проверка: 0 конфликтов</span></div>
        <i>→</i>
        <div className="arch-box"><b>API + поток</b><span>FastAPI, WebSocket, журнал SQLite</span></div>
        <i>→</i>
        <div className="arch-box"><b>Экран и витрина</b><span>React, график, Гант, индекс</span></div>
      </div>
      <p className="pres-small">Индекс, советчик скорости, разбор «до / после», отчёт PDF/CSV, перемотка — модули того же Ядра.</p>
    </>;
    case 9: return <>
      <p className="pres-hero">Каждая зона — свой диспетчер, зоны считаются параллельно.</p>
      <div className="pres-hierarchy"><div className="pres-card"><b>Сеть</b><span>Зоны как цветные области с индексом</span></div>
        <div className="pres-card"><b>Зона · 20 станций</b><span>Свой планировщик, свой поток</span></div>
        <div className="pres-card"><b>Участок</b><span>Каждый поезд, пути, сигналы</span></div>
        <div className="pres-card"><b>Поезд</b><span>Совет машинисту по скорости</span></div></div>
      <table className="pres-totals pres-totals-sm"><thead><tr><th>Замер пересчёта</th><th>Зон</th><th>Пар поездов</th><th>Пересчёт</th></tr></thead>
        <tbody>
          <tr><th>≈ 20 поездов</th><td>1</td><td>105</td><td>1,3 с · CP-SAT</td></tr>
          <tr><th>≈ 100 поездов</th><td>6</td><td>3 828</td><td>2,4 с · CP-SAT, 3 процесса</td></tr>
          <tr><th>≈ 1 000 поездов</th><td>55</td><td>387 640</td><td>2,0 с · эвристика, 80 мс на зону</td></tr>
        </tbody></table>
      <p className="pres-small">Замер <code>scripts/bench_scale.py</code>, таблица — <code>docs/BENCHMARK_SCALE.md</code>. Все планы прошли валидатор. Зоны в замере независимы; ультра — стресс-тест с нагрузкой выше реальной.</p>
    </>;
    case 10: return <div className="pres-two-col pres-two-col-economy">
      <div className="pres-col-copy"><p className="pres-hero">Пропускная способность без новых рельсов.</p>
        <p>Достык — Мойынты: второй путь по проекту поднимает способность с 12 до 60 пар поездов в сутки — это стройка.</p>
        <p className="pres-plain">Умный план выжимает больше из того, что уже есть: в «Замке» без Бағдара поезда встают, с ним — едут.</p>
        <p className="pres-small">Источник по линии: <a href="https://www.gov.kz/memleket/entities/karaganda/press/news/details/461738?lang=ru" target="_blank" rel="noreferrer">gov.kz</a>.</p></div>
      <TariffEconomy a={m.mLockB} b={m.mLockA} />
    </div>;
    default: return <>
      <p className="pres-hero">Прототип советует. Решение — за диспетчером.</p>
      <div className="pres-final"><img src="./qr-simulator.svg" alt="QR-код: открыть симулятор Бағдар" className="pres-qr" />
        <div><p className="pres-plain">Откройте симулятор, закройте перегон сами и посмотрите, как Бағдар перестроит план. Во вкладке «Человек против Бағдара» тот же поток идёт без умного плана.</p></div></div>
      <div className="pres-grid pres-grid-three"><div className="pres-card"><b>Работает сегодня</b><span>Лёгкий режим: план, сбои, индекс, советы, перемотка, отчёты</span></div>
        <div className="pres-card"><b>Следующий шаг</b><span>Средний режим с координатором зон и слотами</span></div>
        <div className="pres-card"><b>Пилот</b><span>Настоящие данные участка в режиме подсказок</span></div></div>
      <p className="pres-small">Консультативный прототип · синтетические данные · условные цены · не система управления движением.</p>
    </>;
  }
}

/** Режим показа: 12 слайдов, живые фрагменты — только из настоящих записей прогонов Ядра. */
export function Presentation({ runs }: { runs: RunInfo[] }) {
  const ref = useRef<HTMLElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const find = (id: string) => runs.find((r) => r.id === id) ?? null;
  const normal = find("normal-42") ?? runs.find((r) => r.mode === "light") ?? null;
  const closure = find("closure-42");
  const lockA = find("lock-bagdar");
  const lockB = find("lock-fifo");
  const m: Models = {
    normal, closure, lockA, lockB,
    mNormal: useReplay(normal), mClosure: useReplay(closure), mLockA: useReplay(lockA), mLockB: useReplay(lockB),
  };
  const go = useCallback((delta: number) => setIndex((i) => Math.max(0, Math.min(TITLES.length - 1, i + delta))), []);

  useEffect(() => {
    if (document.fullscreenElement === ref.current) ref.current?.scrollTo(0, 0);
    else window.scrollTo(0, 0);
  }, [index]);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(-1); }
      else if (e.key.toLowerCase() === "n") { e.preventDefault(); setNotes((v) => !v); }
      else if (e.key.toLowerCase() === "f") { e.preventDefault(); void toggleFullscreen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
  const toggleFullscreen = async () => {
    try {
      setFsError(null);
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ref.current?.requestFullscreen();
    } catch {
      setFsError("Полноэкранный режим недоступен в этом браузере.");
    }
  };
  const onTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea")) { swipeStart.current = null; return; }
    swipeStart.current = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
  };

  return <section ref={ref} className="presentation" aria-label="Презентация Бағдара"
    onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    {index === 0 ? <IntroVideo fallback={normal} caption={false} /> : <BgReplay run={index === 4 ? closure : normal} />}
    <div className="pres-stage">
      <header className="pres-top"><span className="pres-kicker">БАҒДАР · АВТОДИСПЕТЧЕР</span>
        <span className="pres-counter" aria-live="polite">{index + 1} / {TITLES.length}</span></header>
      <article key={index} className={`pres-slide ${COMPACT.has(index) ? "pres-compact" : ""}`} aria-labelledby="pres-title">
        <div className="pres-heading"><span className="pres-step">СЛАЙД {String(index + 1).padStart(2, "0")}</span><h1 id="pres-title">{TITLES[index]}</h1></div>
        <div className="pres-content"><SlideBody index={index} m={m} /></div>
      </article>
      {notes && <aside className="pres-notes" aria-label="Заметки выступающего"><b>Заметки выступающего · N</b><p>{NOTES[index]}</p></aside>}
      {fsError && <p className="pres-error" role="alert">{fsError}</p>}
      <footer className="pres-controls">
        <button type="button" className="btn" onClick={() => go(-1)} disabled={index === 0} aria-label="Предыдущий слайд">← Назад</button>
        <div className="pres-dots" role="group" aria-label="Выбрать слайд">
          {TITLES.map((title, i) => <button key={title} type="button" className={i === index ? "current" : ""}
            onClick={() => setIndex(i)} aria-label={`Слайд ${i + 1}: ${title}`} aria-current={i === index ? "step" : undefined} />)}
        </div>
        <button type="button" className="btn" onClick={() => setNotes((v) => !v)} aria-pressed={notes} title="Заметки выступающего (N)">Заметки</button>
        <button type="button" className="btn" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} title="Полный экран (F)">{fullscreen ? "Выйти из экрана" : "Во весь экран"}</button>
        <button type="button" className="btn btn-primary" onClick={() => go(1)} disabled={index === TITLES.length - 1} aria-label="Следующий слайд">Дальше →</button>
      </footer>
      <p className="pres-key-hint">← → или пробел — листать · свайп · F — полный экран · N — заметки</p>
    </div>
  </section>;
}
