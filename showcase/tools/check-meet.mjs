// Сверка копии расчёта «Кто первым?» (src/meet/model.ts) с ядром по fixture.json.
// node tools/check-meet.mjs  (Node 22.18+: TypeScript без сборки)
import { readFileSync } from "node:fs";
import { compare } from "../src/meet/model.ts";

const data = JSON.parse(readFileSync(new URL("../src/meet/fixture.json", import.meta.url), "utf-8"));
let bad = 0;

function diff(a, b, path, out) {
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > Math.max(0.11, Math.abs(b) * 1e-6)) out.push(`${path}: ${a} ≠ ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: длина ${a.length} ≠ ${b.length}`);
    else a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b && !(a == null && b == null)) {
    out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  }
}

for (const c of data.cases) {
  const got = compare(c.params, c.pte_strict ?? true);
  const out = [];
  diff(got, c.result, c.name, out);
  if (out.length) {
    bad++;
    console.error(`✗ ${c.name}\n  ${out.slice(0, 8).join("\n  ")}`);
  }
}
if (bad) {
  console.error(`${bad} из ${data.cases.length} случаев расходятся с ядром`);
  process.exit(1);
}
console.log(`✓ ${data.cases.length} случаев совпадают с ядром (backend/bagdar/meet.py)`);
