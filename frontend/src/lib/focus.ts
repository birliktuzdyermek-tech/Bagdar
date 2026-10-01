// «Что сейчас самое важное»: одна кнопка из любого состояния ведёт к самому
// срочному — решению, которое ждёт выбора, плану, который не найден, самой
// дорогой тревоге, ближайшему конфликту или самому опоздавшему поезду.
import { computeAlarms } from "./alarms";
import { useSim } from "../store/sim";

export function focusMostImportant(): string {
  const s = useSim.getState();
  const st = s.state;
  s.bumpFocus();
  if (!st || !s.world || !s.idx) return "Нет данных";
  const scrollTo = (id: string) =>
    window.setTimeout(() => document.getElementById(`card-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
  const pending = s.cards.find((c) => c.status === "pending");
  if (pending) {
    if (pending.trains[0]) s.selectTrain(pending.trains[0]);
    if (pending.station_id) s.selectStation(pending.station_id);
    scrollTo(pending.id);
    return `Ждёт выбора: ${pending.action}`;
  }
  if (st.planner.status === "infeasible") {
    const np = [...s.cards].reverse().find((c) => c.type === "no_plan");
    if (np) scrollTo(np.id);
    return "Допустимый план не найден — поезда удержаны";
  }
  const alarms = computeAlarms(s.world, s.idx, st).all.filter((a) => a.kind !== "index");
  const top = alarms[0];
  if (top?.trainId) {
    s.selectTrain(top.trainId);
    return top.label;
  }
  const cf = st.conflicts[0];
  if (cf) {
    s.selectTrain(cf.trains[0]);
    return `Конфликт через ${Math.max(0, Math.round(cf.in_s / 60))} мин: ${cf.message}`;
  }
  if (top) {
    if (top.sectionId) {
      const sec = s.idx.sections.get(top.sectionId);
      if (sec) s.selectStation(sec.a);
    }
    return top.label;
  }
  const worst = [...st.trains].sort((a, b) => b.delay_s - a.delay_s)[0];
  if (worst && worst.delay_s >= 60) {
    s.selectTrain(worst.id);
    return `Больше всех опаздывает ${s.idx.trains.get(worst.id)?.number ?? worst.id}`;
  }
  s.selectTrain(null);
  return "Всё штатно: конфликтов и тревог нет";
}
