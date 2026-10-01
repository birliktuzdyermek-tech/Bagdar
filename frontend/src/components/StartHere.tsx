import { api } from "../api/client";
import { useSim } from "../store/sim";

const KEY = "bagdar-start-hidden";

export function readStartHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Подсказка «С чего начать» для первого взгляда на пульт: три шага и две кнопки, которые делают их за вас. */
export function StartHere({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  const setError = useSim((s) => s.setError);
  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* хранилище недоступно */
    }
    onClose();
  };
  const demo = async () => {
    try {
      await api.load({ scenario_id: "closure" });
      await api.control({ action: "speed", speed: 60 });
      await api.control({ action: "start" });
      setError(null);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="start-here" aria-label="С чего начать">
      <div className="start-head">
        <b>С чего начать</b>
        <span className="muted">— это пульт диспетчера участка из 20 станций. Три шага:</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={close} aria-label="Скрыть подсказку">Понятно, скрыть ✕</button>
      </div>
      <ol className="start-steps">
        <li><b>▶ Старт</b> — поезда поедут. Скорость <b>×30</b> — удобно смотреть.</li>
        <li><b>Сломайте что-нибудь</b>: внизу в карточке «Сбои» или на вкладке «Сценарии» запустите готовую ситуацию.</li>
        <li><b>Справа «Решения Бағдара»</b>: что он поменял в плане, почему, и во сколько обошёлся бы другой вариант.</li>
      </ol>
      <div className="start-actions">
        <button className="btn btn-primary" onClick={demo} title="Загрузит сценарий «Закрытие перегона» и включит ×60: через ~30 с закроется перегон и Бағдар перестроит план">
          ▶ Запустить готовый показ: закрытие перегона
        </button>
        <button className="btn" onClick={onTour}>🎓 Объяснить экран за 2 минуты</button>
        <span className="muted small">Ничего не отрепетировано: каждый раз план считается заново.</span>
      </div>
    </section>
  );
}
