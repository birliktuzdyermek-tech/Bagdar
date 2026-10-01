// «Голос Бағдара»: плавающая кнопка и панель — команды и вопросы голосом или текстом,
// ответы голосом, озвучивание новых решений. Всё в браузере, без внешних сервисов.
import { useCallback, useEffect, useRef, useState } from "react";
import { runCommand, sampleCommands } from "../lib/commands";
import { canListen, canSpeak, listen, speak, stopListening, stopSpeaking } from "../lib/voice";
import { useSim } from "../store/sim";

interface Msg { who: "you" | "bagdar"; text: string; kk?: string; ru?: string }

export function VoicePanel() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [interim, setInterim] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [narrate, setNarrate] = useState(false);
  const [busy, setBusy] = useState(false);
  const cards = useSim((s) => s.cards);
  const lastCard = useRef<string | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const listRef = useRef<HTMLDivElement>(null);
  const samples = sampleCommands();

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [log, interim]);

  // озвучка новых решений: разбор сбоя и карточки уровня C
  useEffect(() => {
    if (!cards.length) return;
    const c = cards[cards.length - 1];
    if (lastCard.current === null) { lastCard.current = c.id; return; }
    if (c.id === lastCard.current) return;
    lastCard.current = c.id;
    if (narrate && (c.type === "incident" || c.level === "C")) {
      const text = c.type === "incident" ? `Внимание. ${c.action}` : `Решение уровня C. ${c.action}`;
      setLog((l) => [...l, { who: "bagdar", text }]);
      speak(text);
    }
  }, [cards, narrate]);

  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q) return;
    setInput("");
    setLog((l) => [...l, { who: "you", text: q }]);
    setBusy(true);
    const r = await runCommand(q);
    setBusy(false);
    setLog((l) => [...l, { who: "bagdar", text: r.text, kk: r.announcement?.kk, ru: r.announcement?.ru }]);
    if (voiceOn) speak(r.speak ?? r.text.split("\n")[0]);
  }, [voiceOn]);

  const mic = () => {
    if (listening) { stopRef.current(); setListening(false); setInterim(null); return; }
    stopSpeaking();
    setListening(true);
    setInterim("");
    stopRef.current = listen(
      (t) => setInterim(t),
      (final) => { setListening(false); setInterim(null); if (final) ask(final); },
      (why) => { setListening(false); setInterim(null); setLog((l) => [...l, { who: "bagdar", text: why }]); },
    );
  };

  useEffect(() => () => { stopListening(); stopSpeaking(); }, []);

  return (
    <>
      <button className={`voice-fab ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)}
        title="Голос Бағдара: команды и вопросы голосом или текстом" aria-expanded={open}>
        🎙 Бағдар
      </button>
      {open && (
        <section className="voice-panel" role="dialog" aria-label="Голос Бағдара">
          <header className="voice-head">
            <b>Голос Бағдара</b>
            <span className="muted small">спросите или скомандуйте — словами</span>
            <span className="spacer" />
            <label className="small" title="Произносить ответы"><input type="checkbox" checked={voiceOn} onChange={(e) => { setVoiceOn(e.target.checked); if (!e.target.checked) stopSpeaking(); }} /> голос</label>
            <label className="small" title="Озвучивать разбор сбоев и решения уровня C, когда они появляются"><input type="checkbox" checked={narrate} onChange={(e) => setNarrate(e.target.checked)} /> озвучивать решения</label>
            <button className="btn btn-small" onClick={() => setOpen(false)} aria-label="Свернуть">✕</button>
          </header>
          <div className="voice-log" ref={listRef}>
            {log.length === 0 && (
              <div className="voice-hint">
                <p>Бағдар понимает обычную речь: закрыть перегон, задержать поезд, спросить, почему кто-то стоит, или попросить объявление пассажирам. Нажмите на фразу или скажите свою.</p>
              </div>
            )}
            {log.map((m, i) => (
              <div key={i} className={`voice-msg ${m.who}`}>
                <span className="voice-who">{m.who === "you" ? "Вы" : "Бағдар"}</span>
                {m.kk && m.ru ? (
                  <div className="voice-pa">
                    <div className="voice-pa-title">📢 {m.text.split("\n")[0]}</div>
                    <div className="voice-pa-lang"><b>ҚАЗ</b> {m.kk}</div>
                    <div className="voice-pa-lang"><b>РУС</b> {m.ru}</div>
                    <button className="btn btn-small" onClick={() => speak(m.ru!)}>🔊 Прочитать по-русски</button>
                  </div>
                ) : <span className="voice-text">{m.text}</span>}
              </div>
            ))}
            {interim !== null && <div className="voice-msg you interim"><span className="voice-who">Вы</span><span className="voice-text">{interim || "слушаю…"}</span></div>}
            {busy && <div className="voice-msg bagdar"><span className="voice-who">Бағдар</span><span className="voice-text muted">думаю…</span></div>}
          </div>
          <div className="voice-samples">
            {samples.map((s) => <button key={s} className="chip voice-chip" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
          </div>
          <form className="voice-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
            <button type="button" className={`btn voice-mic ${listening ? "on" : ""}`} onClick={mic} disabled={!canListen()}
              title={canListen() ? (listening ? "Остановить" : "Сказать голосом") : "Распознавание речи есть в Chrome и Edge"}>
              {listening ? "■" : "🎤"}
            </button>
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Напишите команду или вопрос…" aria-label="Команда" />
            <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>Спросить</button>
          </form>
          {!canSpeak() && <div className="small muted" style={{ padding: "0 12px 8px" }}>В этом браузере нет синтеза речи — ответы только текстом.</div>}
        </section>
      )}
    </>
  );
}
