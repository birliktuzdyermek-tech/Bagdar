import { go, type Route } from "../lib/route";

const TABS: { r: Route; label: string; hint: string }[] = [
  { r: "dispatcher", label: "Диспетчер", hint: "Живой участок: схема, график, решения Бағдара" },
  { r: "scenarios", label: "Сценарии", hint: "Готовые ситуации со сбоями — запуск в один клик" },
  { r: "dashboard", label: "Сводка", hint: "Дашборд прогона: индекс, опоздания, потери в деньгах, сбои, решения — и отчёт PDF" },
  { r: "versus", label: "Человек против Бағдара", hint: "Один поток поездов: слева без Бағдара, справа с ним" },
  { r: "review", label: "Разбор и отчёт", hint: "Хронология прогона, перемотка к любому событию, отчёт PDF и таблицы CSV" },
];

/** Общая шапка трёх сайтов проекта и разделы симулятора. */
export function NavBar({ route, onSettings, onTour, onHelp }: { route: Route; onSettings: () => void; onTour: () => void; onHelp: () => void }) {
  return (
    <nav className="navbar" aria-label="Разделы">
      <div className="nav-sites" aria-label="Сайты проекта">
        <span className="nav-site current" aria-current="page">Симулятор</span>
        <a className="nav-site" href="/showcase/index.html#/" title="Витрина: слайды для защиты, «Кто первым?», записи прогонов">Витрина и слайды ↗</a>
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
        🎓 Объяснить экран
      </button>
      <button className="btn btn-small" onClick={onHelp} title="Показать подсказку «С чего начать»">❔ С чего начать</button>
      <button className="btn btn-small" onClick={onSettings} title="Веса и пороги индекса, строгий ПТЭ, тарифы">⚙ Настройки</button>
    </nav>
  );
}
