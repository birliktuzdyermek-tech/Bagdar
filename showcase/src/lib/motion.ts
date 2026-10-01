import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(fn: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

/** Системная настройка «меньше движения»: остаются только смены состояний. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}

export function reducedMotionNow(): boolean {
  return window.matchMedia(QUERY).matches;
}

export const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3);

/** Число докручивается к новому значению за 300 мс, а не прыгает. */
export function useCountUp(value: number, ms = 300): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const shownRef = useRef(value);
  shownRef.current = shown;
  useEffect(() => {
    if (reduced || !Number.isFinite(value)) {
      setShown(value);
      return;
    }
    from.current = shownRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const a = Math.min(1, (now - start) / ms);
      setShown(from.current + (value - from.current) * easeOut(a));
      if (a < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // страховка: если кадры не рисуются (скрытая вкладка, запись ролика), число всё равно встаёт на место
    const done = window.setTimeout(() => setShown(value), ms + 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
  }, [value, ms, reduced]);
  return shown;
}
