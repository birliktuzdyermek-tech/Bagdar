import { useCallback, useEffect, useMemo, useState } from "react";
import { MeetScene } from "../meet/MeetScene";
import { withDefaults, type Cargo, type FreightClass, type MeetOption, type MeetParams, type MeetParamsPatch, type MeetResult, type OptionId, type PaxClass } from "../meet/model";
import presetsRaw from "../meet/presets.json";
import { useMeet } from "../meet/useMeet";
import "./meet.css";

interface Preset { id: string; title: string; story: string; params: MeetParamsPatch }
const PRESETS = presetsRaw as Preset[];

const PAX_CLS: [PaxClass, string][] = [["high_speed_passenger", "Скоростной"], ["fast_passenger", "Скорый"], ["passenger", "Пассажирский"]];
const FR_CLS: [FreightClass, string][] = [["express_freight", "Ускоренный"], ["freight", "Грузовой"], ["local_freight", "Сборный"]];
const CARGO: [Cargo, string][] = [["urgent", "срочный"], ["perishable", "скоропортящийся"], ["deadline", "кончается срок доставки"], ["dangerous", "опасный"]];

const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const money = (x: number) => `${nf0.format(Math.round(x))} у.е.`;
const mins = (s: number) => `${nf1.format(Math.round(s / 6) / 10)} мин`;
const opt = (r: MeetResult, id: OptionId) => r.options.find((o) => o.id === id)!;

interface Reason { icon: string; text: string; tone?: "good" | "bad" | "rule" }

function yieldStory(r: MeetResult, o: MeetOption): Reason[] {
  const out: Reason[] = [];
  const p = r.params;
  if (o.yield === "freight") {
    const f = o.freight;
    const tr = r.trains.freight;
    if (f.stopped) {
      out.push({ icon: "⚡", text: `Грузовой ${nf0.format(tr.mass_t)} т тормозит до нуля и снова разгоняется: теряется ${nf0.format(o.kwh.freight)} кВт·ч энергии (E = m·v²/2)${p.freight.uphill ? ", а на подъёме трогать тяжёлый состав вчетверо дороже" : ""} — ${money(o.cost.stop_freight)}` });
      out.push({ icon: "⏸", text: `Стоит ${mins(f.wait_s)}, к следующей станции приходит позже на ${mins(f.extra_s)}: простой локомотива и бригады — ${money(o.cost.idle_freight)}` });
      out.push(f.late_s > 0
        ? { icon: "📦", text: `Запаса по графику не хватает: опоздание на конечной ${mins(f.late_s)} × ${nf1.format(tr.weight)} у.е./мин = ${money(o.cost.delay_freight)}` }
        : { icon: "🛟", tone: "good", text: `У грузового запас ${nf0.format(p.freight.slack_min)} мин по графику — к конечной он всё равно успеет, опоздания нет.` });
    } else out.push({ icon: "✓", tone: "good", text: "Грузовой подходит, когда перегон уже свободен, — ждать не приходится." });
  } else {
    const s = o.pax;
    const tr = r.trains.pax;
    if (s.planned_stop) {
      out.push(s.wait_s > 0
        ? { icon: "🚉", text: `У пассажирского и так стоянка ${nf0.format(p.pax.dwell_min)} мин по графику. Сверх неё он ждёт ${mins(s.wait_s)}.` }
        : { icon: "🚉", tone: "good", text: `У пассажирского и так стоянка ${nf0.format(p.pax.dwell_min)} мин по графику — грузовой проходит, пока идёт посадка. Ждать сверх графика не нужно.` });
    } else if (s.stopped) {
      out.push({ icon: "👥", text: `Пассажирский останавливается на ${mins(s.wait_s)} и разгоняется заново: ${nf0.format(o.pax_person_min)} человеко-минут ожидания, ${nf0.format(o.kwh.pax)} кВт·ч на остановку.` });
    } else out.push({ icon: "✓", tone: "good", text: "Пассажирский подходит, когда перегон уже свободен, — ждать не приходится." });
    if (s.late_s > 0) out.push({ icon: "⏰", text: `Опоздание на конечной ${mins(s.late_s)} × ${nf1.format(tr.weight)} у.е./мин (вес минуты этого поезда) = ${money(o.cost.delay_pax)}` });
    else if (s.extra_s > 0) out.push({ icon: "🛟", tone: "good", text: `Запас по графику ${nf0.format(p.pax.slack_min)} мин покрывает задержку — к конечной поезд успевает.` });
    if (o.pte_excess_min > 0) {
      out.push({ icon: "⚠", tone: "rule", text: `По ПТЭ пассажирский старше. Задержать его ради грузового можно не больше чем на ${nf1.format(tr.tolerance_min)} мин, а здесь задержка ${mins(s.extra_s)} — превышение ${nf1.format(o.pte_excess_min)} мин. Такой план Бағдар отбрасывает при любой экономии.` });
    }
  }
  return out;
}

function Verdict({ r, guess, score }: { r: MeetResult; guess: OptionId | null; score: { right: number; total: number } }) {
  const [perDay, setPerDay] = useState(40);
  const W = opt(r, r.winner);
  const Lo = opt(r, r.winner === "pax_first" ? "freight_first" : "pax_first");
  const winPax = r.winner === "pax_first";
  const econDiff = Lo.econ - W.econ;
  const lawful = r.econ_winner === r.winner;
  const tol = r.trains.pax.tolerance_min;
  const fp = r.trains.pax.factors.map(([n, m]) => `${n} ×${nf1.format(m)}`).join(", ");
  const ff = r.trains.freight.factors.map(([n, m]) => `${n} ×${nf1.format(m)}`).join(", ");
  const max = Math.max(1, ...r.options.map((o) => o.econ));
  return (
    <section className="meet-verdict" aria-live="polite">
      {guess && (
        <p className={`meet-guess ${guess === r.winner ? "ok" : "no"}`}>
          {guess === r.winner ? "🎯 Вы решили как Бағдар!" : "🤔 Бағдар решил иначе — смотрите почему."}
          <span className="muted"> Счёт: {score.right} из {score.total}</span>
        </p>
      )}
      <h2 className="meet-headline">
        <span className={`meet-dot ${winPax ? "pax" : "fr"}`} aria-hidden />
        {winPax ? "Первым — пассажирский" : "Первым — грузовой"}
      </h2>
      {lawful ? (
        <p className="meet-sub">
          Так дешевле на <b>{money(econDiff)}</b> за одну встречу{Lo.pte_excess_min > 0 ? ", а другой порядок ещё и нарушил бы ПТЭ" : ""}.
        </p>
      ) : (
        <p className="meet-sub">
          По деньгам выгоднее было бы пропустить {winPax ? "грузовой" : "пассажирский"} — на <b>{money(-econDiff)}</b> Но тогда
          пассажирский опоздал бы на {nf1.format(Lo.pte_excess_min)} мин сверх допуска ПТЭ ({nf1.format(tol)} мин).
          <b> Правила выше денег</b> — Бағдар такой план не выбирает.
        </p>
      )}

      <div className="meet-bars" role="table" aria-label="Цена двух вариантов">
        {r.options.map((o) => (
          <div key={o.id} className={`meet-bar-row ${o.id === r.winner ? "win" : ""}`} role="row">
            <span className="meet-bar-name" role="cell">{o.id === "pax_first" ? "1. Первым пассажирский" : "2. Первым грузовой"}</span>
            <span className="meet-bar" role="cell" aria-label={`${money(o.econ)}`}>
              {([["delay_pax", "pax"], ["stop_pax", "stop"], ["idle_pax", "idle"], ["delay_freight", "fr"], ["stop_freight", "stop"], ["idle_freight", "idle"]] as const)
                .filter(([k]) => o.cost[k] > 0)
                .map(([k, cls]) => <span key={k} className={`seg ${cls}`} style={{ width: `${(100 * o.cost[k]) / max}%` }} title={`${k}: ${money(o.cost[k])}`} />)}
            </span>
            <span className="meet-bar-sum" role="cell">{money(o.econ)}{o.pte_excess_min > 0 && <span className="meet-pte-tag">ПТЭ ✕</span>}</span>
          </div>
        ))}
        <div className="meet-legend small muted">
          <span><i className="seg pax" />время пассажиров</span><span><i className="seg fr" />время груза</span>
          <span><i className="seg stop" />остановка и разгон</span><span><i className="seg idle" />простой локомотива и бригады</span>
        </div>
      </div>

      <div className="meet-why">
        <div>
          <h3>{lawful ? "Почему" : "Во что обходится"} вариант {r.winner === "pax_first" ? "1" : "2"}{lawful ? " дешевле" : ""}</h3>
          <ul>{yieldStory(r, W).map((x, i) => <li key={i} className={x.tone ?? ""}><span aria-hidden>{x.icon}</span>{x.text}</li>)}</ul>
        </div>
        <div>
          <h3>{lawful ? "Чем плох" : "Почему запрещён"} вариант {r.winner === "pax_first" ? "2" : "1"}</h3>
          <ul>{yieldStory(r, Lo).map((x, i) => <li key={i} className={x.tone ?? ""}><span aria-hidden>{x.icon}</span>{x.text}</li>)}</ul>
        </div>
      </div>

      <p className="meet-weights small">
        <b>Цена минуты</b>: пассажирский — {nf1.format(r.trains.pax.weight)} у.е./мин ({nf0.format(r.trains.pax.base_weight)} за класс{fp ? `; ${fp}` : ""}),
        грузовой — {nf1.format(r.trains.freight.weight)} у.е./мин ({nf0.format(r.trains.freight.base_weight)} за класс{ff ? `; ${ff}` : ""}).
      </p>

      <div className="meet-scale">
        <label>
          Если таких встреч на участке <b>{perDay}</b> в сутки
          <input type="range" min={5} max={120} step={5} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} />
        </label>
        {lawful ? (
          <p>правильный порядок сберегает <b className="big">{money(econDiff * perDay)}</b> в сутки — <b>{money(econDiff * perDay * 365)}</b> в год.</p>
        ) : (
          <p>соблюдение ПТЭ стоит <b>{money(-econDiff * perDay)}</b> в сутки. Это цена пунктуальности пассажиров — Бағдар её платит, а не экономит на людях.</p>
        )}
        <p className="small muted">Условные единицы, «в нашей модели». Веса и тарифы — в настройках симулятора.</p>
      </div>
    </section>
  );
}

function Slider({ label, value, min, max, step = 1, unit, onChange, hint }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="meet-slider">
      <span className="meet-slider-top"><span>{label}</span><b>{nf1.format(value)}{unit ? ` ${unit}` : ""}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
}

function Chips<T extends string>({ items, value, onChange, multi }: { items: [T, string][]; value: T[]; onChange: (v: T[]) => void; multi?: boolean }) {
  return (
    <span className="meet-chips">
      {items.map(([k, l]) => {
        const on = value.includes(k);
        return (
          <button key={k} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on}
            onClick={() => onChange(multi ? (on ? value.filter((x) => x !== k) : [...value, k]) : [k])}>{l}</button>
        );
      })}
    </span>
  );
}

function Controls({ p, set, pte, setPte }: { p: MeetParams; set: (patch: MeetParamsPatch) => void; pte: boolean; setPte: (v: boolean) => void }) {
  const gapText = p.gap_min === 0 ? "одновременно" : p.gap_min > 0 ? `грузовой раньше на ${nf1.format(p.gap_min)} мин` : `пассажирский раньше на ${nf1.format(-p.gap_min)} мин`;
  return (
    <section className="meet-controls-panel" aria-label="Условия встречи">
      <h3>Поменяйте условия — расчёт мгновенный</h3>
      <fieldset>
        <legend><span className="meet-dot pax" aria-hidden />Пассажирский</legend>
        <Chips items={PAX_CLS} value={[p.pax.cls]} onChange={([v]) => set({ pax: { cls: v } })} />
        <Slider label="Пассажиров" value={p.pax.passengers} min={0} max={1500} step={10} onChange={(v) => set({ pax: { passengers: v } })} />
        <Slider label="Стоянка на станции А по графику" value={p.pax.dwell_min} min={0} max={10} unit="мин" onChange={(v) => set({ pax: { dwell_min: v } })} hint="0 — проходит без остановки" />
        <Slider label="Уже опаздывает" value={p.pax.delay_min} min={0} max={30} unit="мин" onChange={(v) => set({ pax: { delay_min: v } })} />
        <Slider label="Запас по графику до конечной" value={p.pax.slack_min} min={0} max={15} unit="мин" onChange={(v) => set({ pax: { slack_min: v } })} />
        <label className="meet-check"><input type="checkbox" checked={p.pax.transfer} onChange={(e) => set({ pax: { transfer: e.target.checked } })} /> у пассажиров пересадка на конечной</label>
      </fieldset>
      <fieldset>
        <legend><span className="meet-dot fr" aria-hidden />Грузовой</legend>
        <Chips items={FR_CLS} value={[p.freight.cls]} onChange={([v]) => set({ freight: { cls: v } })} />
        <Slider label="Масса состава" value={p.freight.mass_t} min={1000} max={9000} step={100} unit="т" onChange={(v) => set({ freight: { mass_t: v } })} />
        <span className="meet-slider-top small"><span>Груз</span></span>
        <Chips items={CARGO} value={p.freight.cargo} multi onChange={(v) => set({ freight: { cargo: v } })} />
        <Slider label="Уже опаздывает" value={p.freight.delay_min} min={0} max={120} step={5} unit="мин" onChange={(v) => set({ freight: { delay_min: v } })} />
        <Slider label="Запас по графику до конечной" value={p.freight.slack_min} min={0} max={60} unit="мин" onChange={(v) => set({ freight: { slack_min: v } })} />
        <Slider label="Бригаде осталось работать" value={p.freight.crew_left_h} min={0.5} max={10} step={0.5} unit="ч" onChange={(v) => set({ freight: { crew_left_h: v } })} />
        <label className="meet-check"><input type="checkbox" checked={p.freight.uphill} onChange={(e) => set({ freight: { uphill: e.target.checked } })} /> станция Б на подъёме — трогаться тяжело</label>
      </fieldset>
      <fieldset>
        <legend>Перегон</legend>
        <Slider label="Длина однопутного перегона" value={p.section_km} min={4} max={30} unit="км" onChange={(v) => set({ section_km: v })} />
        <Slider label="Кто подходит раньше" value={p.gap_min} min={-15} max={15} step={0.5} onChange={(v) => set({ gap_min: v })} hint={gapText} />
        <label className="meet-check"><input type="checkbox" checked={pte} onChange={(e) => setPte(e.target.checked)} /> соблюдать ПТЭ (пассажирский старше грузового)</label>
      </fieldset>
    </section>
  );
}

function Explainer({ r }: { r: MeetResult }) {
  const f = r.trains.freight;
  const pz = r.trains.pax;
  return (
    <section className="meet-explain" aria-labelledby="meet-explain-title">
      <h2 id="meet-explain-title">Из чего складывается цена</h2>
      <p className="muted">Те же слагаемые Бағдар считает для каждого поезда участка, когда строит план, — только пар не одна, а сотни.</p>
      <div className="meet-cards">
        <article><span className="meet-card-ico" aria-hidden>⏱</span><h3>Минута людей дороже минуты груза</h3>
          <p>Скоростной — 100 у.е./мин, скорый — 70, пассажирский — 50, ещё × (пассажиров / 500). Грузовой — 10, срочный груз ×1,5, кончается срок доставки ×2.</p></article>
        <article><span className="meet-card-ico" aria-hidden>⚡</span><h3>Остановить тяжёлый поезд — выбросить энергию</h3>
          <p>E = m·v²/2. Грузовой {nf0.format(f.mass_t)} т на {f.v_kmh} км/ч теряет {nf0.format(f.stop_kwh)} кВт·ч, пассажирский — {nf0.format(pz.stop_kwh)}. Тормозит грузовой {f.brake_s} с, разгоняется {f.accel_s} с. На подъёме остановка ×4.</p></article>
        <article><span className="meet-card-ico" aria-hidden>🛟</span><h3>Запас по графику</h3>
          <p>В графике есть резерв. Ожидание в пределах запаса — не опоздание. Поэтому иногда грузовому постоять почти бесплатно, а иногда нет.</p></article>
        <article><span className="meet-card-ico" aria-hidden>📜</span><h3>Правила выше денег</h3>
          <p>По ПТЭ пассажирский старше. Задержать его ради грузового можно лишь в пределах допуска: скоростной 2 мин, скорый 3, пассажирский 5. Сверх допуска — 5 000 у.е. за минуту, такой план не проходит.</p></article>
        <article><span className="meet-card-ico" aria-hidden>👷</span><h3>Простой и бригада</h3>
          <p>Локомотив с бригадой стоит {r.constants.c_idle} у.е. в минуту. Если смена бригады вот-вот кончится, минута задержки грузового стоит вдвое дороже.</p></article>
        <article><span className="meet-card-ico" aria-hidden>🧭</span><h3>Бағдар выбирает минимум</h3>
          <p>Сначала безопасность и ПТЭ, потом деньги. Из всех порядков — самый дешёвый допустимый. И показывает почему, как здесь.</p></article>
      </div>
    </section>
  );
}

export function Meet() {
  const [presetId, setPresetId] = useState<string>(PRESETS[0].id);
  const [params, setParams] = useState<MeetParams>(() => withDefaults(PRESETS[0].params));
  const [pte, setPte] = useState(true);
  const [quiz, setQuiz] = useState(true);
  const [guess, setGuess] = useState<OptionId | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [runKey, setRunKey] = useState("usual-0");
  const [score, setScore] = useState({ right: 0, total: 0 });
  const { res, source } = useMeet(params, pte);
  const preset = PRESETS.find((p) => p.id === presetId);

  useEffect(() => {
    document.title = "Кто первым? — Бағдар";
  }, []);

  const choose = (id: string) => {
    const pr = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setParams(withDefaults(pr.params));
    setGuess(null);
    setRevealed(false);
    setRunKey(`${id}-${Date.now()}`);
  };

  const set = useCallback((patch: MeetParamsPatch) => {
    setPresetId("custom");
    setQuiz(false);
    setRevealed(true);
    setParams((p) => withDefaults({
      section_km: patch.section_km ?? p.section_km, speed_limit_kmh: patch.speed_limit_kmh ?? p.speed_limit_kmh,
      gap_min: patch.gap_min ?? p.gap_min, pax: { ...p.pax, ...(patch.pax ?? {}) }, freight: { ...p.freight, ...(patch.freight ?? {}) },
    }));
  }, []);

  const answer = (g: OptionId | null) => {
    if (g) {
      setGuess(g);
      setScore((s) => ({ right: s.right + (g === res.winner ? 1 : 0), total: s.total + 1 }));
    } else setQuiz(false);
    setRunKey(`${presetId}-${Date.now()}`);
  };

  const asking = quiz && guess === null && presetId !== "custom";
  const showVerdict = revealed || presetId === "custom";
  const onReveal = useCallback(() => setRevealed(true), []);
  const story = presetId === "custom" ? "Свои условия: двигайте ползунки — оба варианта пересчитываются сразу." : preset?.story ?? "";

  const srcText = useMemo(() => (source === "server"
    ? "посчитано сервером Бағдара — та же функция цены, что у планировщика"
    : "посчитано в браузере — копия формулы ядра, совпадение проверено тестом"), [source]);

  return (
    <div className="meet-page">
      <section className="meet-hero">
        <p className="meet-kicker">Главная задача диспетчера — за 30 секунд</p>
        <h1>Кто поедет первым?</h1>
        <p className="meet-lead">
          Путь один. Навстречу друг другу идут <b className="pax">пассажирский с людьми</b> и <b className="fr">тяжёлый грузовой</b>.
          Разъехаться можно только на станции — кто-то должен ждать. Кого остановить, чтобы потерять меньше?
        </p>
      </section>

      <nav className="meet-presets" aria-label="Примеры">
        {PRESETS.map((p, i) => (
          <button key={p.id} type="button" className={`meet-preset ${p.id === presetId ? "on" : ""}`} onClick={() => choose(p.id)}>
            <span className="meet-preset-n">{i + 1}</span>{p.title}
          </button>
        ))}
        {presetId === "custom" && <span className="meet-preset on custom">✎ Свои условия</span>}
        <span className="spacer" />
        <label className="meet-check meet-quiz-toggle">
          <input type="checkbox" checked={quiz} onChange={(e) => { setQuiz(e.target.checked); setGuess(null); if (e.target.checked && presetId !== "custom") { setRevealed(false); setRunKey(`${presetId}-${Date.now()}`); } }} />
          🎯 Решать самому
        </label>
      </nav>

      <p className="meet-story">{story}</p>

      <div className="meet-stage">
        <MeetScene res={res} runKey={runKey} paused={asking} onReveal={onReveal} revealed={presetId === "custom"} />
        {asking && (
          <div className="meet-quiz" role="dialog" aria-label="Решите сами">
            <p className="meet-quiz-q">Решите сами: кого пропустить первым?</p>
            <div className="meet-quiz-opts">
              <button type="button" className="meet-quiz-btn pax" onClick={() => answer("pax_first")}>
                <span className="ico" aria-hidden>🚆</span><b>Пассажирский</b><span>грузовой подождёт</span>
              </button>
              <button type="button" className="meet-quiz-btn fr" onClick={() => answer("freight_first")}>
                <span className="ico" aria-hidden>🚂</span><b>Грузовой</b><span>пассажирский подождёт</span>
              </button>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => answer(null)}>Просто покажите</button>
          </div>
        )}
      </div>
      <p className="meet-source small"><span className={`meet-src-dot ${source}`} aria-hidden />{srcText}</p>

      <div className="meet-grid">
        {showVerdict ? <Verdict r={res} guess={guess} score={score} />
          : <section className="meet-verdict waiting"><h2 className="meet-headline">Смотрим оба варианта…</h2>
            <p className="muted">Ответ Бағдара появится, когда уступающий поезд тронется. Счётчики над сценой уже показывают, во что обходится каждая минута.</p></section>}
        <Controls p={params} set={set} pte={pte} setPte={(v) => { setPte(v); setPresetId("custom"); setQuiz(false); setRevealed(true); }} />
      </div>

      <Explainer r={res} />

      <p className="meet-foot small muted">
        Консультативный прототип: сигналами и стрелками не управляет. Расчёт — модуль ядра <code>bagdar/meet.py</code> (те же веса,
        энергия остановки и правило ПТЭ, что у планировщика), цифры условные. На живом участке Бағдар решает такие встречи
        десятками в час — в симуляторе это карточки «Скрещение» и «Обгон».
      </p>
    </div>
  );
}
