import { useEffect, useMemo, useState } from "react";
import { Player } from "./player/Player";
import { loadReplay, loadRunList } from "./replay/load";
import { ReplayModel } from "./replay/model";
import type { RunInfo } from "./replay/types";
import { Header } from "./ui/Header";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function useProjector(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem("bagdar.projector") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("projector", on);
    try {
      localStorage.setItem("bagdar.projector", on ? "1" : "0");
    } catch {
      /* хранилище недоступно — режим просто не запомнится */
    }
  }, [on]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "p" || e.key === "P" || e.key === "з" || e.key === "З") setOn((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [on, () => setOn((v) => !v)];
}

export function App() {
  const route = useHashRoute();
  const [projector, toggleProjector] = useProjector();
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRunList().then(setRuns, (e: Error) => setError(e.message));
  }, []);

  const playId = /^#\/play\/([\w-]+)/.exec(route)?.[1] ?? null;

  return (
    <div className="app">
      <Header projector={projector} onProjector={toggleProjector} />
      <main className="main" id="main">
        {error && <p className="error">⚠ {error}</p>}
        {!runs && !error && <p className="muted">Загружаю список записей…</p>}
        {runs && playId && <PlayRoute runs={runs} id={playId} projector={projector} />}
        {runs && !playId && <RunList runs={runs} />}
      </main>
      <footer className="footer">
        <span>Консультативный прототип — не система управления движением.</span>
        <span>Данные синтетические, веса и деньги в условных единицах.</span>
      </footer>
    </div>
  );
}

function RunList({ runs }: { runs: RunInfo[] }) {
  return (
    <section className="runs" aria-labelledby="runs-title">
      <h1 id="runs-title">Записи прогонов</h1>
      <p className="lead">
        Каждая запись — настоящий прогон симулятора и планировщика Ядра, снятый шаг за шагом. Витрина ничего не досчитывает и не
        дорисовывает: она проигрывает файл.
      </p>
      <ul className="run-cards">
        {runs.map((r) => (
          <li key={r.id}>
            <a className="run-card" href={`#/play/${r.id}`}>
              <span className="badge badge-rec">
                <span className="rec-dot" aria-hidden /> Запись прогона
              </span>
              <span className="run-card-title">{r.title}</span>
              <span className="muted">
                seed {r.seed} · {r.from}–{r.to} модели{r.situation ? ` · ситуация ${r.situation}` : ""}
              </span>
              {(r.injected ?? []).map((d) => (
                <span key={d.at} className="muted small">
                  ⚑ {d.at}: внешняя задержка поезда на {d.minutes} мин
                </span>
              ))}
              <span className="run-card-cta">Смотреть ▶</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlayRoute({ runs, id, projector }: { runs: RunInfo[]; id: string; projector: boolean }) {
  const info = runs.find((r) => r.id === id);
  const [model, setModel] = useState<ReplayModel | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!info) return;
    let alive = true;
    setModel(null);
    setError(null);
    loadReplay(info.file, (p) => alive && setProgress(p))
      .then((r) => alive && setModel(new ReplayModel(r)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [info]);
  const title = useMemo(() => info?.title ?? id, [info, id]);
  useEffect(() => {
    document.title = `${title} — Бағдар`;
  }, [title]);

  if (!info) return <p className="error">⚠ Записи «{id}» нет в списке runs/index.json.</p>;
  if (error) return <p className="error">⚠ {error}</p>;
  if (!model)
    return (
      <div className="loading" role="status">
        Загружаю запись «{info.title}»… {progress ? `${Math.round(progress * 100)} %` : ""}
        <span className="loading-bar">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      </div>
    );
  return <Player model={model} info={info} projector={projector} />;
}
