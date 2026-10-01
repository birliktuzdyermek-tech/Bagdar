export function clock(t: number, seconds = true): string {
  const s = Math.max(0, Math.floor(t)) % 86400;
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return seconds ? `${h}:${m}:${String(s % 60).padStart(2, "0")}` : `${h}:${m}`;
}

export function minutes(sec: number, digits = 1): string {
  return (sec / 60).toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function num(x: number, digits = 0): string {
  return x.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function shortStation(name: string): string {
  return name.replace(/^Разъезд\s+/, "Рз ");
}
