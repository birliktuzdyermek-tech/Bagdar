import { useEffect, useState } from "react";
import { isRecording, recorderSupported, startRecording, stopRecording } from "../lib/recorder";
import { useSim } from "../store/sim";

/** Запись сценария в видеофайл средствами браузера (WebM). */
export function RecordButton({ big = false }: { big?: boolean }) {
  const [on, setOn] = useState(isRecording());
  const [sec, setSec] = useState(0);
  const setError = useSim((s) => s.setError);
  useEffect(() => {
    if (!on) return;
    setSec(0);
    const id = window.setInterval(() => setSec((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  if (!recorderSupported()) {
    return <span className="muted small" title="Нужен браузер с getDisplayMedia и MediaRecorder (Chrome, Edge, Firefox)">запись видео недоступна в этом браузере</span>;
  }
  const cls = `btn ${big ? "" : "btn-small"} ${on ? "btn-rec-on" : ""}`;
  return on ? (
    <button className={cls} onClick={() => stopRecording()} title="Остановить и скачать видео">
      ■ Стоп · {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}
    </button>
  ) : (
    <button className={cls} title="Записать экран в видеофайл: браузер спросит, что записывать — выберите эту вкладку"
      onClick={() => startRecording(() => setOn(false)).then(() => setOn(true)).catch((e) => {
        if (String(e?.name) !== "NotAllowedError") setError(String(e?.message ?? e));
      })}>
      ⏺ Записать видео
    </button>
  );
}
