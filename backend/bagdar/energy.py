"""Советчик скорости машинисту: подъехать к станции к моменту, когда путь свободен.

Модель прозрачная и относительная, это не тяговый расчёт:

- расход на ход — работа против сопротивления движению на остатке перегона:
  E_ход = m·g·w(v)·s, удельное сопротивление w(v) = 1,0 + 0,00025·v² Н/кН (v в км/ч);
- остановка и разгон — потерянная кинетическая энергия E_стоп = m·v²/2.

Для поезда на перегоне берётся момент, когда план отпускает его дальше: для
проходящего поезда — вход на следующий перегон, для поезда с остановкой — прибытие
на путь приёма. Если на полном ходу поезд пришёл бы раньше и встал у входного
светофора, советуется скорость, при которой он подойдёт ровно к этому моменту.
Скорость выше лимита перегона (с учётом ограничений и неисправных светофоров)
не советуется никогда, ниже 25 км/ч — тоже: тянуться дольше бессмысленно.
"""
from __future__ import annotations

from bagdar.core.kinematics import G, stop_energy_kwh

V_MIN_KMH = 25.0
W0, W2 = 1.0, 0.00025          # удельное сопротивление движению, Н/кН: W0 + W2·v²
EARLY_S = 30.0                 # раньше нужного меньше чем на 30 с — совет «полный ход»
MIN_LEFT_M = 400.0             # на подходе к станции совет уже не меняют


def run_energy_kwh(mass_t: float, v_ms: float, dist_m: float) -> float:
    v = v_ms * 3.6
    return mass_t * G * (W0 + W2 * v * v) * dist_m / 3.6e6


def _hhmm(t: float) -> str:
    t = int(round(t)) % 86400
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}"


def advise(eng, rt) -> dict | None:
    """Совет для поезда на перегоне или None (стоит, на станции, у самого входного)."""
    if rt.status != "section":
        return None
    tr = rt.train
    k = rt.k
    sec = eng.world.sections[tr.sections[k]]
    d = eng.world.direction(sec, tr.route[k])
    left = sec.length_m - rt.dist
    if left < MIN_LEFT_M:
        return None
    vmax = eng._vmax(rt, sec, d)                 # м/с, уже с ограничениями
    limit_kmh = vmax * 3.6
    now = eng.t
    st = eng.world.stations[tr.route[k + 1]]
    must_stop = eng._planned_stop(rt, k)
    leg = eng.ex.leg(tr.id, k)
    nxt = eng.ex.leg(tr.id, k + 1) if k + 1 < len(tr.sections) else None
    if not must_stop and nxt is not None:
        t_go, what = nxt.dep, "перегон впереди освободится"
    elif leg is not None:
        t_go, what = leg.arr, "путь приёма будет готов"
    else:
        t_go, what = None, ""
    t_full = now + left / max(vmax, 1.0)
    base = {"v_limit_kmh": round(limit_kmh), "v_full_kmh": round(limit_kmh)}
    m = tr.mass_t
    if t_go is None or t_go <= t_full + EARLY_S:
        e = run_energy_kwh(m, vmax, left) + (stop_energy_kwh(m, vmax) if must_stop else 0.0)
        return {**base, "v_rec_kmh": round(limit_kmh), "e_full_kwh": round(e, 1), "e_rec_kwh": round(e, 1),
                "saving_kwh": 0.0, "saving_pct": 0.0, "stop_avoided": False, "wait_full_s": 0,
                "text": f"Путь свободен: ход по лимиту {round(limit_kmh)} км/ч"}
    v_need = left / max(1.0, t_go - now)
    v_rec = min(vmax, max(V_MIN_KMH / 3.6, v_need))
    reach = v_need >= V_MIN_KMH / 3.6            # успевает подойти без остановки
    wait_full = t_go - t_full
    # полный ход: приход раньше, остановка у входного и разгон потом
    e_full = run_energy_kwh(m, vmax, left) + stop_energy_kwh(m, vmax)
    e_rec = run_energy_kwh(m, v_rec, left) + (stop_energy_kwh(m, v_rec) if (must_stop or not reach) else 0.0)
    saving = max(0.0, e_full - e_rec)
    v_txt = round(v_rec * 3.6)
    if must_stop:
        text = (f"По плану стоянка на ст. {st.name}, {what} к {_hhmm(t_go)}: хватит {v_txt} км/ч. "
                f"На полном ходу поезд ждал бы {round(wait_full / 60)} мин")
    elif reach:
        text = (f"{what.capitalize()} в {_hhmm(t_go)}: при {v_txt} км/ч поезд подойдёт к ст. {st.name} без "
                f"остановки. На полном ходу {round(limit_kmh)} км/ч — {round(wait_full / 60)} мин у входного")
    else:
        text = (f"{what.capitalize()} только в {_hhmm(t_go)}: остановки не избежать, но на {v_txt} км/ч она "
                f"короче и дешевле")
    return {**base, "v_rec_kmh": v_txt, "e_full_kwh": round(e_full, 1), "e_rec_kwh": round(e_rec, 1),
            "saving_kwh": round(saving, 1), "saving_pct": round(100 * saving / e_full, 1) if e_full > 0 else 0.0,
            "stop_avoided": (not must_stop) and reach, "wait_full_s": round(wait_full), "text": text}


def fleet_summary(advice: list[dict]) -> dict:
    """Сводка по всем поездам на перегонах: сколько дадут советы прямо сейчас."""
    act = [a for a in advice if a]
    return {"trains": len(act), "slowed": sum(1 for a in act if a["v_rec_kmh"] < a["v_full_kmh"]),
            "stops_avoided": sum(1 for a in act if a["stop_avoided"]),
            "saving_kwh": round(sum(a["saving_kwh"] for a in act), 1)}
