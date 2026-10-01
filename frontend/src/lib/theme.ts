// Холст ECharts не понимает CSS-переменные: читаем вычисленные токены и
// перечитываем их при смене темы.
import { useEffect, useState } from "react";

const KEYS = [
  "--surface-1", "--surface-2", "--surface-3", "--border", "--border-strong",
  "--text-primary", "--text-secondary", "--text-muted", "--accent",
  "--cls-fast", "--cls-pax", "--cls-freight", "--cls-engine", "--cls-extra",
  "--good", "--warning", "--serious", "--critical",
] as const;

export type Tokens = Record<(typeof KEYS)[number], string>;

function read(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Tokens;
  for (const k of KEYS) out[k] = cs.getPropertyValue(k).trim() || "#888";
  return out;
}

export function useTokens(): Tokens {
  const [tokens, setTokens] = useState<Tokens>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTokens(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return tokens;
}

export function groupColor(t: Tokens, group: string): string {
  return t[`--cls-${group}` as keyof Tokens] ?? t["--cls-freight"];
}

/** Белый или чёрный текст поверх заливки — по яркости заливки. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.22 ? "#0b0b0b" : "#ffffff";
}
