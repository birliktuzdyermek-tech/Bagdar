import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api } from "../api/client";
import { useSim } from "../store/sim";

interface Step {
  sel: string;
  title: string;
  text: string;
  enter?: () => Promise<string | void>;
}

function busiestSection(): string | null {
  const st = useSim.getState().state;
  if (!st) return null;
  const cnt = new Map<string, number>();
  for (const t of st.trains) if (t.section_id) cnt.set(t.section_id, (cnt.get(t.section_id) ?? 0) + 1);
  let best: string | null = null;
  let n = -1;
  for (const [k, c] of cnt) if (c > n) { best = k; n = c; }
  return best;
}

const STEPS: Step[] = [
  {
    sel: ".topbar", title: "Пульт диспетчера",
    text: "Перед вами участок железной дороги: 20 станций и около 20 поездов одновременно. Сверху главные цифры: время в модели, индекс работы участка 0–100, средняя задержка и за сколько секунд Бағдар пересчитал план.",
    enter: async () => {
      const st = useSim.getState().state;
      if (st && !st.running) {
        await api.control({ action: "speed", speed: 10 });
        await api.control({ action: "start" });
      }
    },
  },
  {
    sel: ".scheme-card", title: "Схема участка",
    text: "Каждый значок — поезд. Синий — скорый, зелёный — пассажирский, серый — грузовой. Жёлтая или красная обводка — поезд опаздывает. Нажмите на любой поезд: откроется его карточка и совет машинисту, с какой скоростью ехать, чтобы не стоять зря.",
  },
  {
    sel: ".views-card", title: "График движения",
    text: "По горизонтали время, по вертикали станции. Каждая линия — один поезд. Если две линии пересекаются на одном пути, поезда встретятся и кому-то придётся ждать. Бағдар видит такие встречи заранее и разводит поезда по станциям.",
  },
  {
    sel: ".index-card", title: "Индекс — одно число вместо сотни",
    text: "Пять показателей сведены в одно число: пропускная способность, опоздания, загрузка путей, конфликты, простой. Ниже видно, какой показатель тянет вниз и почему.",
  },
  {
    sel: ".decisions-card", title: "Ломаем перегон",
    text: "Мы только что закрыли самый загруженный перегон на 30 минут. Бағдар за пару секунд пересчитал план для всех поездов и выдал карточку: что случилось, сколько поездов задето, когда график восстановится и почему выбран именно этот план.",
    enter: async () => {
      const sec = busiestSection();
      if (!sec) return "Нет поездов на перегонах — сбой не создан";
      const r = await api.event({ type: "section_closed", section_id: sec, minutes: 30, reason: "показ для новичков" });
      return r.message;
    },
  },
  {
    sel: ".disrupt-card", title: "Ломайте сами",
    text: "Здесь можно устроить любой сбой: закрыть перегон, сломать светофор или стрелку, задержать поезд, добавить лишние поезда. Ничего не отрепетировано — каждый раз план считается заново.",
  },
  {
    sel: ".rewind", title: "Машина времени и отчёт",
    text: "Перемотка возвращает экран на 1–90 минут назад: схема, графики и лента покажут, как было. Отчёт PDF и таблицы CSV — во вкладке «Разбор».",
  },
  {
    sel: ".nav-tabs", title: "Человек против Бағдара",
    text: "Самое наглядное — вкладка «Человек против Бағдара»: один и тот же поток поездов идёт дважды, без умного плана и с Бағдаром. Через час-полтора модели видно, где поезда встают, а где едут.",
  },
];

/** Показ для новичков: подсветка частей экрана и объяснение простыми словами. */
export function GuidedTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const step = STEPS[i];

  const measure = useCallback(() => {
    const el = document.querySelector(step.sel) as HTMLElement | null;
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step.sel]);

  useLayoutEffect(() => {
    const el = document.querySelector(step.sel) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const id = window.setTimeout(measure, 350);
    return () => window.clearTimeout(id);
  }, [step.sel, measure]);

  useEffect(() => {
    setNote(null);
    step.enter?.().then((m) => m && setNote(m)).catch((e) => setNote(String(e?.message ?? e)));
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => Math.min(STEPS.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [onClose, measure]);

  const pad = 8;
  const box = rect ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad } : null;
  const below = box ? box.top + box.height + 260 < window.innerHeight : true;
  const callTop = box ? (below ? box.top + box.height + 14 : Math.max(12, box.top - 14 - 230)) : window.innerHeight / 2 - 120;
  const callLeft = box ? Math.min(Math.max(12, box.left), window.innerWidth - 560) : window.innerWidth / 2 - 270;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Показ для новичков">
      {box ? <div className="tour-spot" style={box} /> : <div className="tour-dim" />}
      <div className="tour-call" style={{ top: callTop, left: callLeft }}>
        <div className="tour-step">Шаг {i + 1} из {STEPS.length}</div>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        {note && <p className="tour-note">✓ {note}</p>}
        <div className="tour-actions">
          <button className="btn" onClick={onClose}>Закрыть</button>
          <span className="spacer" />
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>← Назад</button>
          {i < STEPS.length - 1
            ? <button className="btn btn-primary" onClick={() => setI(i + 1)}>Дальше →</button>
            : <button className="btn btn-primary" onClick={onClose}>Понятно!</button>}
        </div>
      </div>
    </div>
  );
}
