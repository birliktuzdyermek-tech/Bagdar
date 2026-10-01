import { go, type Route } from "../lib/route";

const TABS: { r: Route; label: string; hint: string }[] = [
  { r: "dispatcher", label: "Диспетчер", hint: "Живой участок: схема, график, решения Бағдара" },
  { r: "scenarios", label: "Сценарии", hint: "Готовые ситуации со сбоями — запуск в один клик" },
  { r: "versus", label: "Человек против Бағдара", hint: "Один поток поездов: слева без Бағдара, справа с ним" },
  { r: "review", label: "Разбор", hint: "Перемотка, хронология, отчёт PDF и CSV" },
];

/** Общая шапка трёх сайтов проекта и разделы симулятора. */
export function NavBar({ route, onSettings, onTour }: { route: Route; onSettings: () => void; onTour: () => void }) {
  return (
    <nav className="navbar" aria-label="Разделы">
      <div className="nav-sites" aria-label="Сайты проекта">
        <span className="nav-site current" aria-current="page">Симулятор</span>
        <span className="nav-site disabled" title="Отдельное приложение «Сеть» — масштаб и реальные линии">Сеть</span>
        <a className="nav-site" href="/showcase/index.html#/presentation" title="Слайды для защиты, записи прогонов">Презентация ↗</a>
      </div>
      <div className="nav-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.r} role="tab" aria-selected={route === t.r} className={`nav-tab ${route === t.r ? "on" : ""}`}
            title={t.hint} onClick={() => go(t.r)}>
            {t.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <a className="btn btn-small btn-meet" href="/showcase/index.html#/meet" title="Пассажирский или грузовой: кого пропустить первым и почему — анимация с расчётом цены">
        🚆 Кто первым? ↗
      </a>
      <button className="btn btn-small btn-tour" onClick={onTour} title="Пошаговое объяснение экрана простыми словами (2 минуты)">
        🎓 Показ для новичков
      </button>
      <a className="nav-link" href="/showcase/index.html#/how" title="Приоритеты, индекс, архитектура — простыми словами">Как это работает ↗</a>
      <button className="btn btn-small" onClick={onSettings} title="Веса и пороги индекса, строгий ПТЭ, тарифы">⚙ Настройки</button>
    </nav>
  );
}
