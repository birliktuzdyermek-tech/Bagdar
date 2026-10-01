// Цвет кодирует только принадлежность к группе поездов; статусы (норма,
// внимание, критично) — отдельная зарезервированная палитра и всегда идут
// вместе с иконкой и подписью. Значения — CSS-переменные из styles.css.

export type ClassGroup = "fast" | "pax" | "freight" | "engine" | "extra";

export function classGroup(cls: string): ClassGroup {
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

export const GROUP_COLOR: Record<ClassGroup, string> = {
  fast: "var(--cls-fast)",
  pax: "var(--cls-pax)",
  freight: "var(--cls-freight)",
  engine: "var(--cls-engine)",
  extra: "var(--cls-extra)",
};

export const GROUP_LABEL: Record<ClassGroup, string> = {
  fast: "Скоростные и скорые пассажирские",
  pax: "Пассажирские и пригородные",
  freight: "Грузовые (ускоренные, сквозные, сборные)",
  engine: "Локомотивы резервом",
  extra: "Внеочередные (восстановительные, пожарные)",
};

export type Status = "good" | "warning" | "serious" | "critical";
