import { useEffect, useState } from "react";
import { connectStream, disconnectStream } from "./api/stream";
import { DecisionsPanel } from "./components/DecisionsPanel";
import { EventFeed } from "./components/EventFeed";
import { LineScheme, SchemeLegend } from "./components/LineScheme";
import { StationDetail } from "./components/StationDetail";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { TrainDetail } from "./components/TrainDetail";
import { useSim } from "./store/sim";

function PerfChip() {
  const perf = useSim((s) => s.state?.perf);
  if (!perf) return null;
  return (
    <span className="chip" title="Время одного шага модели на сервере и число шагов модели в секунду">
      шаг модели {perf.step_us.toFixed(0)} мкс · {Math.round(perf.steps_per_s)} шаг/с
    </span>
  );
}

function readTheme(): string {
  try {
    return localStorage.getItem("bagdar-theme") ?? "dark";
  } catch {
    return "dark";
  }
}

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  const conn = useSim((s) => s.conn);
  const world = useSim((s) => s.world);
  const error = useSim((s) => s.error);
  const setError = useSim((s) => s.setError);

  useEffect(() => {
    connectStream();
    return () => disconnectStream();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("bagdar-theme", theme);
    } catch {
      /* хранилище недоступно */
    }
  }, [theme]);

  return (
    <div className="app">
      <TopBar />
      <Toolbar theme={theme} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
      <main className="main">
        {conn === "closed" && (
          <div className="banner" style={{ gridColumn: "1 / -1", borderRadius: 8 }} role="alert">
            Нет связи с сервером симуляции — переподключение…
          </div>
        )}
        <section className="card scheme-card" aria-label="Схема участка">
          <div className="card-head">
            <span className="card-title">Схема участка</span>
            <span className="card-sub">
              {world ? `${world.name} · ${world.stations.length} раздельных пунктов · ${world.sections.length} перегонов · seed ${world.seed}` : ""}
            </span>
            <div className="spacer" />
            <span className="card-sub">Схема не в масштабе. Клик по станции — путевое развитие, по поезду — подробности.</span>
            <PerfChip />
          </div>
          <LineScheme />
          <SchemeLegend />
        </section>
        <DecisionsPanel />
        <TrainDetail />
        <StationDetail />
        <EventFeed />
      </main>
      {error && (
        <div className="error-toast" role="alert">
          Ошибка: {error}{" "}
          <button className="btn" onClick={() => setError(null)} style={{ marginLeft: 8 }}>Закрыть</button>
        </div>
      )}
    </div>
  );
}
