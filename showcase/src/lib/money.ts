// Деньги в витрине. Расчёт ядра — в условных единицах; показываем в тенге по курсу 1 у.е. = 1 000 ₸
// (как в настройках симулятора по умолчанию). Если витрина открыта с сервера, курс берётся из его настроек.
let symbol = "₸";
let rate = 1000;

export function setMoney(sym: string, perUnit: number): void {
  symbol = sym || "₸";
  rate = perUnit > 0 ? perUnit : 1;
}

export function moneyRate(): { symbol: string; rate: number } {
  return { symbol, rate };
}

/** «23 150 ₸», «1,2 млн ₸», «−4 500 ₸». */
export function money(ue: number | null | undefined, opts: { short?: boolean; sign?: boolean } = {}): string {
  if (ue == null || !Number.isFinite(ue)) return "—";
  const v = symbol === "у.е." ? ue : ue * rate;
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  let body: string;
  if (opts.short !== false && a >= 1e9) body = `${(a / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млрд`;
  else if (opts.short !== false && a >= 1e6) body = `${(a / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: a >= 1e7 ? 1 : 2 })} млн`;
  else body = Math.round(a).toLocaleString("ru-RU");
  return `${sign}${body} ${symbol}`;
}

/** Тариф: 70 у.е./мин → «70 000 ₸/мин». */
export function perMin(ue: number): string {
  return `${money(ue, { short: false })}/мин`;
}

/** Короткая форма для сцены: «−1 200 ₸», «−1,2 млн ₸». */
export function moneyShort(ue: number): string {
  return money(ue);
}
