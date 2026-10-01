"""Рабочее время локомотивных бригад: кто по плану не доедет до пункта смены до конца смены.

Реальная боль диспетчера: бригада выработала время — поезд встаёт на перегоне и ждёт подмену,
за ним встают остальные. Бағдар смотрит на план: когда каждый поезд по плану прибудет на ближайшую
станцию смены бригад (или на конечную), и сравнивает с концом смены. Планировщик уже удваивает вес
минуты такого поезда (train_weight), то есть пропускает его первым; здесь — предупреждение диспетчеру.
"""
from __future__ import annotations

WARN_S = 30 * 60      # запас меньше получаса — предупреждение


def crew_risks(rt) -> dict:
    eng = rt.engine
    world = eng.world
    plan = rt.planner.current
    now = eng.t
    out = []
    for r in eng.active():
        tr = r.train
        route = tr.route
        start = r.k if r.status == "station" else r.k + 1
        if start >= len(route):
            continue
        # ближайший пункт смены бригад по маршруту, иначе конечная
        target = len(route) - 1
        for i in range(start, len(route)):
            if world.stations[route[i]].crew_change:
                target = i
                break
        if target == r.k and r.status == "station":
            continue                                   # уже стоит на пункте смены
        arr = None
        legs = plan.legs.get(tr.id, []) if plan else []
        for lg in legs:
            if lg.k == target - 1:
                arr = lg.arr
                break
        if arr is None:
            sched = tr.schedule[target].arr
            if sched is None:
                continue
            arr = sched + eng.live_delay(r)
        margin = tr.crew_shift_end - arr
        if margin >= WARN_S:
            continue
        st = world.stations[route[target]]
        status = "critical" if margin < 0 else "warning"
        left = tr.crew_shift_end - now
        where = st.name + (" (смена бригад)" if st.crew_change else " (конечная)")
        if margin < 0:
            text = (f"Бригаде поезда {tr.number} осталось {_hm(left)}, а до ст. {where} по плану он доедет в "
                    f"{_hhmm(arr)} — на {_hm(-margin)} позже конца смены. Риск остановки на перегоне и ожидания подмены.")
        else:
            text = (f"Бригаде поезда {tr.number} осталось {_hm(left)}; до ст. {where} по плану в {_hhmm(arr)} — "
                    f"запас всего {_hm(margin)}.")
        hint = ("Бағдар уже удвоил вес минуты этого поезда — его пропускают в первую очередь. "
                "Если запаса не хватит: заказать подменную бригаду на ближайшую станцию по ходу или держать поезд там, где есть бригада.")
        out.append({"train_id": tr.id, "number": tr.number, "cls": tr.cls, "status": status, "left_s": round(left),
                    "shift_end": tr.crew_shift_end, "target_station_id": st.id, "target_station": st.name,
                    "target_crew_change": st.crew_change, "arr": round(arr, 1), "margin_s": round(margin),
                    "text": text, "hint": hint})
    out.sort(key=lambda x: x["margin_s"])
    return {"t": round(now, 1), "risks": out}


def _hm(s: float) -> str:
    s = max(0, int(round(s)))
    h, m = s // 3600, (s % 3600) // 60
    return f"{h} ч {m:02d} мин" if h else f"{m} мин"


def _hhmm(t: float) -> str:
    t = int(round(t)) % 86400
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}"
