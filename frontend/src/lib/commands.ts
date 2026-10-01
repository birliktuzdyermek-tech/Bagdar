// Команды и вопросы Бағдару на обычном русском: «закрой перегон Үшбел — Разъезд 12 на 30 минут»,
// «почему стоит 2008?», «когда восстановится график?», «объяви пассажирам». Правила, без внешних сервисов:
// разбираем фразу, достаём станции и номера поездов, спрашиваем состояние у хранилища и дёргаем те же
// REST-команды, что и кнопки. Ответ — короткий текст для экрана и голоса.
import { api } from "../api/client";
import type { DecisionCard, TrainState } from "../api/types";
import { paAnnouncement } from "./announce";
import { focusMostImportant } from "./focus";
import { delayLabel } from "./format";
import { useSim } from "../store/sim";

export interface Reply { text: string; speak?: string; announcement?: { kk: string; ru: string } | null; ok?: boolean }

const KK: Record<string, string> = { ә: "а", і: "и", ң: "н", ғ: "г", ү: "у", ұ: "у", қ: "к", ө: "о", һ: "х", ё: "е" };

export function norm(s: string): string {
  return s.toLowerCase().replace(/[әіңғүұқөһё]/g, (c) => KK[c] ?? c).replace(/[^a-zа-я0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)] as number[]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Насколько фраза похожа на название станции: 0 — не похожа, 1 — точно. */
function stationScore(phrase: string, name: string): number {
  const p = norm(phrase);
  const n = norm(name);
  if (!p || !n) return 0;
  if (p === n) return 1;
  if (n.startsWith(p) && p.length >= 3) return 0.9;
  const d = lev(p, n);
  const tol = n.length <= 5 ? 1 : 2;
  return d <= tol ? 1 - d / (n.length + 1) : 0;
}

function findStation(phrase: string): { id: string; name: string; score: number } | null {
  const idx = useSim.getState().idx;
  if (!idx) return null;
  let best: { id: string; name: string; score: number } | null = null;
  for (const st of idx.stations.values()) {
    const s = stationScore(phrase, st.name);
    if (s > 0 && (!best || s > best.score)) best = { id: st.id, name: st.name, score: s };
  }
  return best;
}

/** «ушбел разъезд 12» → две станции, между которыми есть перегон. */
function findSection(text: string): { id: string; label: string } | null {
  const idx = useSim.getState().idx;
  if (!idx) return null;
  const words = norm(text).split(" ").filter(Boolean);
  let best: { id: string; label: string; score: number } | null = null;
  for (let k = 1; k < words.length; k++) {
    const a = findStation(words.slice(0, k).join(" "));
    const b = findStation(words.slice(k).join(" "));
    if (!a || !b || a.id === b.id) continue;
    for (const sec of idx.sections.values()) {
      if ((sec.a === a.id && sec.b === b.id) || (sec.a === b.id && sec.b === a.id)) {
        const score = a.score + b.score;
        if (!best || score > best.score) best = { id: sec.id, label: `${a.name} — ${b.name}`, score };
      }
    }
  }
  return best;
}

function findTrain(text: string): { id: string; number: string } | null {
  const idx = useSim.getState().idx;
  if (!idx) return null;
  const m = /(\d{1,5})/.exec(text.replace(/\s+(\d)/g, "$1"));
  if (!m) return null;
  for (const tr of idx.trains.values()) if (tr.number === m[1]) return { id: tr.id, number: tr.number };
  return null;
}

function minutes(text: string, dflt: number): number {
  const m = /на\s+(\d{1,3})\s*мин/.exec(text) ?? /(\d{1,3})\s*мин/.exec(text);
  return m ? Math.max(1, Number(m[1])) : dflt;
}

function where(ts: TrainState): string {
  const idx = useSim.getState().idx!;
  const name = (id: string | null | undefined) => (id ? idx.stations.get(id)?.name ?? id : "—");
  if (ts.section_id) {
    const sec = idx.sections.get(ts.section_id);
    return sec ? `на перегоне ${name(sec.a)} — ${name(sec.b)}` : "на перегоне";
  }
  return `на станции ${name(ts.station_id)}`;
}

function lastCardFor(id: string): DecisionCard | undefined {
  const cards = useSim.getState().cards;
  for (let i = cards.length - 1; i >= 0; i--) if (cards[i].trains.includes(id)) return cards[i];
  return undefined;
}

function explainTrain(text: string): Reply {
  const s = useSim.getState();
  const t = findTrain(text);
  if (!t) return { text: "Не понял номер поезда. Скажите, например: «почему стоит поезд 2008?»" };
  const tr = s.idx!.trains.get(t.id)!;
  const ts = s.state?.trains.find((x) => x.id === t.id);
  s.selectTrain(t.id);
  if (!ts) return { text: `Поезд № ${t.number} сейчас не на участке: ${tr.cls_label.toLowerCase()}, ${s.idx!.stations.get(tr.route[0])?.name} → ${s.idx!.stations.get(tr.route[tr.route.length - 1])?.name}.` };
  const parts = [`Поезд № ${t.number}, ${tr.cls_label.toLowerCase()}, ${where(ts)}, ${ts.delay_s < 60 ? "идёт по графику" : `опаздывает на ${Math.round(ts.delay_s / 60)} мин`}.`];
  if (ts.wait_reason) parts.push(`Ждёт: ${ts.wait_reason}.`);
  const card = lastCardFor(t.id);
  if (card) parts.push(`Решение Бағдара: ${card.action}.${card.type !== "incident" && card.reason ? ` Почему: ${card.reason}` : ""}`);
  else if (!ts.wait_reason) parts.push("Решений по нему не требовалось.");
  return { text: parts.join(" ") };
}

function listHelp(): Reply {
  return {
    text: "Умею: «закрой перегон Үшбел — Разъезд 12 на 30 минут», «сними сбой», «задержи поезд 2008 на 10 минут», "
      + "«почему стоит 2008?», «где поезд 2», «когда восстановится график?», «сколько поездов опаздывает?», "
      + "«что сейчас важно?», «как дела на участке?», «объяви пассажирам о поезде 2», «пересчитай план», «старт», «пауза», «быстрее».",
  };
}

/** Разобрать и выполнить фразу. Всегда возвращает ответ для экрана; speak — что произнести (по умолчанию то же). */
export async function runCommand(raw: string): Promise<Reply> {
  const s = useSim.getState();
  const text = raw.trim();
  const low = norm(text);
  if (!low) return { text: "Слушаю." };
  if (!s.state || !s.idx) return { text: "Сервер симуляции ещё не ответил — подождите секунду." };
  try {
    if (/(помощь|что ты умеешь|команды)/.test(low)) return listHelp();

    if (/(закр(ой|ыть|ываем)|перекр(ой|ыть))\s+перегон/.test(low)) {
      const after = low.replace(/.*перегон(а)?\s*/, "").replace(/\s+на\s+\d+\s*мин.*$/, "").replace(/\s+между\s+/, " ").replace(/\s+(и|до)\s+/, " ");
      const sec = findSection(after);
      if (!sec) return { text: `Не нашёл такой перегон: «${after}». Назовите две соседние станции, например «закрой перегон Үшбел — Разъезд 12».` };
      const min = minutes(low, 30);
      const r = await api.event({ type: "section_closed", section_id: sec.id, minutes: min });
      return { text: `Закрываю перегон ${sec.label} на ${min} мин. ${r.message}. Бағдар пересчитывает план — смотрите карточку справа.`, ok: true };
    }
    if (/(сними|убери|открой|снять)\s+(сбой|закрытие|перегон|ограничение)/.test(low)) {
      const inc = s.state.incidents.find((i) => i.restorable);
      if (!inc) return { text: "Сейчас нет сбоев, которые можно снять." };
      const r = await api.restore(inc.id);
      return { text: `Снимаю: ${inc.title}. ${r.message}`, ok: true };
    }
    if (/(задерж|придерж)/.test(low) && /поезд/.test(low)) {
      const t = findTrain(low);
      if (!t) return { text: "Не понял номер поезда. Скажите: «задержи поезд 2008 на 10 минут»." };
      const min = minutes(low, 10);
      const r = await api.event({ type: "train_delay", train_id: t.id, minutes: min });
      s.selectTrain(t.id);
      return { text: `Задерживаю поезд № ${t.number} на ${min} мин. ${r.message}.`, ok: true };
    }
    if (/пересчит/.test(low)) {
      await api.replan();
      return { text: "Пересчитываю план для всех поездов. Время пересчёта — на верхней панели.", ok: true };
    }
    if (/что\s+(сейчас\s+)?важно/.test(low)) return { text: focusMostImportant() };
    if (/(почему|что с|отчего|из за чего)/.test(low) && /(поезд|стоит|стоят|ждет|опазд|\d)/.test(low)) return explainTrain(low);
    if (/^(где)\b/.test(low) || /где\s+(поезд|он)/.test(low)) return explainTrain(low);
    if (/(когда|через сколько)/.test(low) && /(восстанов|график|норм)/.test(low)) {
      const rec = s.state.planner.recovery;
      if (!rec || rec.affected === 0) return { text: "График в норме: ни один поезд по плану не выходит за допуск." };
      const m = rec.recovery_at != null ? Math.max(1, Math.round((rec.recovery_at - s.state.t) / 60)) : null;
      return { text: `Задето ${rec.affected} ${plural(rec.affected, "поезд", "поезда", "поездов")}, сейчас вне допуска ${rec.late_now}. `
        + (m != null ? `По плану график восстановится через ${m} мин${rec.beyond_horizon ? `, ещё ${rec.beyond_horizon} — позже трёх часов` : ""}.` : "Все восстановятся позже трёх часов горизонта.") };
    }
    if (/сколько/.test(low) && /(опазд|задерж)/.test(low)) {
      const late = s.state.trains.filter((t) => t.delay_s >= 300);
      if (!late.length) return { text: "Никто не опаздывает больше пяти минут." };
      const names = late.slice(0, 5).map((t) => `${s.idx!.trains.get(t.id)?.number ?? t.id} (${delayLabel(t.delay_s)})`).join(", ");
      return { text: `Опаздывают на 5 минут и больше: ${late.length} — ${names}${late.length > 5 ? " и другие" : ""}.` };
    }
    if (/(как дела|состояние|обстановка|индекс|сводка)/.test(low)) {
      const ix = s.state.index;
      const m = s.state.metrics;
      const val = ix?.value != null ? Math.round(ix.value) : null;
      return { text: `${val != null ? `Индекс участка ${val} из 100, ${ix?.status_label?.toLowerCase() ?? ""}. ` : ""}На участке ${m.active_trains} поездов, средняя задержка ${(m.avg_delay_s / 60).toFixed(1).replace(".", ",")} мин, конфликтов впереди ${s.state.planner.conflicts}.`
        + (ix?.reasons?.length ? ` Тянет вниз: ${ix.reasons[0]}` : " Ничто заметно не тянет индекс вниз.") };
    }
    if (/объяв/.test(low)) {
      let t = findTrain(low);
      if (!t) {
        const cand = [...s.state.trains].filter((x) => (s.idx!.trains.get(x.id)?.passengers ?? 0) > 0).sort((a, b) => b.delay_s - a.delay_s)[0];
        if (cand) t = { id: cand.id, number: s.idx!.trains.get(cand.id)!.number };
      }
      if (!t) return { text: "На участке сейчас нет пассажирских поездов." };
      const tr = s.idx.trains.get(t.id)!;
      const ts = s.state.trains.find((x) => x.id === t!.id);
      const a = paAnnouncement(tr, ts, s.idx);
      s.selectTrain(t.id);
      return { text: `Готово объявление о поезде № ${t.number}:\n${a.kk}\n${a.ru}`, speak: a.ru, announcement: { kk: a.kk, ru: a.ru } };
    }
    if (/^(старт|запусти|поехали|пуск)/.test(low)) {
      await api.control({ action: "start" });
      return { text: "Запускаю время модели.", ok: true };
    }
    if (/^(пауза|стоп|стой|останови)/.test(low)) {
      await api.control({ action: "pause" });
      return { text: "Пауза.", ok: true };
    }
    if (/(быстрее|ускор)/.test(low)) {
      const sp = s.state.speed >= 30 ? 100 : s.state.speed >= 10 ? 30 : 10;
      await api.control({ action: "speed", speed: sp });
      return { text: `Скорость ×${sp}.`, ok: true };
    }
    if (/(медленнее|замедл)/.test(low)) {
      const sp = s.state.speed > 30 ? 30 : s.state.speed > 10 ? 10 : 1;
      await api.control({ action: "speed", speed: sp });
      return { text: `Скорость ×${sp}.`, ok: true };
    }
    if (/(сброс|сначала|заново)/.test(low)) {
      await api.control({ action: "reset" });
      return { text: "Начинаю ситуацию сначала.", ok: true };
    }
    if (/\d/.test(low) && /поезд/.test(low)) return explainTrain(low);
    return { text: `Не понял: «${text}». ${listHelp().text}` };
  } catch (e) {
    return { text: `Не получилось: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Готовые фразы для показа — с реальными названиями станций и номерами поездов этого участка. */
export function sampleCommands(): string[] {
  const s = useSim.getState();
  const out: string[] = [];
  if (s.world && s.idx) {
    const secs = s.world.sections;
    const sec = secs[Math.floor(secs.length / 2)];
    if (sec) out.push(`Закрой перегон ${s.idx.stations.get(sec.a)?.name} — ${s.idx.stations.get(sec.b)?.name} на 30 минут`);
    const waiting = s.state?.trains.find((t) => t.wait_reason) ?? [...(s.state?.trains ?? [])].sort((a, b) => b.delay_s - a.delay_s)[0];
    if (waiting) out.push(`Почему стоит ${s.idx.trains.get(waiting.id)?.number ?? ""}?`);
  }
  out.push("Что сейчас важно?", "Когда восстановится график?", "Объяви пассажирам", "Как дела на участке?");
  return out;
}
