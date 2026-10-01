import { api } from "../api/client";
import type { DecisionCard, SimEvent, State } from "../api/types";
import { useSim } from "../store/sim";

/** Перейти в прошлое на момент t: снимок из журнала, план того момента, лента и карточки до t. */
export async function rewindTo(t: number): Promise<void> {
  const st = useSim.getState();
  const wasRunning = st.past ? st.past.wasRunning : (st.state?.running ?? false);
  if (!st.past && wasRunning) await api.control({ action: "pause" });
  const at = await api.historyAt(t);
  // в прошлом ничего нельзя отменить или выбрать: окна решений закрыты
  const cards = (at.cards as DecisionCard[]).map((c) => ({ ...c, can_cancel: false, can_choose: false }));
  useSim.getState().enterPast(
    { t: at.t, plan: at.plan ?? null, indexHistory: at.index_history, wasRunning },
    at.state as State, at.events as SimEvent[], cards,
  );
}

/** Вернуться к текущему моменту; если до перемотки модель шла — продолжить. */
export async function backToLive(): Promise<void> {
  const past = useSim.getState().past;
  useSim.getState().exitPast();
  if (past?.wasRunning) await api.control({ action: "start" });
}
