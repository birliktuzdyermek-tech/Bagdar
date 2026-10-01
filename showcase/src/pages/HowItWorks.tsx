import { useState } from "react";
import "./how-it-works.css";

const PRIORITIES = [
  {
    n: "0",
    name: "Безопасность",
    short: "Сначала допустимый маршрут",
    detail: "Однопутный перегон, интервалы, занятость станции, длина пути и закрытые ресурсы — жёсткие ограничения. Если хотя бы одно нарушено, план отклоняется.",
    note: "Ни срочность, ни экономия не разрешают конфликтное движение.",
  },
  {
    n: "1",
    name: "Внеочередные",
    short: "После проверки безопасности",
    detail: "Восстановительные, пожарные и снегоочистители, а также специальная техника для ликвидации препятствий получают первоочередной пропуск.",
    note: "Порядок основан на Правилах пользования магистральной сетью РК, приказ № 366.",
  },
  {
    n: "2",
    name: "Категория поезда",
    short: "Очередность по классу",
    detail: "Модель ставит скоростные пассажирские перед скорыми, затем остальные пассажирские, почтово-багажные и ускоренные грузовые, затем остальные грузовые и хозяйственные.",
    note: "Конкретный порядок категорий — настраиваемое допущение модели. Казахстанские ПТЭ № 544 его не задают.",
  },
  {
    n: "3",
    name: "Экономика",
    short: "Выбор среди допустимых вариантов",
    detail: "В пределах старших правил сравниваются условная стоимость задержки, остановок, простоя и изменений плана. Базовый вес поезда умножается на факторы: пассажиры, пересадка, груз, срок доставки и состояние бригады.",
    note: "Веса и деньги — условные единицы симулятора, не тарифы перевозчика.",
  },
] as const;

const LEVELS = [
  {
    id: "L3", name: "Сеть", horizon: "24–48 ч", cadence: "раз в 15 мин",
    task: "Распределяет потоки по коридорам и ограничивает вход в сеть.",
  },
  {
    id: "L2", name: "Супердиспетчер", horizon: "6–12 ч", cadence: "раз в 1–5 мин",
    task: "Согласует передачу поездов между десятью зонами, объезды и резервы.",
  },
  {
    id: "L1", name: "Диспетчер зоны", horizon: "2–3 ч", cadence: "при каждом событии",
    task: "Планирует очередность, пути приёма, скрещения и обгоны в зоне примерно из 20 станций.",
  },
  {
    id: "L0", name: "Советчик машинисту", horizon: "10–30 мин", cadence: "каждые несколько секунд",
    task: "Рекомендует скорость, выбег и подход к станции без остановки.",
  },
] as const;

const FACTORS = [
  {
    key: "Пропускная способность", weight: 30,
    rule: "min(1, пропущено / запланировано)",
    meaning: "Сколько поездов прошло относительно плана.",
  },
  {
    key: "Отклонение от графика", weight: 25,
    rule: "max(0, 1 − среднее опоздание / 30 мин)",
    meaning: "Падает с ростом среднего опоздания.",
  },
  {
    key: "Загрузка путей", weight: 20,
    rule: "1 до загрузки 80%; затем линейно до 0 при 100%",
    meaning: "Высокая загрузка оставляет мало запаса для сбоя.",
  },
  {
    key: "Простой ресурсов", weight: 15,
    rule: "1 − доля времени простоя локомотивов и бригад",
    meaning: "Показывает, сколько времени ресурсы используются.",
  },
  {
    key: "Конфликты маршрутов", weight: 10,
    rule: "max(0, 1 − конфликтов / 10)",
    meaning: "Учитывает выявленные конфликты маршрутов.",
  },
] as const;

const MODULES = [
  {
    name: "Ядро", state: "Реализовано", body: "Python-модель мира, симулятор и планировщик строят и проверяют движение на синтетических данных.",
  },
  {
    name: "Контракт replay v1", state: "Реализовано", body: "Снимки состояния, планы и события экспортируются в файл. Это единственный источник движения в Витрине.",
  },
  {
    name: "Витрина", state: "Реализовано", body: "Статический сайт читает запись и показывает схему, график, ленту и презентацию. Он не пересчитывает план.",
  },
  {
    name: "Сеть", state: "Отдельная разработка", body: "Зонное планирование и межзонные слоты развиваются в отдельном приложении. Здесь показана архитектурная связь, а не измерение сетевого режима.",
  },
] as const;

function PriorityExplainer() {
  const [selected, setSelected] = useState(0);
  const current = PRIORITIES[selected];
  return <section className="hiw-section" aria-labelledby="hiw-priority-title">
    <div className="hiw-section-head"><span className="hiw-eyebrow">01 · Правило выбора</span><h2 id="hiw-priority-title">Четыре слоя приоритета</h2>
      <p>Нажмите на слой. Следующий применяется только после предыдущего.</p></div>
    <div className="hiw-two-col">
      <ol className="hiw-priority-list">
        {PRIORITIES.map((layer, i) => <li key={layer.n}>
          <button type="button" className={`hiw-step ${i === selected ? "is-active" : ""}`}
            onClick={() => setSelected(i)} aria-pressed={i === selected} aria-controls="hiw-priority-detail">
            <span className="hiw-step-number">{layer.n}</span><span className="hiw-step-text"><strong>{layer.name}</strong><small>{layer.short}</small></span><span aria-hidden="true">↗</span>
          </button>
        </li>)}
      </ol>
      <div className="hiw-detail" id="hiw-priority-detail" key={current.n} aria-live="polite">
        <span className="hiw-detail-marker">Слой {current.n} / 3 · спецификация</span>
        <h3>{current.name}</h3><p>{current.detail}</p><p className="hiw-detail-note">{current.note}</p>
      </div>
    </div>
    <p className="hiw-caveat">Replay содержит действие решения, но пока не содержит его полной причины и цены альтернативы. Эта схема объясняет правила проекта, а не выдаёт диагноз конкретному прогону.</p>
  </section>;
}

function HierarchyExplainer() {
  const [selected, setSelected] = useState(2);
  const current = LEVELS[selected];
  return <section className="hiw-section" aria-labelledby="hiw-hierarchy-title">
    <div className="hiw-section-head"><span className="hiw-eyebrow">02 · Масштаб</span><h2 id="hiw-hierarchy-title">Иерархия диспетчеров</h2>
      <p>Нажмите на уровень, чтобы увидеть его задачу и горизонт планирования.</p></div>
    <div className="hiw-hierarchy" role="group" aria-label="Проектная иерархия диспетчеров">
      {LEVELS.map((level, i) => <button key={level.id} type="button" aria-pressed={selected === i}
        className={`hiw-hierarchy-node ${selected === i ? "is-active" : ""}`} onClick={() => setSelected(i)}>
        <span>{level.id}</span><strong>{level.name}</strong><small>{level.horizon}</small>
      </button>)}
    </div>
    <div className="hiw-detail hiw-level-detail" key={current.id} aria-live="polite">
      <span className="hiw-detail-marker">{current.id} · проектная архитектура</span>
      <h3>{current.name}</h3><p>{current.task}</p>
      <dl className="hiw-inline-def"><div><dt>Горизонт</dt><dd>{current.horizon}</dd></div><div><dt>Пересчёт</dt><dd>{current.cadence}</dd></div></dl>
    </div>
    <p className="hiw-caveat">Вверх передаются сводки о ёмкости и очередях; вниз — рамки и согласованные слоты. Доступные записи относятся к лёгкому режиму и не подтверждают работу всей иерархии.</p>
  </section>;
}

function IndexExplainer() {
  const [selected, setSelected] = useState(0);
  const current = FACTORS[selected];
  return <section className="hiw-section" aria-labelledby="hiw-index-title">
    <div className="hiw-section-head"><span className="hiw-eyebrow">03 · Метрика</span><h2 id="hiw-index-title">Индекс эффективности</h2>
      <p>Формула и веса из спецификации. Нажмите на фактор, чтобы увидеть способ расчёта.</p></div>
    <div className="hiw-index-top">
      <div><p className="hiw-formula">Индекс = 100 × Σ (вес<sub>k</sub> × s<sub>k</sub>)</p>
        <p>Каждая оценка s<sub>k</sub> лежит от 0 до 1; сумма весов равна 1.</p></div>
      <div className="hiw-no-index"><span>✓</span><strong>Индекс считается Ядром в каждом кадре</strong><small>Число, статус и оценки факторов — в записях прогонов (откройте любую запись в проигрывателе) и в симуляторе в реальном времени</small></div>
    </div>
    <div className="hiw-factor-grid">
      <div className="hiw-factor-list" role="group" aria-label="Факторы индекса">
        {FACTORS.map((factor, i) => <button type="button" key={factor.key} aria-pressed={selected === i}
          className={`hiw-factor ${selected === i ? "is-active" : ""}`} onClick={() => setSelected(i)}>
          <span className="hiw-factor-label">{factor.key}</span><strong>{factor.weight}%</strong>
          <span className="hiw-factor-track" aria-hidden="true"><span style={{ width: `${factor.weight}%` }} /></span>
        </button>)}
      </div>
      <div className="hiw-detail hiw-factor-detail" key={current.key} aria-live="polite">
        <span className="hiw-detail-marker">Вес {current.weight}% · формула из спецификации</span>
        <h3>{current.key}</h3><code>{current.rule}</code><p>{current.meaning}</p>
      </div>
    </div>
    <div className="hiw-thresholds" aria-label="Пороги индекса по спецификации: ниже 50 критично, от 50 до 74 внимание, от 75 норма">
      <div><strong>0–49 · Критично</strong></div><div><strong>50–74 · Внимание</strong></div><div><strong>75–100 · Норма</strong></div>
    </div>
    <p className="hiw-caveat">Пороги и веса — значения по умолчанию для симулятора. Без измеренных s<sub>k</sub> итоговое число не выводится.</p>
  </section>;
}

function ArchitectureExplainer() {
  const [selected, setSelected] = useState(0);
  const current = MODULES[selected];
  return <section className="hiw-section" aria-labelledby="hiw-architecture-title">
    <div className="hiw-section-head"><span className="hiw-eyebrow">04 · Данные</span><h2 id="hiw-architecture-title">От расчёта до экрана</h2>
      <p>Нажмите на модуль. Схема отделяет то, что работает в Витрине, от отдельной разработки.</p></div>
    <div className="hiw-architecture" role="group" aria-label="Модули Бағдара">
      {MODULES.map((module, i) => <button type="button" className={`hiw-module ${selected === i ? "is-active" : ""}`}
        key={module.name} aria-pressed={selected === i} onClick={() => setSelected(i)}>
        <small>{module.state}</small><strong>{module.name}</strong>
      </button>)}
    </div>
    <div className="hiw-detail hiw-architecture-detail" key={current.name} aria-live="polite">
      <span className="hiw-detail-marker">{current.state}</span><h3>{current.name}</h3><p>{current.body}</p>
    </div>
    <p className="hiw-caveat">Запись replay v1 воспроизводится без сервера и интернета. Витрина не управляет сигналами, стрелками и реальными поездами.</p>
  </section>;
}

export function HowItWorks() {
  return <div className="hiw">
    <div className="hiw-intro"><span className="hiw-eyebrow">БАҒДАР · принцип работы</span><h1>Как это работает</h1>
      <p>Четыре правила выбора, четыре уровня планирования и одна проверяемая цепочка данных.</p>
      <span className="hiw-intro-note">Интерактивные схемы описывают устройство проекта. Движение поездов смотрите в <a href="#/runs">записях прогонов</a>.</span>
    </div>
    <nav className="hiw-jump" aria-label="Разделы объяснения">
      {[
        ["Приоритеты", "hiw-priority-title"], ["Иерархия", "hiw-hierarchy-title"],
        ["Индекс", "hiw-index-title"], ["Архитектура", "hiw-architecture-title"],
      ].map(([label, id]) => <button key={id} type="button" onClick={() => document.getElementById(id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start",
      })}>{label}</button>)}
    </nav>
    <PriorityExplainer /><HierarchyExplainer /><IndexExplainer /><ArchitectureExplainer />
  </div>;
}
