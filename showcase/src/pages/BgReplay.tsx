import { useEffect, useRef, useState } from "react";
import { reducedMotionNow } from "../lib/motion";
import { cssVar, GROUP_VAR, group } from "../lib/palette";
import { loadReplay } from "../replay/load";
import { ReplayModel } from "../replay/model";
import type { RunInfo } from "../replay/types";

const SPEED = 120;

/** Живой фон главной: проигрывание настоящей записи, а не нарисованная анимация. */
export function BgReplay({ run }: { run: RunInfo | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState<{ runId: string; model: ReplayModel } | null>(null);
  const model = run && loaded?.runId === run.id ? loaded.model : null;

  useEffect(() => {
    if (!run) return;
    let alive = true;
    loadReplay(run.file).then((r) => alive && setLoaded({ runId: run.id, model: new ReplayModel(r) }), () => undefined);
    return () => {
      alive = false;
    };
  }, [run]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !model) return;
    let raf = 0;
    let last = 0;
    let t = model.start + 1800;
    let w = 0;
    let h = 0;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      w = r.width;
      h = r.height;
      cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const draw = (now: number) => {
      const reduced = reducedMotionNow();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!reduced) {
        t += dt * SPEED;
        if (t >= model.end) t = model.start;
      }
      const ctx = cv.getContext("2d");
      if (ctx && w) {
        ctx.clearRect(0, 0, w, h);
        const pad = 24;
        const X = (km: number) => pad + (km / model.kmMax) * (w - 2 * pad);
        // линия участка в масштабе километров и раздельные пункты
        const rows = [Math.min(72, h * 0.14)]; // верхняя полоса, над текстом
        ctx.strokeStyle = cssVar("--rail");
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2;
        for (const y of rows) {
          ctx.beginPath();
          ctx.moveTo(pad, y);
          ctx.lineTo(w - pad, y);
          ctx.stroke();
        }
        for (const s of model.r.world.stations) {
          const x = X(s.km);
          const hh = s.kind === "loop" ? 6 : 12;
          ctx.fillStyle = cssVar("--border-strong");
          ctx.fillRect(x - 1.5, rows[0] - hh, 3, hh * 2);
        }
        ctx.globalAlpha = 0.85;
        for (const tv of model.trainsAt(t, !reduced)) {
          const x = X(tv.km);
          const y = rows[0] + (tv.train.direction > 0 ? -9 : 9);
          ctx.fillStyle = cssVar(GROUP_VAR[group(tv.train.cls)]);
          ctx.beginPath();
          ctx.arc(x, y, tv.train.passengers > 0 ? 5 : 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [model]);

  return (
    <div className="bg-replay" aria-hidden>
      <canvas ref={ref} />
      {model && run && (
        <span className="bg-caption">
          фон — запись прогона «{run.title}», ×{SPEED}
        </span>
      )}
    </div>
  );
}
