// Рабочее время бригад: кто по плану не доедет до пункта смены до конца смены.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CrewRisks } from "../api/types";
import { hhmm } from "../lib/format";
import { useSim } from "../store/sim";

export function CrewBox() {
  const [data, setData] = useState<CrewRisks | null>(null);
  const t = useSim((s) => s.state?.t ?? 0);
  const runId = useSim((s) => s.state?.run_id ?? "");
  const selectTrain = useSim((s) => s.selectTrain);
  const last = useRef(-Infinity);

  useEffect(() => {
    if (performance.now() - last.current < 4000) return;
    last.current = performance.now();
    api.crew().then(setData).catch(() => {});
  }, [t, runId]);

  if (!data) return null;
  const risks = data.risks;
  return (
    <div className={`crew-box ${risks.length ? (risks[0].status === "critical" ? "st-critical" : "st-warning") : "st-ok"}`} role="status">
      <div className="crew-head">
        <b>Рабочее время бригад</b>
        <span className="muted small">{risks.length ? `${risks.length} ${risks.length === 1 ? "поезд" : "поезда"} под риском` : "все бригады доедут до смены с запасом"}</span>
      </div>
      {risks.length > 0 && (
        <ul className="crew-list">
          {risks.slice(0, 3).map((r) => (
            <li key={r.train_id} className={`crew-item ${r.status}`} onClick={() => selectTrain(r.train_id)} title={r.hint}>
              <span className={`badge ${r.status === "critical" ? "badge-critical" : "badge-warning"}`}>№ {r.number}</span>
              <span className="crew-text">
                {r.text}
                <span className="muted small"> До ст. {r.target_station} по плану в {hhmm(r.arr)}; смена до {hhmm(r.shift_end)}.</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {risks.length > 0 && <div className="small muted crew-hint">{risks[0].hint}</div>}
    </div>
  );
}
