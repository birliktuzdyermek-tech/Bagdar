import { useEffect, useState } from "react";

interface SiteConfig {
  simulator: string | null;
  network: string | null;
  presentation: string | null;
}

const ITEMS: { key: keyof SiteConfig; label: string }[] = [
  { key: "simulator", label: "Симулятор" },
  { key: "network", label: "Сеть" },
  { key: "presentation", label: "Презентация" },
];

/** Общая шапка трёх сайтов. Адреса — public/site.config.json, null — пункт неактивен. */
export function Header({ projector, onProjector }: { projector: boolean; onProjector: () => void }) {
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  useEffect(() => {
    fetch("./site.config.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => setCfg(c), () => setCfg(null));
  }, []);
  return (
    <header className="header">
      <a className="skip" href="#main">К содержимому</a>
      <a className="brand" href="#/" aria-label="Бағдар — витрина, к списку записей">
        БАҒДАР
      </a>
      <nav className="nav" aria-label="Сайты проекта">
        {ITEMS.map((it) => {
          const url = cfg?.[it.key] ?? null;
          const current = it.key === "presentation";
          return url ? (
            <a key={it.key} className={`nav-item ${current ? "current" : ""}`} href={current ? "#/" : url} aria-current={current ? "page" : undefined}>
              {it.label}
            </a>
          ) : (
            <span key={it.key} className="nav-item disabled" aria-disabled="true" title="Адрес пока не задан в site.config.json">
              {it.label}
            </span>
          );
        })}
      </nav>
      <div className="spacer" />
      <button className={`btn btn-ghost ${projector ? "on" : ""}`} onClick={onProjector} aria-pressed={projector} title="Крупнее шрифт и толще линии для экрана в зале (клавиша P)">
        ◱ Режим проектора
      </button>
      <span className="chip-disclaimer" title="Не управляет реальными сигналами, стрелками и поездами и не заменяет СЦБ">
        Консультативный прототип
      </span>
    </header>
  );
}
