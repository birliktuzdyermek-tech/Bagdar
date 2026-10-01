import { useEffect, useRef, useState, type RefObject } from "react";
import { clock } from "../lib/format";
import { cssVar } from "../lib/palette";
import type { ReplayModel } from "../replay/model";
import type { RunInfo, SimEvent } from "../replay/types";
import type { Clock } from "./clock";
import "./voice-video.css";

interface Props {
  clk: Clock;
  model: ReplayModel;
  info: RunInfo;
  schemeRef: RefObject<HTMLCanvasElement | null>;
  graphRef: RefObject<HTMLCanvasElement | null>;
  onRecordingChange: (recording: boolean) => void;
}

interface RecordingSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  raf: number;
  chunks: Blob[];
  discard: boolean;
  started: number;
}

const VIDEO_W = 1280;
const VIDEO_H = 720;

function importantEvent(e: SimEvent): boolean {
  return e.kind === "decision" || e.kind === "train_delay_injected" || e.severity === "warn" || e.severity === "critical";
}

function videoMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const mime of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

function fitText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function drawSource(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement | null, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = cssVar("--surface-1") || "#14212a";
  ctx.fillRect(x, y, w, h);
  if (!source || !source.width || !source.height) return;
  const scale = Math.min(w / source.width, h / source.height);
  const dw = source.width * scale;
  const dh = source.height * scale;
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** The saved frame contains only replay canvases and literal data from this run. */
function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  model: ReplayModel,
  info: RunInfo,
  t: number,
  scheme: HTMLCanvasElement | null,
  graph: HTMLCanvasElement | null,
): void {
  const bg = cssVar("--bg") || "#101a22";
  const text = cssVar("--text-primary") || "#f5f8f9";
  const muted = cssVar("--text-secondary") || "#a4b1b7";
  const accent = cssVar("--accent") || "#38a99f";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);

  ctx.fillStyle = accent;
  ctx.fillRect(24, 24, 8, 34);
  ctx.fillStyle = text;
  ctx.font = "bold 27px system-ui, sans-serif";
  ctx.fillText("Запись прогона", 44, 50);
  ctx.font = "20px system-ui, sans-serif";
  ctx.fillText(fitText(ctx, info.title, 710), 280, 49);
  ctx.textAlign = "right";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText(clock(t, false), VIDEO_W - 25, 49);
  ctx.textAlign = "left";
  ctx.fillStyle = muted;
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText(`Время модели · seed ${model.r.world.seed} · ${model.r.world.name}`, 26, 78);

  ctx.fillStyle = text;
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText("Схема участка", 26, 111);
  drawSource(ctx, scheme, 24, 123, 1232, 190);
  ctx.fillText("График движения · пунктир — план, сплошная — факт", 26, 347);
  drawSource(ctx, graph, 24, 359, 1232, 303);

  const n = model.eventCountUpTo(t);
  const latest = n > 0 ? model.r.events[n - 1] : undefined;
  ctx.fillStyle = muted;
  ctx.font = "16px system-ui, sans-serif";
  const lastEvent = latest ? `Последнее событие записи ${clock(latest.t, false)}: ${latest.message}` : "Событий в записи пока нет";
  ctx.fillText(fitText(ctx, lastEvent, 1224), 26, 695);
}

export function VoiceVideo({ clk, model, info, schemeRef, graphRef, onRecordingChange }: Props) {
  const [voiceOn, setVoiceOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const sessionRef = useRef<RecordingSession | null>(null);
  const urls = useRef<string[]>([]);
  const timers = useRef<number[]>([]);
  const voiceAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const videoAvailable = typeof window !== "undefined" && "MediaRecorder" in window && "captureStream" in HTMLCanvasElement.prototype;

  useEffect(() => {
    if (!voiceOn || !voiceAvailable) return;
    const synth = window.speechSynthesis;
    let seen = model.eventCountUpTo(clk.t);
    let lastVoice = -Infinity;
    const poll = window.setInterval(() => {
      const n = model.eventCountUpTo(clk.t);
      if (n < seen) seen = n;
      if (!clk.playing || n <= seen) return;
      const fresh = model.r.events.slice(seen, n).filter(importantEvent);
      seen = n;
      const event = fresh.at(-1);
      const now = performance.now();
      if (!event || now - lastVoice < 8000 || synth.speaking) return;
      const utterance = new SpeechSynthesisUtterance(`Запись прогона. ${clock(event.t, false)}. ${event.message.slice(0, 170)}`);
      utterance.lang = "ru-RU";
      utterance.rate = 1;
      utterance.onerror = (error) => {
        if (error.error !== "canceled" && error.error !== "interrupted" && mounted.current)
          setStatus("Браузер не смог озвучить событие. Проверьте голосовую поддержку системы.");
      };
      try {
        synth.speak(utterance);
      } catch {
        setVoiceOn(false);
        setStatus("Браузер не смог запустить голосовой доклад.");
      }
      lastVoice = now;
    }, 250);
    return () => {
      window.clearInterval(poll);
      synth.cancel();
    };
  }, [voiceOn, voiceAvailable, clk, model]);

  const stopRecording = () => {
    const session = sessionRef.current;
    if (session && session.recorder.state !== "inactive") session.recorder.stop();
  };

  const startRecording = () => {
    if (!videoAvailable || sessionRef.current) return;
    if (clk.t >= model.end) clk.seek(model.start);
    const mime = videoMime();
    if (!mime) {
      setStatus("Этот браузер не поддерживает запись холста в видео.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setStatus("Не удалось создать кадр видео.");
      return;
    }
    drawVideoFrame(ctx, model, info, clk.t, schemeRef.current, graphRef.current);
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder;
    try {
      stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      setStatus("Браузер не смог начать запись видео.");
      return;
    }
    const session: RecordingSession = {
      recorder,
      stream,
      raf: 0,
      chunks: [],
      discard: false,
      started: performance.now(),
    };
    sessionRef.current = session;
    recorder.ondataavailable = (event) => {
      if (event.data.size) session.chunks.push(event.data);
    };
    recorder.onerror = () => {
      session.discard = true;
      if (mounted.current) setStatus("Браузер прервал запись видео.");
      stopRecording();
    };
    recorder.onstop = () => {
      cancelAnimationFrame(session.raf);
      session.stream.getTracks().forEach((track) => track.stop());
      if (sessionRef.current === session) sessionRef.current = null;
      if (mounted.current) {
        setRecording(false);
        onRecordingChange(false);
      }
      if (session.discard) return;
      if (!session.chunks.length) {
        if (mounted.current) setStatus("Браузер не выдал видеоданные.");
        return;
      }
      const blob = new Blob(session.chunks, { type: recorder.mimeType || mime });
      if (!blob.size) return;
      const url = URL.createObjectURL(blob);
      urls.current.push(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bagdar-${info.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.${(recorder.mimeType || mime).includes("mp4") ? "mp4" : "webm"}`;
      document.body.append(link);
      link.click();
      link.remove();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current = urls.current.filter((item) => item !== url);
      }, 60000);
      timers.current.push(timer);
      if (mounted.current) setStatus(`Видео сохранено: ${Math.round(blob.size / 1024 / 1024 * 10) / 10} МБ.`);
    };
    try {
      recorder.start(1000);
    } catch {
      session.stream.getTracks().forEach((track) => track.stop());
      sessionRef.current = null;
      setStatus("Браузер не смог начать запись видео.");
      return;
    }
    setStatus("Идёт запись видео из replay.");
    setElapsed(0);
    setRecording(true);
    onRecordingChange(true);
    clk.play();
    const draw = () => {
      if (recorder.state === "inactive") return;
      drawVideoFrame(ctx, model, info, clk.t, schemeRef.current, graphRef.current);
      const seconds = Math.floor((performance.now() - session.started) / 1000);
      if (mounted.current) setElapsed((prev) => prev === seconds ? prev : seconds);
      if (clk.t >= model.end && !clk.playing) {
        stopRecording();
        return;
      }
      session.raf = requestAnimationFrame(draw);
    };
    session.raf = requestAnimationFrame(draw);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = sessionRef.current;
      if (session) {
        cancelAnimationFrame(session.raf);
        if (session.recorder.state !== "inactive") session.recorder.stop();
        else session.stream.getTracks().forEach((track) => track.stop());
      }
      timers.current.forEach((timer) => window.clearTimeout(timer));
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  return (
    <section className="panel voice-video" aria-label="Доклад и запись ролика">
      <div className="voice-video-head">
        <div>
          <h2 className="panel-title">Доклад и ролик</h2>
          <p className="muted small">Голос читает короткие события из этой записи. Выключен по умолчанию.</p>
        </div>
        <div className="voice-video-actions">
          <label className="toggle">
            <input type="checkbox" checked={voiceOn} disabled={!voiceAvailable} onChange={(e) => setVoiceOn(e.target.checked)} />
            Голосовой доклад
          </label>
          <button className={`btn ${recording ? "btn-recording" : ""}`} disabled={!videoAvailable} onClick={recording ? stopRecording : startRecording}>
            {recording ? `■ Завершить запись · ${elapsed} с` : "● Записать ролик"}
          </button>
        </div>
      </div>
      <p className="muted small">В файл попадают схема и график из replay, название прогона и время модели. Видео без звука и боковых панелей. Формат зависит от браузера (обычно WebM).</p>
      {!voiceAvailable && <p className="muted small">В этом браузере нет speechSynthesis.</p>}
      {!videoAvailable && <p className="muted small">В этом браузере нет MediaRecorder или захвата холста.</p>}
      {status && <p className="voice-video-status" role="status">{status}</p>}
    </section>
  );
}
