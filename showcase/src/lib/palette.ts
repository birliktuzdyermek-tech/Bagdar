// Группы поездов: цвет и форма метки (BAGDAR V2, раздел 2): пассажирские —
// круг со стрелкой хода, грузовые — прямоугольник, внеочередные — ромб.
// Цвета — токены contracts/design-tokens.css.
export type Group = "fast" | "pax" | "freight" | "engine" | "extra";

export function group(cls: string): Group {
  switch (cls) {
    case "high_speed_passenger":
    case "fast_passenger":
      return "fast";
    case "passenger":
      return "pax";
    case "light_engine":
      return "engine";
    case "extraordinary":
      return "extra";
    default:
      return "freight";
  }
}

export const GROUP_VAR: Record<Group, string> = {
  fast: "--cls-fast",
  pax: "--cls-pax",
  freight: "--cls-freight",
  engine: "--cls-engine",
  extra: "--cls-extra",
};

export const GROUP_LABEL: Record<Group, string> = {
  fast: "Скорые и скоростные",
  pax: "Пассажирские",
  freight: "Грузовые",
  engine: "Локомотивы резервом",
  extra: "Внеочередные",
};

/** Статус поезда словом и значком: статус никогда не передаётся только цветом. */
export interface StatusView {
  word: string;
  icon: string;
  tone: "good" | "warning" | "serious" | "critical" | "neutral";
}

export function trainStatus(display: string, delay_s: number, tolerance_s: number, waiting: boolean): StatusView {
  if (delay_s > tolerance_s) return { word: "опаздывает", icon: "▲", tone: "critical" };
  if (waiting || display === "held") return { word: "ожидает", icon: "⏸", tone: "warning" };
  switch (display) {
    case "running":
      return { word: "в пути", icon: "▶", tone: "good" };
    case "braking":
      return { word: "тормозит", icon: "▼", tone: "good" };
    case "stopped":
      return { word: "остановлен", icon: "■", tone: "serious" };
    case "dwell":
      return { word: "стоянка", icon: "●", tone: "neutral" };
    case "ready":
      return { word: "готов к отправлению", icon: "◐", tone: "neutral" };
    case "terminated":
      return { word: "прибыл на конечную", icon: "◼", tone: "neutral" };
    default:
      return { word: display, icon: "•", tone: "neutral" };
  }
}

export const TONE_VAR: Record<StatusView["tone"], string> = {
  good: "--good",
  warning: "--warning",
  serious: "--serious",
  critical: "--critical",
  neutral: "--text-secondary",
};

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
}
