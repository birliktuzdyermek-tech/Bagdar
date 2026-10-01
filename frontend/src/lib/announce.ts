// Объявления пассажирам и сообщения машинисту — тексты, которые Бағдар готовит сам.
// Два языка, как на вокзалах Казахстана: казахский и русский. Шаблоны, без внешних сервисов.
import type { SpeedAdvice, TrainState, TrainStatic } from "../api/types";
import type { Indexed } from "../store/sim";

export interface Announcement { kk: string; ru: string; title: string }

const KK_DIGITS = (n: number) => String(n);

/** Объявление по вокзальной трансляции о поезде: опоздание или следование по графику. */
export function paAnnouncement(tr: TrainStatic, ts: TrainState | undefined, idx: Indexed): Announcement {
  const from = idx.stations.get(tr.route[0])?.name ?? tr.route[0];
  const to = idx.stations.get(tr.route[tr.route.length - 1])?.name ?? tr.route[tr.route.length - 1];
  const delay = Math.round((ts?.delay_s ?? 0) / 60);
  const next = ts?.next_station_id ?? ts?.station_id;
  const nextName = next ? idx.stations.get(next)?.name ?? next : null;
  const pax = tr.passengers > 0;
  const kind = pax ? "жолаушылар пойызы" : "жүк пойызы";
  const kindRu = (tr.cls_label || "поезд").toLowerCase();
  const kk = delay >= 1
    ? `Құрметті жолаушылар! ${from} — ${to} бағытындағы № ${KK_DIGITS(Number(tr.number) || 0) || tr.number} ${kind} ${delay} минутқа кешігіп келеді${nextName ? `, келесі аялдама — ${nextName}` : ""}. Қолайсыздық үшін кешірім сұраймыз.`
    : `Құрметті жолаушылар! ${from} — ${to} бағытындағы № ${tr.number} ${kind} кесте бойынша жүріп келеді${nextName ? `, келесі аялдама — ${nextName}` : ""}.`;
  const ru = delay >= 1
    ? `Уважаемые пассажиры! Поезд № ${tr.number}, ${kindRu}, сообщением ${from} — ${to}, прибывает с опозданием на ${delay} ${plural(delay, "минуту", "минуты", "минут")}${nextName ? `, следующая остановка — ${nextName}` : ""}. Приносим извинения за неудобства.`
    : `Уважаемые пассажиры! Поезд № ${tr.number}, ${kindRu}, сообщением ${from} — ${to}, следует по графику${nextName ? `, следующая остановка — ${nextName}` : ""}.`;
  return { kk, ru, title: `Объявление о поезде № ${tr.number}` };
}

/** Что передать машинисту по радиосвязи из совета скорости. */
export function driverMessage(tr: TrainStatic, a: SpeedAdvice): string {
  const slower = a.v_rec_kmh < a.v_full_kmh;
  return slower
    ? `Машинисту поезда ${tr.number}. Бағдар рекомендует скорость ${a.v_rec_kmh} километров в час. ${a.text}. Экономия около ${Math.round(a.saving_kwh)} киловатт-часов.`
    : `Машинисту поезда ${tr.number}. Путь свободен, ход по лимиту ${a.v_limit_kmh} километров в час.`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
