// Голос Бағдара: синтез речи и распознавание команд средствами браузера (Web Speech API).
// Внешних сервисов нет: Chrome/Edge распознают речь сами, озвучка — системные голоса.

interface RecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEventLike { resultIndex: number; results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canListen(): boolean {
  return typeof window !== "undefined" && recognitionCtor() !== null;
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

let current: RecognitionLike | null = null;

/** Слушать одну фразу по-русски. interim — промежуточный текст, done — итог (пустая строка, если не разобрал). */
export function listen(interim: (text: string) => void, done: (text: string) => void, fail: (why: string) => void): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    fail("В этом браузере нет распознавания речи — введите команду текстом");
    return () => {};
  }
  stopListening();
  const r = new Ctor();
  current = r;
  r.lang = "ru-RU";
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let final = "";
  r.onresult = (e) => {
    let text = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      text += res[0].transcript;
      if (res.isFinal) final = text;
    }
    interim(text);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") fail("Доступ к микрофону запрещён — разрешите его в адресной строке или введите команду текстом");
    else if (e.error !== "aborted") fail(`Не расслышал (${e.error}) — попробуйте ещё раз или введите текстом`);
  };
  r.onend = () => {
    if (current === r) current = null;
    done(final.trim());
  };
  try {
    r.start();
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
  return () => {
    if (current === r) {
      r.abort();
      current = null;
    }
  };
}

export function stopListening(): void {
  current?.abort();
  current = null;
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const exact = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  if (!exact.length) return null;
  // предпочитаем «натуральные» голоса, если система их отдаёт
  return exact.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ?? exact.find((v) => v.localService) ?? exact[0];
}

/** Произнести текст. Прерывает предыдущую фразу. */
export function speak(text: string, lang = "ru-RU"): Promise<void> {
  if (!canSpeak() || !text.trim()) return Promise.resolve();
  const synth = window.speechSynthesis;
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = 1.02;
    u.pitch = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

/** Голос для казахского есть не во всех системах: если нет — вернём false, текст покажем без озвучки. */
export function hasVoice(lang: string): boolean {
  return canSpeak() && pickVoice(lang) !== null;
}
