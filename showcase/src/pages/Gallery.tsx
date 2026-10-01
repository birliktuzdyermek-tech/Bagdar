import { useMemo, useState } from "react";
import { GROUPS, MODE_LABEL, SITUATIONS, type Mode, type Situation } from "../data/situations";
import type { RunInfo } from "../replay/types";

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
        17 ситуаций, с которыми человек-диспетчер не справляется в одиночку. Карточка с записью проигрывает настоящий прогон. Карточка
        без записи помечена «скоро»: её покажем, когда Ядро научится моделировать этот сбой.
      </p>
      <div className="filters" role="radiogroup" aria-label="Фильтр ситуаций">
        {FILTERS.map((f) => (
          <button key={f.key} role="radio" aria-checked={filter === f.key} className={`btn ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
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
          runs.map((r) => (
            <a key={r.id} className="btn btn-primary" href={`#/play/${r.id}`} title="Проиграть запись настоящего прогона">
              ▶ Запись: {r.title}
            </a>
          ))
        ) : (
          <span className="badge badge-soon" title="Ядро пока не моделирует этот сбой, записи нет">
            ⏳ скоро
          </span>
        )}
      </div>
    </li>
  );
}
