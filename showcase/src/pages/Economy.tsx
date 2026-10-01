import { useEffect, useMemo, useState } from "react";
import { money, perMin } from "../lib/money";
import { compare } from "../meet/model";
import "./economy.css";

// Тарифы счётчиков — как в backend/config (TariffConfig), в условных единицах; показываем в тенге.
const TARIFFS = [
  { key: "delay_min_pax", ue: 10, per: "мин", title: "Минута опоздания пассажирского поезда",
    why: "Время сотен людей, сорванные пересадки, компенсации. Поэтому пассажирская минута дороже грузовой в пять раз." },
  { key: "delay_min_freight", ue: 2, per: "мин", title: "Минута опоздания грузового поезда",
    why: "Штрафы по договору перевозки, срыв сроков доставки, вагоны и локомотив заняты дольше." },
  { key: "kwh", ue: 0.05, per: "кВт·ч", title: "Киловатт-час энергии",
    why: "Каждая лишняя остановка — энергия, потраченная на торможение и повторный разгон: E = m·v²/2." },
  { key: "loco_hour", ue: 30, per: "ч", title: "Час простоя локомотива",
    why: "Локомотив стоит и не везёт, а кредит и обслуживание идут." },
  { key: "crew_hour", ue: 15, per: "ч", title: "Час простоя бригады",
    why: "Машинист с помощником ждут, рабочая смена уходит — иногда поезд приходится бросать до новой бригады." },
];

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export function Economy() {
  useEffect(() => {
    document.title = "Откуда берутся деньги — Бағдар";
  }, []);
  const [mass, setMass] = useState(5000);
  const [wait, setWait] = useState(8);
  const [pax, setPax] = useState(600);
  const [late, setLate] = useState(10);
  const ex = useMemo(() => compare({ freight: { mass_t: mass } }), [mass]);
  const fr = ex.trains.freight;
  const stopKwh = fr.stop_kwh;
  const energyCost = stopKwh * 0.5;                  // c_stop планировщика
  const idleCost = wait * 2;                           // c_idle планировщика, у.е./мин
  const paxW = 70 * Math.max(0.5, pax / 500);          // скорый: 70 у.е./мин × пассажиры/500
  const paxCost = late * paxW;

  return (
    <div className="eco-page">
      <section className="eco-hero">
        <p className="eco-kicker">Экономика простыми словами</p>
        <h1>Откуда берутся деньги</h1>
        <p className="lead">
          Железная дорога не печатает чек за каждое решение диспетчера. Поэтому в модели есть <b>единая линейка</b>: каждая
          минута опоздания, каждый лишний киловатт-час и каждый час простоя переводятся в тенге по тарифам.
          Тарифы условные — их можно подставить свои, и все цифры на экранах пересчитаются.
        </p>
      </section>

      <section className="eco-block">
        <h2>Три источника потерь</h2>
        <div className="eco-three">
          <article>
            <span className="eco-ico" aria-hidden>⏱</span>
            <h3>Время</h3>
            <p>Поезд пришёл позже графика. У пассажирского — это время людей, у грузового — срок доставки. Считается в поездо-минутах и умножается на тариф минуты.</p>
          </article>
          <article>
            <span className="eco-ico" aria-hidden>⚡</span>
            <h3>Энергия</h3>
            <p>Остановить поезд и снова разогнать — выбросить его кинетическую энергию. Грузовой {nf.format(fr.mass_t)} т на {fr.v_kmh} км/ч теряет <b>{nf.format(stopKwh)} кВт·ч</b> за одну неплановую остановку.</p>
          </article>
          <article>
            <span className="eco-ico" aria-hidden>👷</span>
            <h3>Простой</h3>
            <p>Пока поезд стоит сверх графика, стоят локомотив и бригада. Час простоя — тариф локомотива плюс тариф бригады.</p>
          </article>
        </div>
      </section>

      <section className="eco-block">
        <h2>Тарифы счётчиков</h2>
        <p className="muted">Эти цены использует «Сводка» и «Человек против Бағдара». По умолчанию 1 условная единица модели = 1 000 ₸. Меняются в симуляторе: ⚙ Настройки → Деньги.</p>
        <table className="eco-table">
          <thead><tr><th>За что</th><th>Тариф</th><th>Почему это стоит денег</th></tr></thead>
          <tbody>
            {TARIFFS.map((t) => (
              <tr key={t.key}>
                <td><b>{t.title}</b></td>
                <td className="tabular nowrap">{money(t.ue, { short: false })}/{t.per}</td>
                <td className="muted">{t.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="eco-block">
        <h2>Как Бағдар выбирает план: веса минуты</h2>
        <p className="muted">
          Когда Бағдар решает, кого пропустить первым, он считает цену каждого варианта по тем же трём источникам, но минута у каждого
          поезда своя — это <b>вес</b>. Так модель выражает приоритеты: пассажиры важнее груза, полный поезд важнее пустого,
          срочный груз важнее обычного. Этими весами считаются карточки решений и сцена «Кто первым?».
        </p>
        <div className="eco-weights">
          <div><span>Скоростной</span><b>{perMin(100)}</b></div>
          <div><span>Скорый</span><b>{perMin(70)}</b></div>
          <div><span>Пассажирский</span><b>{perMin(50)}</b></div>
          <div><span>Ускоренный грузовой</span><b>{perMin(30)}</b></div>
          <div><span>Грузовой</span><b>{perMin(10)}</b></div>
          <div><span>Сборный</span><b>{perMin(5)}</b></div>
        </div>
        <ul className="eco-mult">
          <li><b>× пассажиров / 500</b> — у пассажирских: 600 человек → ×1,2; 40 человек → ×0,5 (не меньше).</li>
          <li><b>× 1,5</b> — срочный или скоропортящийся груз · <b>× 2</b> — истекает срок доставки · <b>× 1,3</b> — опасный груз.</li>
          <li><b>× 2</b> — у бригады заканчивается смена · <b>× 1,2 за каждые 10 мин</b> — поезд уже опаздывает сверх допуска.</li>
          <li><b>Остановка</b> — {money(0.5, { short: false })} за кВт·ч потерянной энергии (на подъёме ×4) · <b>простой</b> — {perMin(2)}.</li>
          <li><b>ПТЭ выше денег:</b> задержать старший поезд сверх допуска ради младшего — штраф {perMin(5000)}, такой план проигрывает всегда.</li>
        </ul>
      </section>

      <section className="eco-block eco-calc">
        <h2>Посчитайте сами</h2>
        <div className="eco-calc-grid">
          <div className="eco-calc-card">
            <h3>Остановили грузовой</h3>
            <label>Масса состава <b>{nf.format(mass)} т</b><input type="range" min={1000} max={9000} step={100} value={mass} onChange={(e) => setMass(Number(e.target.value))} /></label>
            <label>Простоял <b>{wait} мин</b><input type="range" min={1} max={40} value={wait} onChange={(e) => setWait(Number(e.target.value))} /></label>
            <dl>
              <dt>Энергия на торможение и разгон</dt><dd>{nf.format(stopKwh)} кВт·ч × {money(0.5, { short: false })} = <b>{money(energyCost)}</b></dd>
              <dt>Простой локомотива и бригады</dt><dd>{wait} мин × {perMin(2)} = <b>{money(idleCost)}</b></dd>
              <dt>Итого за одну остановку</dt><dd className="eco-total">{money(energyCost + idleCost)}</dd>
            </dl>
            <p className="small muted">Если грузовой укладывается в запас по графику, опоздания к нему не добавляется.</p>
          </div>
          <div className="eco-calc-card">
            <h3>Задержали пассажирский</h3>
            <label>Пассажиров <b>{nf.format(pax)}</b><input type="range" min={0} max={1500} step={10} value={pax} onChange={(e) => setPax(Number(e.target.value))} /></label>
            <label>Опоздал на конечную на <b>{late} мин</b><input type="range" min={1} max={60} value={late} onChange={(e) => setLate(Number(e.target.value))} /></label>
            <dl>
              <dt>Вес минуты скорого</dt><dd>70 × {nf.format(Math.max(0.5, pax / 500))} = <b>{perMin(paxW)}</b></dd>
              <dt>Опоздание</dt><dd>{late} мин × {perMin(paxW)} = <b>{money(paxCost)}</b></dd>
              <dt>Итого</dt><dd className="eco-total">{money(paxCost)}</dd>
            </dl>
            <p className="small muted">Плюс штраф ПТЭ, если 3 минуты допуска скорого превышены ради грузового.</p>
          </div>
        </div>
      </section>

      <section className="eco-block">
        <h2>Где это видно</h2>
        <ul className="eco-where">
          <li><a href="#/meet">Кто поедет первым?</a> — цена двух вариантов одной встречи с разбором по статьям.</li>
          <li><b>Карточки решений</b> в симуляторе — «альтернатива дороже на …» для каждого скрещения и обгона.</li>
          <li><b>Сводка</b> в симуляторе — потери за прогон по статьям, в час и всего; оттуда же отчёт PDF.</li>
          <li><b>Человек против Бағдара</b> — тот же поток без плана и с планом, разница в тенге.</li>
        </ul>
        <p className="small muted">
          Консультативный прототип. Все суммы условные: модель умножает минуты, кВт·ч и часы на тарифы, которые задаёте вы.
          Реальных расценок перевозчика здесь нет и не обещается.
        </p>
      </section>
    </div>
  );
}
