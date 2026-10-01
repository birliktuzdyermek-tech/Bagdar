import { useMemo, useState } from "react";
import { clock } from "../lib/format";
import { useSim } from "../store/sim";

const ICON: Record<string, { ch: string; color: string; label: string }> = {
  critical: { ch: "■", color: "var(--critical)", label: "критично" },
  warn: { ch: "▲", color: "var(--warning)", label: "внимание" },
  info: { ch: "●", color: "var(--accent)", label: "информация" },
  debug: { ch: "·", color: "var(--text-muted)", label: "движение" },
};

export function EventFeed() {
  const events = useSim((s) => s.events);
  const selectTrain = useSim((s) => s.selectTrain);
  const selectStation = useSim((s) => s.selectStation);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const f = all ? events : events.filter((e) => e.severity !== "debug");
    return f.slice(-300).reverse();
  }, [events, all]);

  return (
    <section className="card feed-card" aria-label="Лента событий">
      <div className="card-head">
        <span className="card-title">Лента событий</span>
        <span className="card-sub">{shown.length} из {events.length}</span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Фильтр ленты">
          <button aria-pressed={!all} onClick={() => setAll(false)}>Важные</button>
          <button aria-pressed={all} onClick={() => setAll(true)}>Все</button>
        </div>
      </div>
      <div className="card-body">
        {shown.length === 0 ? (
          <div className="empty">{all ? "Событий пока нет" : "Важных событий пока нет. Движение по графику."}</div>
        ) : (
          <ul className="feed" aria-live="polite">
            {shown.map((e) => {
              const ic = ICON[e.severity] ?? ICON.info;
              const clickable = Boolean(e.train_id || e.station_id);
              return (
                <li
                  key={e.seq}
                  className={clickable ? "clickable" : ""}
                  onClick={() => {
                    if (e.train_id) selectTrain(e.train_id);
                    if (e.station_id) selectStation(e.station_id);
                  }}
                >
                  <time className="tabular">{clock(e.t, false)}</time>
                  <span className="sev-icon" style={{ color: ic.color }} aria-label={ic.label}>{ic.ch}</span>
                  <span>{e.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
