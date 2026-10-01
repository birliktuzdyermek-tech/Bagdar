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

// Разделы самой витрины
const SECTIONS = [
  { href: "#/", label: "Главная", match: (r: string) => r === "#/" || r === "" || r === "#" },
  { href: "#/gallery", label: "Ситуации", match: (r: string) => r.startsWith("#/gallery") },
  { href: "#/runs", label: "Записи", match: (r: string) => r.startsWith("#/runs") || r.startsWith("#/play") },
  { href: "#/how", label: "Как это работает", match: (r: string) => r.startsWith("#/how") },
  { href: "#/presentation", label: "Режим показа", match: (r: string) => r.startsWith("#/presentation") },
];

/** Общая шапка трёх сайтов. Адреса — public/site.config.json, null — пункт неактивен. */
export function Header({ projector, onProjector, route }: { projector: boolean; onProjector: () => void; route: string }) {
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
      <nav className="subnav" aria-label="Разделы витрины">
        {SECTIONS.map((s) => (
          <a key={s.href} href={s.href} className={`subnav-item ${s.match(route) ? "current" : ""}`} aria-current={s.match(route) ? "page" : undefined}>
            {s.label}
          </a>
        ))}
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
