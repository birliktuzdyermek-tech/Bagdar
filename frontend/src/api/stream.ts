// WebSocket-клиент потока /api/stream с переподключением.
// При переподключении сообщаем серверу версию мира, прогон и последний seq,
// чтобы получить только пропущенное и остаться согласованными.
import { useSim } from "../store/sim";
import type { StreamMsg } from "./types";

let socket: WebSocket | null = null;
let retry = 0;
let timer: number | undefined;
let stopped = false;

function url(): string {
  const { world, runId, lastSeq } = useSim.getState();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    world_version: String(world?.version ?? 0),
    run_id: runId,
    last_seq: String(lastSeq),
  });
  return `${proto}://${location.host}/api/stream?${q}`;
}

function handle(msg: StreamMsg): void {
  const st = useSim.getState();
  switch (msg.type) {
    case "hello":
      st.setHello(msg.run_id);
      break;
    case "world":
      st.setWorld(msg.world);
      break;
    case "events":
      st.pushEvents(msg.events, msg.reset);
      break;
    case "state":
      st.pushState(msg);
      break;
    default:
      break;
  }
}

export function connectStream(): void {
  stopped = false;
  window.clearTimeout(timer);
  useSim.getState().setConn("connecting");
  const ws = new WebSocket(url());
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    useSim.getState().setConn("open");
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string) as StreamMsg);
    } catch (e) {
      console.error("stream message", e);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    useSim.getState().setConn("closed");
    if (stopped) return;
    const delay = Math.min(8000, 500 * 2 ** retry++);
    timer = window.setTimeout(connectStream, delay);
  };
  ws.onerror = () => ws.close();
}

export function disconnectStream(): void {
  stopped = true;
  window.clearTimeout(timer);
  socket?.close();
  socket = null;
}
