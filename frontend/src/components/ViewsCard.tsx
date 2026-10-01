import { useEffect, useState } from "react";
import { GanttChart } from "../charts/GanttChart";
import { TimeGraph } from "../charts/TimeGraph";

type View = "graph" | "gantt" | "both";

function wide(): boolean {
  return window.matchMedia("(min-width: 1760px)").matches;
}

function readView(): View {
  try {
    const v = localStorage.getItem("bagdar-view");
    if (v === "graph" || v === "gantt" || v === "both") return v;
  } catch {
    /* хранилище недоступно */
  }
  return wide() ? "both" : "graph";
}

export function ViewsCard() {
  const [view, setView] = useState<View>(readView);
  useEffect(() => {
    try {
      localStorage.setItem("bagdar-view", view);
    } catch {
      /* хранилище недоступно */
    }
  }, [view]);
  return (
    <section className="card views-card" aria-label="График движения и занятость ресурсов">
      <div className="card-head">
        <span className="card-title">
          {view === "gantt" ? "Занятость путей и перегонов" : view === "graph" ? "График движения" : "График движения · занятость путей"}
        </span>
        <span className="card-sub">план, факт и прогноз; конфликт подсвечивается до того, как случится</span>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Что показать">
          <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>График</button>
          <button aria-pressed={view === "gantt"} onClick={() => setView("gantt")}>Гант</button>
          <button aria-pressed={view === "both"} onClick={() => setView("both")}>Оба</button>
        </div>
      </div>
      <div className={`views-grid views-${view}`}>
        {view !== "gantt" && <TimeGraph />}
        {view !== "graph" && <GanttChart />}
      </div>
    </section>
  );
}
