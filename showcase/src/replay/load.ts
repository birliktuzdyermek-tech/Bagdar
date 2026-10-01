import type { Replay, RunInfo } from "./types";

const SUPPORTED_SCHEMA = 1;

export async function loadRunList(): Promise<RunInfo[]> {
  const res = await fetch("./runs/index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Список записей недоступен: ${res.status}`);
  return (await res.json()) as RunInfo[];
}

/** Читает запись: .json или .json.gz. Если хостинг сам распаковал gzip, берём как есть. */
export async function loadReplay(file: string, onProgress?: (share: number) => void): Promise<Replay> {
  const res = await fetch(`./runs/${file}`);
  if (!res.ok || !res.body) throw new Error(`Запись ${file} недоступна: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total && onProgress) onProgress(Math.min(1, got / total));
  }
  let bytes = concat(chunks, got);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const replay = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Replay;
  if (replay.schema_version !== SUPPORTED_SCHEMA) {
    throw new Error(`Формат записи v${replay.schema_version} не поддерживается, витрина читает v${SUPPORTED_SCHEMA}`);
  }
  if (!replay.frames?.length) throw new Error("В записи нет кадров");
  return replay;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
