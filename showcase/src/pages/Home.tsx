import { useEffect, useRef, useState } from "react";
import { num } from "../lib/format";
import { useCountUp } from "../lib/motion";
import type { RunInfo } from "../replay/types";
import { IntroVideo } from "./IntroVideo";

// Число пар поездов, которые нужно развести между собой: n·(n−1)/2.
const SCALE = [
  { trains: 20, label: "участок" },
  { trains: 100, label: "регион" },
  { trains: 1000, label: "сеть" },
];
const pairs = (n: number) => (n * (n - 1)) / 2;

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { threshold: 0.3 });
    io.observe(el);
    // числа на первом экране: если наблюдатель не сработал (вкладка не рисуется), всё равно запускаем
    const fallback = window.setTimeout(() => setSeen(true), 800);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, [seen]);
  return [ref, seen];
}

function PairCount({ trains, label, go }: { trains: number; label: string; go: boolean }) {
  const v = useCountUp(go ? pairs(trains) : 0, 1400);
  return (
    <li className="pair">
      <span className="pair-value">{num(Math.round(v))}</span>
      <span className="pair-label">
        пар при {num(trains)} поездах <span className="muted">· {label}</span>
      </span>
    </li>
  );
}

const STARTS = [
  { href: "#/meet", icon: "🚆", time: "2 минуты", title: "Кто поедет первым?",
    text: "Главная идея на одном экране: пассажирский и грузовой навстречу, кто ждёт — тот стоит денег. Можно угадать самому и подвигать условия." },
  { href: "#/presentation", icon: "🎞", time: "7 минут", title: "Слайды для защиты",
    text: "13 слайдов с живыми записями внутри. Листать ← →, F — на весь экран, N — заметки выступающего." },
  { href: "#/play/closure-42", icon: "▶", time: "3 минуты", title: "Живой участок: закрытие перегона",
    text: "Запись настоящего прогона: 20 станций, поезда, план Бағдара. В 06:30 закрывается перегон — смотрите, как план перестраивается." },
  { href: "#/economy", icon: "₸", time: "3 минуты", title: "Откуда берутся деньги",
    text: "Что такое потери в тенге: время людей, энергия на остановки, простой бригад. Тарифы, веса и калькулятор." },
  { href: "#/how", icon: "📖", time: "5 минут", title: "Как это работает",
    text: "Приоритеты, индекс участка и архитектура — простыми словами, без формул." },
];

export function Home({ runs }: { runs: RunInfo[] }) {
  const [ref, seen] = useInView<HTMLUListElement>();
  const main = runs.find((r) => r.mode === "light" && !(r.injected ?? []).length) ?? runs[0] ?? null;
  const [sim, setSim] = useState<string | null>(null);
  useEffect(() => {
    fetch("./site.config.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((c) => setSim(c?.simulator ?? null), () => setSim(null));
  }, []);
  return (
    <div className="home">
      <section className="starts" aria-labelledby="starts-title">
        <h2 id="starts-title">С чего начать</h2>
        <ul className="start-cards">
          {STARTS.map((c) => (
            <li key={c.href}>
              <a className="start-card" href={c.href.startsWith("#/play") && !runs.some((r) => `#/play/${r.id}` === c.href) ? (main ? `#/play/${main.id}` : "#/runs") : c.href}>
                <span className="start-ico" aria-hidden>{c.icon}</span>
                <span className="start-time">{c.time}</span>
                <span className="start-title">{c.title}</span>
                <span className="start-text">{c.text}</span>
              </a>
            </li>
          ))}
          <li>
            {sim ? (
              <a className="start-card start-sim" href={sim} target="_blank" rel="noreferrer">
                <span className="start-ico" aria-hidden>🖥</span>
                <span className="start-time">живой сервер</span>
                <span className="start-title">Симулятор ↗</span>
                <span className="start-text">Сломать перегон самому и посмотреть, как Бағдар перестроит план за 2 секунды. Открывается в новой вкладке.</span>
              </a>
            ) : (
              <span className="start-card start-sim is-off">
                <span className="start-ico" aria-hidden>🖥</span>
                <span className="start-time">нужен сервер</span>
                <span className="start-title">Симулятор</span>
                <span className="start-text">Сломать перегон самому. Запускается локально: <code>docker compose up --build</code> → localhost:8000.</span>
              </span>
            )}
          </li>
        </ul>
      </section>
      <section className="hero" aria-labelledby="hero-title">
        <IntroVideo fallback={main} />
        <div className="hero-body">
          <p className="hero-kicker">Бағдар — по-казахски «курс, ориентир»</p>
          <h1 id="hero-title" className="hero-title">
            Автодиспетчер, который видит участок целиком и сам перестраивает график при сбоях
          </h1>
          <ul className="pairs" ref={ref} aria-label="Сколько пар поездов нужно развести">
            {SCALE.map((s) => (
              <PairCount key={s.trains} trains={s.trains} label={s.label} go={seen} />
            ))}
          </ul>
          <p className="hero-sub">
            Каждую пару поездов нужно развести без конфликта: кто ждёт, где и сколько. Человек держит в голове десятки пар. Бағдар
            проверяет все и показывает, почему выбрал именно так.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary btn-big" href="#/meet">
              ▶ Кто поедет первым?
            </a>
            <a className="btn btn-big" href={main ? `#/play/${main.id}` : "#/runs"}>
              Живой участок
            </a>
            <a className="btn btn-big" href="#/gallery" title="17 ситуаций из плана проекта; с записью — только часть">
              Все ситуации
            </a>
          </div>
          <p className="hero-note">
            Консультативный прототип — не система управления движением. Не управляет сигналами и стрелками и не заменяет СЦБ.
            Данные синтетические.
          </p>
        </div>
      </section>
    </div>
  );
}
