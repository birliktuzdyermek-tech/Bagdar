import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { HistoryInfo } from "../api/types";
import { RecordButton } from "../components/RecordButton";
import { hhmm } from "../lib/format";
import { rewindTo } from "../lib/rewind";
import { go } from "../lib/route";
import { useSim } from "../store/sim";

const KEY = new Set(["scenario_loaded", "incident", "incident_resolved", "decision", "plan_proposed", "settings",
  "index_status", "train_held"]);
const ICON: Record<string, string> = {
  scenario_loaded: "▶", incident: "⚠", incident_resolved: "✓", decision: "◆", plan_proposed: "?", settings: "⚙",
  index_status: "◎", train_held: "⏸",
};

/** Разбор: хронология прогона с перемоткой, отчёт PDF, CSV и запись видео. */
export function ReviewPage() {
  const events = useSim((s) => (s.live?.events ?? s.events));
  const t = useSim((s) => (s.live?.state ?? s.state)?.t ?? 0);
  const world = useSim((s) => s.world);
  const setError = useSim((s) => s.setError);
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const [onlyMain, setOnlyMain] = useState(true);

  useEffect(() => {
    api.history().then(setInfo).catch((e) => setError(String(e.message ?? e)));
  }, [setError, Math.floor(t / 60)]);

  const list = useMemo(() => events.filter((e) => KEY.has(e.kind) && (!onlyMain || e.severity !== "debug"))
    .filter((e) => !onlyMain || e.kind !== "train_held").slice(-200).reverse(), [events, onlyMain]);

  const jump = async (at: number) => {
    try {
      go("dispatcher");
      await rewindTo(at);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page review">
      <header className="page-head">
        <h1>Разбор прогона</h1>
        <p className="lead">
          Всё, что случилось на участке, записано в неизменяемый журнал. Нажмите на любое событие, чтобы
          перемотать к нему экран диспетчера: схема, графики, индекс и лента покажут тот момент.
          Отчёт и таблицы собираются из тех же живых данных.
        </p>
      </header>
      <div className="review-grid">
        <section className="card">
          <div className="card-head"><span className="card-title">Отчёт и данные</span>
            <span className="card-sub">{world ? `сценарий ${world.scenario_id}, seed ${world.seed}` : ""}</span></div>
          <div className="card-body review-actions">
            <a className="btn btn-primary" href="/api/export/report.pdf" target="_blank" rel="noreferrer">📄 PDF-отчёт за весь прогон</a>
            <a className="btn" href="/api/export/report.pdf?last_min=15" target="_blank" rel="noreferrer">📄 PDF за последние 15 мин</a>
            <a className="btn" href="/api/export/events.csv" download>⬇ CSV: события</a>
            <a className="btn" href="/api/export/events.csv?last_min=15" download>⬇ CSV: события за 15 мин</a>
            <a className="btn" href="/api/export/plan.csv" download>⬇ CSV: план по поездам</a>
            <div className="review-video">
              <RecordButton big />
              <span className="muted small">Запишите экран диспетчера во время сценария — получится видеофайл WebM.</span>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Журнал</span></div>
          <div className="card-body">
            {info ? (
              <dl className="kv">
                <dt>Хранилище</dt><dd>SQLite {info.path === ":memory:" ? "в памяти процесса" : info.path}</dd>
                <dt>Записано</dt><dd>{info.events} событий · {info.snapshots} снимков · {info.plans} планов</dd>
                <dt>Перемотка</dt><dd>{info.window ? `${hhmm(info.window.from)} — ${hhmm(info.window.to)} (${Math.round((info.window.to - info.window.from) / 60)} мин)` : "журнал пуст"}</dd>
              </dl>
            ) : <div className="muted">загрузка…</div>}
            <p className="muted small">Снимок состояния — каждые 10 с модели, последние 90 мин в памяти для перемотки, всё — в SQLite.</p>
          </div>
        </section>
      </div>
      <section className="card chronology">
        <div className="card-head">
          <span className="card-title">Хронология</span>
          <span className="card-sub">{list.length} событий</span>
          <span className="spacer" />
          <label className="small"><input type="checkbox" checked={onlyMain} onChange={(e) => setOnlyMain(e.target.checked)} /> только главное</label>
        </div>
        <ol className="chrono-list">
          {list.map((e) => (
            <li key={e.seq} className={`chrono sev-${e.severity}`}>
              <span className="chrono-t tabular">{hhmm(e.t)}</span>
              <span className="chrono-i" aria-hidden>{ICON[e.kind] ?? "·"}</span>
              <span className="chrono-m">{e.message}</span>
              <button className="btn btn-small" onClick={() => jump(e.t)} disabled={!info?.window || e.t < info.window.from}
                title={info?.window && e.t < info.window.from ? "Старше 90 мин — вне окна перемотки" : "Показать этот момент на экране диспетчера"}>
                ⏪ Перемотать сюда
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted">Пока ничего не произошло. Запустите сценарий.</li>}
        </ol>
      </section>
    </div>
  );
}
