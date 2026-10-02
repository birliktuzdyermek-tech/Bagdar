/* Бағдар: all local runs are available after the first complete visit. */
const CACHE_PREFIX = "bagdar-showcase-";
const buildId = new URL(self.location.href).searchParams.get("build") || "unknown";
const CACHE_NAME = `${CACHE_PREFIX}${buildId}`;
const BASE_URL = new URL("./", self.registration.scope);
const INDEX_URL = new URL("index.html", BASE_URL).href;
const RUN_LIST_URL = new URL("runs/index.json", BASE_URL).href;
const CONFIG_URL = new URL("site.config.json", BASE_URL).href;

function localUrl(path) {
  const url = new URL(path, BASE_URL);
  if (url.origin !== BASE_URL.origin || !url.pathname.startsWith(BASE_URL.pathname)) {
    throw new Error(`Outside showcase scope: ${path}`);
  }
  return url.href;
}

async function fetchAndCache(cache, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Cannot cache ${url}: ${response.status}`);
  await cache.put(url, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const [htmlResponse, listResponse] = await Promise.all([
      fetchAndCache(cache, INDEX_URL),
      fetchAndCache(cache, RUN_LIST_URL),
    ]);
    const html = await htmlResponse.text();
    const runs = await listResponse.json();
    if (!Array.isArray(runs)) throw new Error("Invalid run list");

    const assets = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => localUrl(match[1]));
    const replayFiles = runs.map((run) => {
      if (typeof run.file !== "string" || !/^[\w.-]+\.replay\.json(?:\.gz)?$/.test(run.file)) {
        throw new Error("Invalid replay filename");
      }
      return localUrl(`runs/${run.file}`);
    });
    const urls = new Set([
      ...assets,
      ...replayFiles,
      localUrl("favicon.svg"),
      localUrl("qr-simulator.svg"),
      CONFIG_URL,
    ]);
    await Promise.all([...urls].map((url) => fetchAndCache(cache, url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== BASE_URL.origin || !url.pathname.startsWith(BASE_URL.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    // These mutable entry points refresh online; the rest is immutable within
    // a build and can be shown immediately from the offline cache.
    const mutable = url.href === INDEX_URL || url.href === RUN_LIST_URL || url.href === CONFIG_URL;
    if (!mutable && cached) return cached;
    try {
      const response = await fetch(request);
      if (!response.ok && cached) return cached;
      if (response.ok) event.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch (error) {
      if (cached) return cached;
      if (request.mode === "navigate") return (await cache.match(INDEX_URL)) || Response.error();
      throw error;
    }
  })());
});
