import { useEffect, useState } from "react";

interface SiteConfig {
  simulator: string | null;
  network: string | null;
  presentation: string | null;
}

const ITEMS: { key: keyof SiteConfig; label: string; hint: string }[] = [
  { key: "simulator", label: "Симулятор", hint: "Живой участок: сломать перегон самому. Нужен запущенный сервер" },
  { key: "network", label: "Сеть", hint: "Отдельное приложение «Сеть»" },
  { key: "presentation", label: "Витрина", hint: "Этот сайт: слайды, «Кто первым?», записи прогонов" },
];

// Разделы самой витрины
const SECTIONS = [
  { href: "#/", label: "С чего начать", match: (r: string) => r === "#/" || r === "" || r === "#" },
  { href: "#/meet", label: "Кто первым?", match: (r: string) => r.startsWith("#/meet") },
  { href: "#/presentation", label: "Слайды", match: (r: string) => r.startsWith("#/presentation") },
  { href: "#/runs", label: "Записи прогонов", match: (r: string) => r.startsWith("#/runs") || r.startsWith("#/play") || r.startsWith("#/gallery") },
  { href: "#/how", label: "Как это работает", match: (r: string) => r.startsWith("#/how") },
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
          if (!url) return null;    // раздел без адреса не показываем: серый пункт только путает
          return (
            <a key={it.key} className={`nav-item ${current ? "current" : ""}`} href={current ? "#/" : url} title={it.hint}
              aria-current={current ? "page" : undefined} target={current ? undefined : "_blank"} rel={current ? undefined : "noreferrer"}>
              {it.label}{current ? "" : " ↗"}
            </a>
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
