import { useEffect, useRef, useState } from "react";
import { num } from "../lib/format";
import { useCountUp } from "../lib/motion";
import type { RunInfo } from "../replay/types";
import { BgReplay } from "./BgReplay";

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

export function Home({ runs }: { runs: RunInfo[] }) {
  const [ref, seen] = useInView<HTMLUListElement>();
  const main = runs.find((r) => r.mode === "light" && !(r.injected ?? []).length) ?? runs[0] ?? null;
  return (
    <div className="home">
      <section className="hero" aria-labelledby="hero-title">
        <BgReplay run={main} />
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
            <a className="btn btn-primary btn-big" href={main ? `#/play/${main.id}` : "#/runs"}>
              ▶ Запустить
            </a>
            <a className="btn btn-big" href="#/gallery">
              Ситуации
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
