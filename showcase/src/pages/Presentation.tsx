import { useCallback, useEffect, useRef, useState } from "react";
import { clock, num } from "../lib/format";
import { reducedMotionNow, useCountUp } from "../lib/motion";
import { drawGraph } from "../player/graph";
import { drawScheme } from "../player/scheme";
import { loadReplay } from "../replay/load";
import { ReplayModel } from "../replay/model";
import type { RunInfo, SimEvent } from "../replay/types";
import { BgReplay } from "./BgReplay";
import "./presentation.css";

const TITLES = [
  "Проблема", "Диспетчер сегодня", "Бағдар", "Живой участок", "Изменение графика", "Приоритеты",
  "Неочевидное решение", "Индекс участка", "Архитектура", "Масштаб", "Экономика", "Ограничения и развитие",
] as const;

const NOTES = [
  "Это количество возможных пар поездов, а не число конфликтов. Расчёт: n·(n−1)/2. Фон — воспроизведение настоящей записи лёгкого режима.",
  "На участке диспетчер следит за встречными и попутными поездами, путями, расписанием и задержками. Не утверждайте, что человек физически проверяет все 499 500 пар.",
  "Бағдар — консультативный прототип. Он предлагает планы и показывает их в симуляции; не управляет сигналами, стрелками и реальными поездами.",
  "На схеме и графике реальные кадры replay. Пунктир — сохранённый план, сплошная линия — факт. Можно открыть полный проигрыватель.",
  "В 07:00 в запись внесена внешняя задержка скорого поезда на 15 минут. Это не смоделированный физический отказ. Время расчёта берётся из опубликованного плана в replay.",
  "Четыре слоя применяются сверху вниз. Правила и веса здесь приведены из спецификации; текущий replay не содержит полного объяснения каждого решения.",
  "Показываем настоящее действие из журнала replay. Доказательство через два будущих ещё нельзя показать: нет пары связанных прогонов и цены альтернативы.",
  "Формула и веса взяты из спецификации. Поля index в имеющихся кадрах равны null, поэтому числовой индекс не показываем. Регуляторы демонстрируют только состав весов.",
  "Это схема проектной архитектуры. Витрина читает готовый replay; планировщик и симулятор работают в Ядре. Отдельная Сеть создаётся другой сессией.",
  "Тысяча поездов — целевой режим из спецификации, не измеренная производительность. Доступные записи относятся к лёгкому режиму.",
  "Достык — Мойынты: опубликованная проектная оценка роста пропускной способности со строительством второго пути. Поле тарифа — учебный расчёт 15 минут, не экономия Бағдара.",
  "Это консультативный прототип с синтетическим движением. QR на интерактивное «Сломайте сами» появится только после появления рабочего публичного адреса функции.",
] as const;

function useReplay(run: RunInfo | null): { model: ReplayModel | null; error: string | null } {
  const [model, setModel] = useState<ReplayModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!run) return;
    let alive = true;
    setModel(null);
    setError(null);
    loadReplay(run.file).then(
      (r) => { if (alive) setModel(new ReplayModel(r)); },
      (e: Error) => { if (alive) setError(e.message); },
    );
    return () => { alive = false; };
  }, [run]);
  return { model, error };
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
    <div><strong>{num(Math.round(n20))}</strong><span>при 20 поездах</span></div>
    <div><strong>{num(Math.round(n100))}</strong><span>при 100 поездах</span></div>
    <div><strong>{num(Math.round(n1000))}</strong><span>при 1 000 поездах</span></div>
  </div>;
}

/** Компактная схема и график из тех же функций и кадров, что в полном проигрывателе. */
function ReplayStage({ model, run, nearEvent = false }: { model: ReplayModel | null; run: RunInfo | null; nearEvent?: boolean }) {
  const schemeRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<HTMLCanvasElement | null>(null);
  const [t, setT] = useState<number | null>(null);

  useEffect(() => {
    if (!model) return;
    const cvs = [schemeRef.current, graphRef.current].filter((x): x is HTMLCanvasElement => !!x);
    if (cvs.length !== 2) return;
    const injection = model.r.events.find((e) => e.kind === "train_delay_injected");
    const beginning = nearEvent && injection ? Math.max(model.start, injection.t - 90) : model.start + 1800;
    let current = beginning;
    let last = 0;
    let lastUi = 0;
    let raf = 0;
    const dimensions = new Map<HTMLCanvasElement, { w: number; h: number }>();
    const resize = () => {
      for (const cv of cvs) {
        const rect = cv.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
        cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
        dimensions.set(cv, { w: rect.width, h: rect.height });
      }
    };
    const ro = new ResizeObserver(resize);
    cvs.forEach((cv) => ro.observe(cv));
    resize();
    const render = (now: number) => {
      const reduced = reducedMotionNow();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!reduced) {
        current += dt * 60;
        if (current >= model.end) current = beginning;
      }
      const projector = document.documentElement.classList.contains("projector");
      const frame = model.frameAt(current).frame;
      const sc = cvs[0].getContext("2d");
      const sd = dimensions.get(cvs[0]);
      if (sc && sd?.w) drawScheme(sc, sd.w, sd.h, model, model.trainsAt(current, !reduced), frame, {
        projector, selected: null, hover: null, flashes: [], now,
      });
      const gc = cvs[1].getContext("2d");
      const gd = dimensions.get(cvs[1]);
      if (gc && gd?.w) drawGraph(gc, gd.w, gd.h, model, current, {
        projector, selected: null, before: 1800, after: 1800, morph: null, now, reduced,
      });
      if (now - lastUi > 250) { lastUi = now; setT(current); }
      raf = requestAnimationFrame(render);
    };
    setT(beginning);
    raf = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [model, nearEvent]);

  if (!run) return <p className="pres-empty">Записей лёгкого режима пока нет.</p>;
  if (!model) return <p className="pres-empty" role="status">Загружается запись «{run.title}»…</p>;
  const metrics = model.frameAt(t ?? model.start).frame.state.metrics;
  const plan = model.planAt(t ?? model.start);
  return <div className="pres-replay">
    <div className="pres-replay-head">
      <span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Запись прогона</span>
      <strong>{run.title}</strong>
      <span className="pres-time">{clock(t ?? model.start)} · ×60</span>
    </div>
    <canvas ref={schemeRef} className="pres-scheme" role="img" aria-label="Схема участка из кадров записи" />
    <canvas ref={graphRef} className="pres-graph" role="img" aria-label="График движения из плана и кадров записи" />
    <div className="pres-replay-foot">
      <span>Поездов на участке: <b>{metrics.active_trains}</b></span>
      <span>Ожидают: <b>{metrics.waiting_trains}</b></span>
      <span>План: <b>{plan ? `v${plan.plan.version}` : "ещё нет"}</b></span>
    </div>
  </div>;
}

const FACTORS = [
  ["Пропускная способность", 30], ["Отклонение от графика", 25], ["Загрузка путей", 20],
  ["Простой ресурсов", 15], ["Конфликты маршрутов", 10],
] as const;

function WeightEditor() {
  const [weights, setWeights] = useState<number[]>(FACTORS.map((f) => f[1]));
  const sum = weights.reduce((a, b) => a + b, 0);
  return <div className="pres-weight-box">
    <p className="pres-small">Проба изменения весов в интерфейсе. На запись прогона эти регуляторы не влияют.</p>
    {FACTORS.map(([label], i) => <label className="pres-weight" key={label}>
      <span>{label}</span>
      <input type="range" min="0" max="50" step="1" value={weights[i]}
        onChange={(e) => setWeights((w) => w.map((x, j) => j === i ? Number(e.target.value) : x))} />
      <strong>{weights[i]} %</strong>
    </label>)}
    <p className={sum === 100 ? "pres-small" : "pres-small pres-warn"}>Сумма весов: {sum} % {sum !== 100 && "· для формулы нужна сумма 100 %"}</p>
  </div>;
}

function TariffExample({ delayMinutes }: { delayMinutes: number | null }) {
  const [rate, setRate] = useState("10");
  const n = Number(rate);
  const valid = rate !== "" && Number.isFinite(n) && n >= 0 && delayMinutes !== null;
  return <div className="pres-tariff">
    <label htmlFor="pres-tariff">Ваш тариф за минуту задержки, у. е.</label>
    <input id="pres-tariff" type="number" min="0" step="0.1" inputMode="decimal" value={rate}
      onChange={(e) => setRate(e.target.value)} />
    <strong>{valid ? `${num(n * delayMinutes, 1)} у. е.` : delayMinutes === null ? "Нет записи задержки" : "Введите неотрицательный тариф"}</strong>
    <span>{delayMinutes === null ? "Когда появится запись внешней задержки, расчёт будет доступен." : `${num(delayMinutes, 1)} мин внешней задержки из записи × ваш тариф.`} Иллюстрация, не измеренная экономия Бағдара.</span>
  </div>;
}

function recordLink(run: RunInfo | null, label = "Открыть полную запись") {
  return run ? <a className="btn btn-primary pres-link" href={`#/play/${run.id}`}>{label} ↗</a> : null;
}

function SlideBody({ index, normal, disrupted, normalModel, disruptionModel }: {
  index: number; normal: RunInfo | null; disrupted: RunInfo | null;
  normalModel: ReplayModel | null; disruptionModel: ReplayModel | null;
}) {
  const injected = disruptionModel?.r.events.find((e) => e.kind === "train_delay_injected");
  const seconds = injected?.data.seconds;
  const delayMinutes = typeof seconds === "number" ? seconds / 60 : disrupted?.injected?.[0]?.minutes ?? null;
  const trainNumber = injected?.train_id ? disruptionModel?.trains.get(injected.train_id)?.number : null;
  const nextPlan = injected && disruptionModel?.r.plans.find((p) => p.t > injected.t);
  const decision: SimEvent | undefined = disruptionModel?.r.events.find((e) => e.kind === "decision" && (!injected || e.t >= injected.t));
  switch (index) {
    case 0: return <>
      <p className="pres-hero">Каждая пара поездов может встретиться на общем ресурсе.</p>
      <PairNumbers />
      <p className="pres-small">Математика пар: n·(n−1)/2. Это возможные пары, не обнаруженные конфликты.</p>
    </>;
    case 1: return <>
      <p className="pres-hero">В одну минуту нужно видеть весь участок.</p>
      <div className="pres-grid pres-grid-four">
        <div className="pres-card"><b>Поезда</b><span>Где каждый находится и куда идёт</span></div>
        <div className="pres-card"><b>Ресурсы</b><span>Перегоны, пути, длины составов</span></div>
        <div className="pres-card"><b>График</b><span>Встречи, обгоны и опоздания</span></div>
        <div className="pres-card"><b>Последствия</b><span>Как одно ожидание меняет следующий час</span></div>
      </div>
    </>;
    case 2: return <>
      <p className="pres-hero">Бағдар предлагает бесконфликтный план и показывает движение по нему.</p>
      <div className="pres-flow"><span>Состояние участка</span><i>→</i><span>Планирование</span><i>→</i><span>Проверка</span><i>→</i><span>Рекомендация</span></div>
      <p className="pres-caveat">Консультативный прототип. Не управляет сигналами, стрелками и реальными поездами.</p>
    </>;
    case 3: return <div className="pres-two-col">
      <ReplayStage model={normalModel} run={normal} />
      <div className="pres-col-copy"><p className="pres-hero">Участок движется по кадрам настоящего прогона.</p>
        <p>Пунктир на графике — сохранённый план. Сплошная линия — факт из кадров.</p>
        <p className="pres-small">Синтетические поезда · лёгкий режим · схема не в масштабе.</p>
        {recordLink(normal)}</div>
    </div>;
    case 4: return <div className="pres-two-col">
      <ReplayStage model={disruptionModel} run={disrupted} nearEvent />
      <div className="pres-col-copy"><p className="pres-hero">Задержка меняет план.</p>
        <dl className="pres-stats"><dt>Событие</dt><dd>{injected ? `${clock(injected.t, false)} · ${delayMinutes === null ? "внешняя задержка" : `+${num(delayMinutes, 1)} мин`}${trainNumber ? ` поезду № ${trainNumber}` : ""}` : "загружается из записи"}</dd>
          <dt>Новый план</dt><dd>{nextPlan ? clock(nextPlan.t) : "загружается из записи"}</dd>
          <dt>Расчёт</dt><dd>{nextPlan?.plan.compute_ms != null ? `${num(nextPlan.plan.compute_ms, 0)} мс · из replay` : "нет в записи"}</dd></dl>
        <p className="pres-small">Это внесённая извне задержка с указанной причиной; физический отказ локомотива в модели не воспроизводится.</p>
        {recordLink(disrupted)}</div>
    </div>;
    case 5: return <>
      <p className="pres-hero">Решение принимается сверху вниз.</p>
      <ol className="pres-layers">
        <li><b>0 · Безопасность</b><span>Запрет конфликтного маршрута, длина пути, занятость ресурсов</span></li>
        <li><b>1 · Внеочередные</b><span>Восстановительные, пожарные, снегоочистители</span></li>
        <li><b>2 · Категория поезда</b><span>Порядок классов настраивается в модели; ПТЭ РК № 544 его не задают</span></li>
        <li><b>3 · Экономика</b><span>Стоимость задержки внутри допустимых вариантов, у. е.</span></li>
      </ol><p className="pres-small">Так задано в спецификации. Replay пока не раскрывает полную причину выбора для каждой карточки.</p>
    </>;
    case 6: return <>
      <p className="pres-hero">Действие видно. Доказательство альтернативой пока недоступно.</p>
      <div className="pres-quote"><span className="badge badge-rec"><span className="rec-dot" aria-hidden /> Запись прогона</span>
        <blockquote>{decision?.message ?? "В этой записи пока нет карточки решения после события."}</blockquote>
        {decision && <small>{clock(decision.t)} · событие decision из replay</small>}</div>
      <div className="pres-grid pres-grid-two"><div className="pres-card"><b>Есть в replay</b><span>Действие, время, место и уровень решения</span></div>
        <div className="pres-card"><b>Не хватает для «Докажи»</b><span>Причины, цены альтернативы и второго связанного прогона</span></div></div>
      {recordLink(disrupted, "Изучить решение в записи")}
    </>;
    case 7: return <div className="pres-two-col pres-two-col-index">
      <div className="pres-col-copy"><p className="pres-hero">Индекс = 100 × Σ (вес × оценка)</p>
        <p>Оценка каждого фактора от 0 до 1. Пороги по спецификации: 75+ норма, 50–74 внимание, ниже 50 критично.</p>
        <p className="pres-caveat">В текущих записях <code>frames[].index = null</code>. Фактический индекс и его изменение показать нельзя.</p></div>
      <WeightEditor />
    </div>;
    case 8: return <>
      <p className="pres-hero">От состояния участка к проверенному плану и записи.</p>
      <div className="pres-architecture" role="img" aria-label="Схема модулей: мир и события переходят в симулятор, планировщик и проверку, затем API и запись прогона поступают в витрину">
        <div>Мир и события</div><i>→</i><div>Симулятор</div><i>↔</i><div>Планировщик</div><i>→</i><div>Проверка</div><i>→</i><div>Replay / API</div><i>→</i><div>Витрина</div>
      </div><p className="pres-small">Витрина читает replay v1. Она не считает планы и не меняет записанные кадры.</p>
    </>;
    case 9: return <>
      <p className="pres-hero">Проектная иерархия решений: от поезда до сети.</p>
      <div className="pres-hierarchy"><div className="pres-card"><b>L3 · Сетевой уровень</b><span>Потоки и коридоры</span></div>
        <div className="pres-card"><b>L2 · Супердиспетчер</b><span>Границы зон и слоты передачи</span></div>
        <div className="pres-card"><b>L1 · Диспетчер зоны</b><span>Порядок поездов, пути, скрещения</span></div>
        <div className="pres-card"><b>L0 · Советчик машинисту</b><span>Рекомендация скорости и выбега</span></div></div>
      <p className="pres-caveat">1 000 поездов — целевой стресс-режим из проекта. Записи и проверенных замеров времени для него сейчас нет.</p>
    </>;
    case 10: return <div className="pres-two-col pres-two-col-economy">
      <div className="pres-col-copy"><p className="pres-hero">Достык — Мойынты: экономика пропускной способности.</p>
        <p>Для второго пути публиковалась проектная оценка роста с 12 до 60 пар поездов в сутки.</p>
        <p className="pres-small">Источник: <a href="https://www.gov.kz/memleket/entities/karaganda/press/news/details/461738?lang=ru" target="_blank" rel="noreferrer">gov.kz</a>. Это характеристика инфраструктурного проекта, не результат Бағдара.</p>
        <p className="pres-caveat">Парного эксперимента «с Бағдаром / без» в replay нет. Экономию и прирост пропускной способности алгоритма не заявляем.</p></div>
      <TariffExample delayMinutes={delayMinutes} />
    </div>;
    default: return <>
      <p className="pres-hero">Прототип советует. Решение за диспетчером.</p>
      <div className="pres-final"><img src="./qr-simulator.svg" alt="QR-код: открыть действующий симулятор Бағдар" className="pres-qr" />
        <div><p>Открыть действующий <a href="https://bagdar-demo.onrender.com" target="_blank" rel="noreferrer">симулятор Бағдар</a> на телефоне.</p>
          <p className="pres-small">Функция «Сломайте сами» там пока не проверена, поэтому QR ведёт на обычный симулятор.</p>
          {recordLink(disrupted, "Открыть запись задержки")}</div></div>
      <div className="pres-grid pres-grid-three"><div className="pres-card"><b>Сегодня</b><span>Записи лёгкого режима</span></div>
        <div className="pres-card"><b>Нужно дальше</b><span>Индекс, причины, парные прогоны</span></div>
        <div className="pres-card"><b>Испытания</b><span>Публичный симулятор</span></div></div>
      <p className="pres-small">Консультативный прототип · синтетические данные · не система управления движением.</p>
    </>;
  }
}

/** Статическая презентация с живыми фрагментами только из настоящего replay. */
export function Presentation({ runs }: { runs: RunInfo[] }) {
  const ref = useRef<HTMLElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const normal = runs.find((r) => r.id === "normal-42") ?? runs.find((r) => r.mode === "light" && !(r.injected ?? []).length) ?? null;
  const disrupted = runs.find((r) => r.id === "butterfly-42") ?? runs.find((r) => (r.injected ?? []).length > 0) ?? null;
  const { model: normalModel, error: normalError } = useReplay(normal);
  const { model: disruptionModel, error: disruptionError } = useReplay(disrupted);
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
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(1); }
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
    <BgReplay run={index === 4 ? disrupted : normal} />
    <div className="pres-stage">
      <header className="pres-top"><span className="pres-kicker">БАҒДАР · РЕЖИМ ПОКАЗА</span>
        <span className="pres-counter" aria-live="polite">{index + 1} / {TITLES.length}</span></header>
      <article key={index} className="pres-slide" aria-labelledby="pres-title">
        <div className="pres-heading"><span className="pres-step">СЛАЙД {String(index + 1).padStart(2, "0")}</span><h1 id="pres-title">{TITLES[index]}</h1></div>
        <div className="pres-content"><SlideBody index={index} normal={normal} disrupted={disrupted}
          normalModel={normalModel} disruptionModel={disruptionModel} /></div>
      </article>
      {(normalError || disruptionError) && <p className="pres-error" role="alert">⚠ Не удалось открыть запись: {normalError ?? disruptionError}</p>}
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
      <p className="pres-key-hint">← → листать · свайп · F полный экран · N заметки</p>
    </div>
  </section>;
}
