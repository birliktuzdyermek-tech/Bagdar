import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { EfficiencyIndex } from "../api/types";
import { useSim } from "../store/sim";

// Индекс эффективности участка (раздел 10 BAGDAR.md): число 0–100 и факторы,
// которые сильнее всего тянут его вниз. Запрашивается не чаще раза в 1,5 с
// и только когда время модели сдвинулось.
const POLL_MS = 1500;

const LEVEL: Record<EfficiencyIndex["level"], { label: string; color: string }> = {
  normal: { label: "Норма", color: "var(--good)" },
  warning: { label: "Внимание", color: "var(--warning)" },
  critical: { label: "Критично", color: "var(--critical)" },
};

function tooltip(idx: EfficiencyIndex): string {
  const lines = idx.factors.map(
    (f) => `${f.label}: ${Math.round(f.score * 100)} % × вес ${Math.round(f.weight * 100)} % = ${f.points} балл. — ${f.detail}`,
  );
  return [`Индекс ${idx.value} из 100 · ${LEVEL[idx.level].label}`, ...lines].join("\n");
}

export function IndexKpi() {
  const t = useSim((s) => s.state?.t);
  const runId = useSim((s) => s.state?.run_id);
  const [idx, setIdx] = useState<EfficiencyIndex | null>(null);
  const want = useRef<string | null>(null);
  const have = useRef<string | null>(null);
  const busy = useRef(false);

  want.current = t === undefined ? null : `${runId}:${t}`;

  useEffect(() => {
    let alive = true;
    const tick = () => {
      const key = want.current;
      if (busy.current || key === null || key === have.current) return;
      busy.current = true;
      api
        .index()
        .then((res) => {
          if (!alive) return;
          have.current = key;
          setIdx(res);
        })
        .catch(() => {
          /* сеть или сервер недоступны — покажем последнее значение */
        })
        .finally(() => {
          busy.current = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const level = idx ? LEVEL[idx.level] : null;
  const drag = idx?.drag.map((k) => idx.factors.find((f) => f.key === k)?.label).filter(Boolean) ?? [];

  return (
    <div className="kpi kpi-index" title={idx ? tooltip(idx) : "Индекс эффективности участка"}>
      <span className="kpi-label">Индекс участка</span>
      <span className="kpi-value">
        {idx ? Math.round(idx.value) : "—"}
        {level && (
          <span className="kpi-index-level" style={{ color: level.color }}>
            <span className="dot" style={{ background: level.color }} />
            {level.label}
          </span>
        )}
      </span>
      {drag.length > 0 && <span className="kpi-index-drag">тянет вниз: {drag.join(", ").toLowerCase()}</span>}
    </div>
  );
}
