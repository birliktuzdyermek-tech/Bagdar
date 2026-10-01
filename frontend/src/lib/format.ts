const pad = (n: number) => String(n).padStart(2, "0");

/** Секунды модели → «ЧЧ:ММ:СС». */
export function clock(t: number, withSeconds = true): string {
  const s = Math.max(0, Math.floor(t)) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return withSeconds ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(h)}:${pad(m)}`;
}

export function hhmm(t: number | null | undefined): string {
  return t == null ? "—" : clock(t, false);
}

export function simDate(t: number): string {
  const day = 1 + Math.floor(Math.max(0, t) / 86400);
  return `${pad(day)}.10.2026`;
}

/** Задержка в минутах для подписи: «+7 мин», «+0:40». */
export function delayLabel(sec: number): string {
  if (sec < 60) return sec > 0 ? `+${sec} с` : "вовремя";
  return `+${Math.round(sec / 60)} мин`;
}

export function minutes(sec: number, digits = 1): string {
  return (sec / 60).toFixed(digits).replace(".", ",");
}

export function duration(sec: number): string {
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${neg ? "−" : ""}${h} ч ${pad(m)} мин`;
}

export function num(n: number, digits = 0): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export const DISPLAY_LABEL: Record<string, string> = {
  ready: "готов к отправлению",
  dwell: "стоянка",
  held: "задержан на станции",
  terminated: "прибыл на конечную",
  running: "в пути",
  braking: "подходит к станции",
  stopped: "остановлен на перегоне",
  pending: "ещё не на участке",
  finished: "ушёл с участка",
};

export const CARGO_LABEL: Record<string, string> = {
  perishable: "скоропортящийся",
  urgent: "срочный",
  deadline: "истекает срок доставки",
  dangerous: "опасный груз",
};
