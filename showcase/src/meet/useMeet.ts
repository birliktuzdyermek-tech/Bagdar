import { useEffect, useMemo, useRef, useState } from "react";
import { compare, withDefaults, type MeetParams, type MeetResult } from "./model";

export type Source = "server" | "browser";

let serverProbe: Promise<boolean> | null = null;

/** Сервер Бағдара рядом (витрина раздаётся с того же сайта, что и API)? */
function probeServer(): Promise<boolean> {
  if (!serverProbe) {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 2500);
    serverProbe = fetch("../api/health", { signal: ctl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return false;
        const j = await r.json();
        return j?.status === "ok" && "world_loaded" in j;   // именно сервер Бағдара, а не чужой /api/health
      })
      .catch(() => false)
      .finally(() => window.clearTimeout(timer));
  }
  return serverProbe;
}

/**
 * Расчёт «Кто первым?». Если витрина открыта с сервера Бағдара — считает ядро (POST /api/meet,
 * тарифы и веса из настроек сервера). Без сервера — копия формулы ядра в браузере
 * (src/meet/model.ts, сверена с ядром тестом). Пока ждём ответ сервера, показан расчёт браузера.
 */
export function useMeet(params: MeetParams, pteStrict: boolean): { res: MeetResult; source: Source } {
  const local = useMemo(() => compare(params, pteStrict), [params, pteStrict]);
  const [server, setServer] = useState<{ key: string; res: MeetResult } | null>(null);
  const [online, setOnline] = useState(false);
  const key = JSON.stringify([params, pteStrict]);
  const seq = useRef(0);

  useEffect(() => {
    probeServer().then(setOnline);
  }, []);

  useEffect(() => {
    if (!online) return;
    const my = ++seq.current;
    const timer = window.setTimeout(() => {
      fetch("../api/meet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...withDefaults(params), pte_strict: pteStrict }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: MeetResult | null) => {
          if (j && my === seq.current) setServer({ key, res: j });
        })
        .catch(() => undefined);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [online, key, params, pteStrict]);

  if (server && server.key === key) return { res: server.res, source: "server" };
  return { res: local, source: "browser" };
}
