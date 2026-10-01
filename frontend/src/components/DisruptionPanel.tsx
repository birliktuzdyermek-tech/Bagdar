// Сбои и сценарий: кнопки нештатных ситуаций, действующие сбои с таймером
// восстановления и ближайшее событие сценария. Всё уходит на backend как
// внешнее событие — модель меняется, план пересчитывается, появляется разбор.
import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { EventIn, IncidentActive } from "../api/types";
import { clock } from "../lib/format";
import { useSim } from "../store/sim";
import { WindowPlanner } from "./WindowPlanner";

const NO_INCIDENTS: IncidentActive[] = [];   // стабильная ссылка: новый [] в селекторе zustand зацикливает рендер

type Kind = EventIn["type"];

const KINDS: { key: Kind; label: string; hint: string }[] = [
  { key: "section_closed", label: "Закрыть перегон", hint: "Перегон между двумя станциями закрыт — поезда через него не пройдут. Самый наглядный сбой: Бағдар предложит варианты с ценой" },
  { key: "signal_fault", label: "Отказ светофора", hint: "Светофор на перегоне не работает: ехать можно, но по одному и не быстрее 40 км/ч" },
  { key: "switch_fault", label: "Отказ стрелки", hint: "На станции сломалась стрелка — боковой путь недоступен, принимать поезда негде" },
  { key: "track_unavailable", label: "Путь недоступен", hint: "Один путь станции закрыт (например, на осмотр)" },
  { key: "speed_restriction", label: "Ограничение скорости", hint: "На перегоне нельзя быстрее указанной скорости" },
  { key: "train_delay", label: "Задержать поезд", hint: "Выбранный на схеме поезд опоздает на столько минут" },
  { key: "add_trains", label: "Рост потока", hint: "Лишние грузовые поезда, которых не было в графике" },
  { key: "extra_train", label: "Внеочередной поезд", hint: "Восстановительный поезд — идёт первым, все остальные его пропускают" },
  { key: "crew_short", label: "Бригада на исходе", hint: "У бригады выбранного поезда остаётся столько минут смены. Бағдар проверит по плану, доедет ли она до смены, и поднимет приоритет поезда" },
];

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

export function DisruptionPanel() {
  const world = useSim((s) => s.world);
  const idx = useSim((s) => s.idx);
  const t = useSim((s) => s.state?.t ?? 0);
  const past = useSim((s) => s.past !== null);
  const active = useSim((s) => s.state?.incidents ?? NO_INCIDENTS);
  const nextRaw = useSim((s) => s.state?.scenario_next ?? null);
  const next = nextRaw ? { t: Number(nextRaw.t), kind: String(nextRaw.kind) } : null;
  const selectedTrain = useSim((s) => s.selectedTrain);
  const selectedStation = useSim((s) => s.selectedStation);
  const setError = useSim((s) => s.setError);
  const [kind, setKind] = useState<Kind>("section_closed");
  const [section, setSection] = useState("");
  const [station, setStation] = useState("");
  const [track, setTrack] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [unknown, setUnknown] = useState(false);
  const [kmh, setKmh] = useState("40");
  const [count, setCount] = useState("4");
  const [dir, setDir] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sections = useMemo(() => {
    if (!world || !idx) return [];
    return [...world.sections]
      .sort((a, b) => (idx.stations.get(a.a)?.km ?? 0) - (idx.stations.get(b.a)?.km ?? 0))
      .map((s) => ({ id: s.id, label: `${idx.stations.get(s.a)?.name} — ${idx.stations.get(s.b)?.name} (${s.tracks === 1 ? "1 путь" : "2 пути"})` }));
  }, [world, idx]);
  const st = station || selectedStation || "";
  const stObj = st ? idx?.stations.get(st) : undefined;
  const sec = section || sections[Math.floor(sections.length / 2)]?.id || "";
  const trk = track || stObj?.tracks.find((x) => !x.is_main)?.id || "";
  const train = selectedTrain ? idx?.trains.get(selectedTrain) : undefined;

  const body = (): EventIn | null => {
    const m = unknown && kind === "section_closed" ? null : Number(minutes) || 30;
    switch (kind) {
      case "section_closed":
      case "signal_fault":
        return { type: kind, section_id: sec, minutes: m };
      case "speed_restriction":
        return { type: kind, section_id: sec, minutes: m, kmh: Number(kmh) || 40 };
      case "switch_fault":
        return st ? { type: kind, station_id: st, minutes: m } : null;
      case "track_unavailable":
        return trk ? { type: kind, track_id: trk, minutes: m } : null;
      case "train_delay":
        return selectedTrain ? { type: kind, train_id: selectedTrain, minutes: Number(minutes) || 10 } : null;
      case "crew_short":
        return selectedTrain ? { type: kind, train_id: selectedTrain, minutes: Number(minutes) || 40 } : null;
      case "add_trains":
        return { type: kind, count: Number(count) || 4, within_min: Number(minutes) || 30 };
      case "extra_train":
        return { type: kind, direction: Number(dir), in_min: 3 };
      default:
        return null;
    }
  };

  const apply = async () => {
    const b = body();
    if (!b) {
      setError(kind === "train_delay" || kind === "crew_short" ? "Выберите поезд на схеме или графике" : "Выберите станцию на схеме");
      return;
    }
    setBusy(true);
    try {
      const r = await api.event(b);
      setMsg(r.message);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    try {
      const r = await api.restore(id);
      setMsg(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const needsSection = kind === "section_closed" || kind === "signal_fault" || kind === "speed_restriction";
  const needsDuration = kind !== "extra_train";
  const durLabel = kind === "train_delay" ? "мин задержки" : kind === "add_trains" ? "за мин" : kind === "crew_short" ? "мин до конца смены" : "мин";
  const [windowOpen, setWindowOpen] = useState(false);

  return (
    <section className={`card disrupt-card ${windowOpen ? "expanded" : ""}`} aria-label="Сбои и сценарий">
      <div className="card-head">
        <span className="card-title">Сбои — сломайте сами</span>
        <span className="card-sub">выберите, что сломать, и нажмите «Применить»: Бағдар за 1–2 с перестроит план, справа появится разбор</span>
      </div>
      <div className="card-body">
        <div className="seg seg-wrap" role="group" aria-label="Тип сбоя">
          {KINDS.map((k) => (
            <button key={k.key} aria-pressed={kind === k.key} onClick={() => setKind(k.key)} title={k.hint}>{k.label}</button>
          ))}
        </div>
        <div className="disrupt-form">
          {needsSection && (
            <label className="field">
              Перегон
              <select className="input" value={sec} onChange={(e) => setSection(e.target.value)}>
                {sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          )}
          {(kind === "switch_fault" || kind === "track_unavailable") && (
            <label className="field">
              Станция
              <select className="input" value={st} onChange={(e) => { setStation(e.target.value); setTrack(""); }}>
                <option value="">— выберите —</option>
                {world?.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {kind === "track_unavailable" && stObj && (
            <label className="field">
              Путь
              <select className="input" value={trk} onChange={(e) => setTrack(e.target.value)}>
                {stObj.tracks.map((x) => <option key={x.id} value={x.id}>{x.name}{x.is_main ? " гл." : ""} · {x.length_m} м</option>)}
              </select>
            </label>
          )}
          {(kind === "train_delay" || kind === "crew_short") && (
            <span className="field">{train ? `Поезд ${train.number} · ${train.cls_label}` : "Выберите поезд на схеме"}</span>
          )}
          {kind === "speed_restriction" && (
            <label className="field">км/ч <input className="input input-num" value={kmh} onChange={(e) => setKmh(e.target.value.replace(/\D/g, ""))} /></label>
          )}
          {kind === "add_trains" && (
            <label className="field">поездов <input className="input input-num" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} /></label>
          )}
          {kind === "extra_train" && (
            <label className="field">
              Направление
              <select className="input" value={dir} onChange={(e) => setDir(e.target.value)}>
                <option value="1">нечётное (от {world?.stations[0]?.name})</option>
                <option value="-1">чётное (от {world?.stations[world.stations.length - 1]?.name})</option>
              </select>
            </label>
          )}
          {needsDuration && (
            <label className="field">
              <input className="input input-num" value={minutes} disabled={unknown && kind === "section_closed"}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} /> {durLabel}
            </label>
          )}
          {kind === "section_closed" && (
            <label className="field small"><input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> срок неизвестен</label>
          )}
          <button className="btn btn-primary btn-small" onClick={apply} disabled={busy || !world || past}
            title={past ? "Идёт перемотка: вернитесь к текущему моменту, чтобы ломать" : "Устроить этот сбой прямо сейчас"}>💥 Применить</button>
        </div>
        {msg && <div className="muted small" role="status">{msg}</div>}
        <div className="window-toggle">
          <button className={`btn btn-small ${windowOpen ? "on" : ""}`} onClick={() => setWindowOpen((o) => !o)}
            title="Задача путейцев: закрыть перегон на час. Бағдар подберёт время, когда это дешевле всего">
            🛠 {windowOpen ? "Скрыть подбор окна" : "Окно на ремонт — подобрать время"}
          </button>
        </div>
        {windowOpen && <WindowPlanner sections={sections} defaultSection={sec} />}
        {next && (
          <div className="scenario-next small">
            В {clock(next.t, false)} (через {Math.max(0, Math.round((next.t - t) / 60))} мин) случится само: {KIND_LABEL[next.kind] ?? next.kind}
          </div>
        )}
        <div className="incidents-head">Действуют сейчас</div>
        {active.length === 0 ? (
          <div className="muted small">Сбоев нет — всё работает.</div>
        ) : (
          <ul className="incidents">
            {active.map((i) => (
              <li key={i.id} className={`incident lvl-${i.level}`}>
                <span className={`badge ${i.level === "C" ? "badge-warning" : "badge-neutral"}`}>{i.level}</span>
                <span className="incident-title">{i.title}</span>
                <span className="muted tabular small">
                  {i.until != null ? `до ${clock(i.until, false)} (${Math.max(0, Math.round((i.until - t) / 60))} мин)` : "срок неизвестен"}
                </span>
                {i.restorable && <button className="btn btn-small" onClick={() => restore(i.id)}>Снять</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
