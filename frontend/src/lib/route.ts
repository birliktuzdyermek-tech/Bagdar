import { useEffect, useState } from "react";

/** Экраны сайта. Адрес — hash, чтобы работать и из dev-сервера, и из сборки на одном порту. */
export type Route = "dispatcher" | "scenarios" | "dashboard" | "versus" | "review";
const ROUTES: Route[] = ["dispatcher", "scenarios", "dashboard", "versus", "review"];

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as string[]).includes(h) ? (h as Route) : "dispatcher";
}

export function go(r: Route) {
  window.location.hash = r === "dispatcher" ? "/" : `/${r}`;
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
