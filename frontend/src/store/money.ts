// Деньги на экране. Внутри модели всё в условных единицах (у.е.); показываем по курсу из тарифов:
// по умолчанию 1 у.е. = 1 000 ₸. Курс и валюта меняются в «⚙ Настройках», все суммы пересчитываются сразу.
import { create } from "zustand";

interface MoneyState {
  symbol: string;
  rate: number;
  set: (symbol: string, rate: number) => void;
}

export const useMoney = create<MoneyState>((set) => ({
  symbol: "₸",
  rate: 1000,
  set: (symbol, rate) => set({ symbol, rate: rate > 0 ? rate : 1 }),
}));

/** Сумма в у.е. → строка в валюте показа: «23 150 ₸», «1,2 млн ₸», «−4 500 ₸». */
export function money(ue: number | null | undefined, opts: { short?: boolean; sign?: boolean } = {}): string {
  if (ue == null || !Number.isFinite(ue)) return "—";
  const { symbol, rate } = useMoney.getState();
  const v = symbol === "у.е." ? ue : ue * rate;
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  let body: string;
  if (opts.short !== false && a >= 1e9) body = `${(a / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млрд`;
  else if (opts.short !== false && a >= 1e6) body = `${(a / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: a >= 1e7 ? 1 : 2 })} млн`;
  else body = Math.round(a).toLocaleString("ru-RU");
  return `${sign}${body} ${symbol}`;
}

/** Тариф «за единицу» в валюте показа: 10 у.е./мин → «10 000 ₸/мин». */
export function rate(ue: number, per: string): string {
  return `${money(ue, { short: false })}/${per}`;
}
