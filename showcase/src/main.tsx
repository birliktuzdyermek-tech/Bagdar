import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../contracts/design-tokens.css";
import "./styles.css";
import { App } from "./App";

declare const __BAGDAR_BUILD_ID__: string;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The standalone build can keep showing all recorded runs after connectivity is
// lost. The readiness signal is emitted only once the current build's complete
// replay cache has installed and taken control of this document.
if (import.meta.env.PROD && "serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    const script = `./sw.js?build=${encodeURIComponent(__BAGDAR_BUILD_ID__)}`;
    const expectedUrl = new URL(script, location.href).href;
    navigator.serviceWorker.register(script, { scope: "./index.html" }).then(() => {
      const markReady = () => {
        if (navigator.serviceWorker.controller?.scriptURL !== expectedUrl) return;
        document.documentElement.dataset.offlineReady = "true";
        window.dispatchEvent(new Event("bagdar:offline-ready"));
        navigator.serviceWorker.removeEventListener("controllerchange", markReady);
      };
      navigator.serviceWorker.addEventListener("controllerchange", markReady);
      markReady();
    }).catch((error: unknown) => {
      console.warn("Не удалось сохранить записи для автономного показа", error);
    });
  }, { once: true });
}
