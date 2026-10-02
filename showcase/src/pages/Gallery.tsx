import { useMemo, useState } from "react";
import { GROUPS, MODE_LABEL, SITUATIONS, type Mode, type Situation } from "../data/situations";
import type { RunInfo } from "../replay/types";
import "./gallery.css";

type Filter = "all" | Mode | "recorded";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "recorded", label: "С записью" },
  { key: "light", label: "Лёгкий" },
  { key: "medium", label: "Средний" },
  { key: "ultra", label: "Ультра" },
];

export function Gallery({ runs }: { runs: RunInfo[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const bySituation = useMemo(() => {
    const m = new Map<number, RunInfo[]>();
    for (const r of runs) if (r.situation) m.set(r.situation, [...(m.get(r.situation) ?? []), r]);
    return m;
  }, [runs]);
  const list = SITUATIONS.filter((s) =>
    filter === "all" ? true : filter === "recorded" ? bySituation.has(s.n) : s.modes.includes(filter),
  );
  return (
    <section className="gallery" aria-labelledby="gallery-title">
      <h1 id="gallery-title">Ситуации</h1>
      <p className="lead">
        17 проектных ситуаций для Бағдара. Там, где есть запись, ссылка открывает связанный настоящий прогон; описание карточки не является отчётом о нём.
        Остальные ситуации помечены «скоро»: записи появятся, когда Ядро научится моделировать эти сбои.
      </p>
      <div className="filters" role="group" aria-label="Фильтр ситуаций">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} className={`btn ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
            {f.key === "recorded" && ` · ${bySituation.size}`}
          </button>
        ))}
      </div>
      <ul className="sit-cards">
        {list.map((s) => (
          <SituationCard key={s.n} s={s} runs={bySituation.get(s.n) ?? []} />
        ))}
      </ul>
    </section>
  );
}

function SituationCard({ s, runs }: { s: Situation; runs: RunInfo[] }) {
  const has = runs.length > 0;
  return (
    <li className={`sit-card ${has ? "has-run" : "soon"}`}>
      <div className="sit-head">
        <span className="sit-n">{s.n}</span>
        <h2 className="sit-title">{s.title}</h2>
      </div>
      <div className="sit-tags">
        <span className="badge">{GROUPS[s.group]}</span>
        {s.modes.map((m) => (
          <span key={m} className="badge">
            {MODE_LABEL[m]} режим
          </span>
        ))}
      </div>
      <dl className="sit-body">
        <dt>Что происходит</dt>
        <dd>{s.what}</dd>
        <dt>Почему человек не справится</dt>
        <dd>{s.human}</dd>
        <dt>Что делает Бағдар</dt>
        <dd>{s.bagdar}</dd>
      </dl>
      <div className="sit-foot">
        {has ? (
          <>
            {runs.map((r) => (
              <div key={r.id} className="sit-run-link">
                <a className="btn btn-primary" href={`#/play/${r.id}`} title="Проиграть запись настоящего прогона">
                  ▶ Запись: {r.title}
                </a>
                {r.note && <small className="muted">{r.note}</small>}
                {(r.injected ?? []).map((event) => (
                  <small key={`${event.at}-${event.train_id}`} className="muted">
                    В записи: внешняя задержка поезда {event.train_id} на {event.minutes} мин в {event.at}. Описание ситуации и действий выше — проектный сценарий, не результат этого прогона.
                  </small>
                ))}
              </div>
            ))}
          </>
        ) : (
          <span className="badge badge-soon" title="Ядро пока не моделирует этот сбой, записи нет">
            ⏳ скоро
          </span>
        )}
      </div>
    </li>
  );
}
