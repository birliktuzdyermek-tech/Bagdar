import { useEffect, useState } from "react";
import { connectStream, disconnectStream } from "./api/stream";
import { IndexPanel } from "./charts/IndexPanel";
import { DecisionsPanel } from "./components/DecisionsPanel";
import { DisruptionPanel } from "./components/DisruptionPanel";
import { EventFeed } from "./components/EventFeed";
import { LineScheme, SchemeLegend } from "./components/LineScheme";
import { StationDetail } from "./components/StationDetail";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { TrainDetail } from "./components/TrainDetail";
import { ViewsCard } from "./components/ViewsCard";
import { NavBar } from "./components/NavBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { useRoute } from "./lib/route";
import { ScenariosPage } from "./pages/ScenariosPage";
import { ReviewPage } from "./pages/ReviewPage";
import { VersusPage } from "./pages/VersusPage";
import { GuidedTour } from "./components/GuidedTour";
import { go } from "./lib/route";
import { RewindBar } from "./components/RewindBar";
import { usePlanSync } from "./store/plans";
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
  const route = useRoute();
  const [settings, setSettings] = useState(false);
  const [tour, setTour] = useState(false);

  usePlanSync();
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
    <div className={`app route-${route}`}>
      <TopBar />
      <NavBar route={route} onSettings={() => setSettings(true)} onTour={() => { go("dispatcher"); setTour(true); }} />
      {route === "dispatcher" && <Toolbar theme={theme} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />}
      {route === "dispatcher" && <RewindBar />}
      {route === "scenarios" && <ScenariosPage />}
      {route === "review" && <ReviewPage />}
      {route === "versus" && <VersusPage />}
      {route === "dispatcher" && <main className="main">
        {conn === "closed" && (
          <div className="banner main-banner" role="alert">
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
        <ViewsCard />
        <div className="bottom-row">
          <DisruptionPanel />
          <TrainDetail />
          <StationDetail />
          <EventFeed />
        </div>
        <aside className="side">
          <IndexPanel />
          <DecisionsPanel />
        </aside>
      </main>}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {tour && route === "dispatcher" && <GuidedTour onClose={() => setTour(false)} />}
      {error && (
        <div className="error-toast" role="alert">
          Ошибка: {error}{" "}
          <button className="btn" onClick={() => setError(null)} style={{ marginLeft: 8 }}>Закрыть</button>
        </div>
      )}
    </div>
  );
}
