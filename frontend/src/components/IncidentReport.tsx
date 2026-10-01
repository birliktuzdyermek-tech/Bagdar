// Разбор инцидента «до / после»: что было в момент сбоя, что стало после
// пересчёта, что было бы без перестройки порядка и при правиле «кто первый
// пришёл, тот первый едет». Для опоздания — дерево распространения задержки.
import { useState } from "react";
import { num } from "../lib/format";
import { money } from "../store/money";
import { useSim } from "../store/sim";

interface Summary {
  J?: number | null;
  J_lex?: number | null;
  affected?: number;
  delay_add_min?: number | null;
  late_trains?: number | null;
  forecast?: number | null;
  pte?: number;
  stuck?: number | null;
  valid?: boolean | null;
  why?: string | null;
  deadlock?: boolean | null;
  tree?: TreeData | null;
}
interface TreeNode {
  train_id: string;
  number: string;
  wait_s: number;
  station: string | null;
  children: TreeNode[];
}
interface TreeData {
  root: string;
  affected: number;
  total_wait_min: number;
  tree: TreeNode;
}
interface Report {
  before?: { index?: number | null; forecast?: number | null; conflicts?: number; first_conflict?: string | null; J?: number | null };
  plan?: Summary;
  no_change?: Summary | null;
  fifo?: Summary | null;
  tree?: TreeData | null;
}

const v = (x: number | null | undefined, d = 0) => (x == null ? "—" : num(x, d));

function Tree({ n, depth }: { n: TreeNode; depth: number }) {
  const selectTrain = useSim((s) => s.selectTrain);
  return (
    <li>
      <button className="link" onClick={(e) => { e.stopPropagation(); selectTrain(n.train_id); }}>{n.number}</button>
      {depth > 0 && <span className="muted"> ждал {Math.round(n.wait_s / 60)} мин{n.station ? ` на ст. ${n.station}` : ""}</span>}
      {n.children.length > 0 && (
        <ul>{n.children.map((c) => <Tree key={c.train_id} n={c} depth={depth + 1} />)}</ul>
      )}
    </li>
  );
}

export function IncidentReport({ report }: { report: Report }) {
  const [showTree, setShowTree] = useState(false);
  const cols: { key: string; label: string; s: Summary | null | undefined }[] = [
    { key: "plan", label: "Бағдар", s: report.plan },
    { key: "no_change", label: "без перестройки", s: report.no_change },
    { key: "fifo", label: "«кто первый»", s: report.fifo },
  ];
  const b = report.before ?? {};
  const tree = report.tree;
  const fifoTree = report.fifo?.tree;
  return (
    <div className="inc-report" onClick={(e) => e.stopPropagation()}>
      <div className="small muted">
        В момент сбоя: индекс {v(b.index)}, прогноз на час {v(b.forecast)}, конфликтов в действующем плане {b.conflicts ?? 0}
        {b.first_conflict ? ` (${b.first_conflict})` : ""}
      </div>
      <table className="inc-table">
        <thead>
          <tr><th />{cols.map((c) => <th key={c.key} className={c.key === "plan" ? "hl" : ""}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            <th>Задето волной</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>
              {c.s ? `${c.s.affected ?? "—"}${c.s.delay_add_min ? ` · +${v(c.s.delay_add_min)} п-мин` : ""}` : "—"}
            </td>)}
          </tr>
          <tr>
            <th>Сверх допуска</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>{c.s ? v(c.s.late_trains) : "—"}</td>)}
          </tr>
          <tr>
            <th>Нарушений ПТЭ</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>{c.s ? v(c.s.pte) : "—"}</td>)}
          </tr>
          <tr>
            <th title="Поезда, которых план бросил посреди горизонта: маршрут продолжается, перегон открыт, а плеч дальше нет">Застряло в плане</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>
              {c.s ? (c.s.deadlock ? `замок, ${c.s.stuck ?? 0}` : v(c.s.stuck ?? 0)) : "—"}
            </td>)}
          </tr>
          <tr>
            <th>Цена плана</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>
              {c.s ? (c.s.valid === false ? "недопустим" : money(c.s.J_lex)) : "—"}
            </td>)}
          </tr>
          <tr>
            <th>Индекс через час</th>
            {cols.map((c) => <td key={c.key} className={c.key === "plan" ? "hl" : ""}>{c.s ? v(c.s.forecast) : "—"}</td>)}
          </tr>
        </tbody>
      </table>
      {tree && (
        <div className="small">
          Дерево задержки: у Бағдара задето <b>{tree.affected}</b> п. (ожидание {v(tree.total_wait_min, 1)} мин)
          {fifoTree ? <>, при «кто первый пришёл» — <b>{fifoTree.affected}</b> п. ({v(fifoTree.total_wait_min, 1)} мин)</> : null}
          {" "}
          <button className="link" onClick={() => setShowTree(!showTree)}>{showTree ? "скрыть" : "показать дерево"}</button>
          {showTree && <ul className="delay-tree"><Tree n={tree.tree} depth={0} /></ul>}
        </div>
      )}
      <div className="muted small">Цена плана — задержки, остановки и простой по весам планировщика, со штрафами за нарушения ПТЭ и застрявшие поезда. Суммы условные.</div>
    </div>
  );
}
