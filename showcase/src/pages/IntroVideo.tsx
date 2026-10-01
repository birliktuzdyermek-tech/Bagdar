import { useState } from "react";
import type { RunInfo } from "../replay/types";
import { BgReplay } from "./BgReplay";

/** Видео-заставка: диспетчерский зал. Если видео не играет — фон из записи прогона. */
export function IntroVideo({ fallback, caption = true }: { fallback: RunInfo | null; caption?: boolean }) {
  const [failed, setFailed] = useState(false);
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (failed) return <BgReplay run={fallback} />;
  return (
    <div className="hero-video" aria-hidden>
      <video poster="./intro-poster.jpg" muted loop playsInline autoPlay={!reduce} preload="metadata">
        <source src="./intro.webm" type="video/webm" />
        <source src="./intro.mp4" type="video/mp4" onError={() => setFailed(true)} />
      </video>
      {caption && <span className="bg-caption">видео — художественная иллюстрация, не реальный диспетчерский зал</span>}
    </div>
  );
}
