"""Независимая проверка плана.

Модуль намеренно не использует код генератора и планировщика: правила
слоя 0 реализованы здесь заново. Ни один перегон, путь, горловина,
локомотив или бригада не должны быть заняты несовместимыми операциями
одновременно. План с нарушениями не может считаться допустимым.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from bagdar.core.classes import TRAIN_CLASSES
from bagdar.core.rules import TimingRules
from bagdar.models.plan import Plan, PlanLeg
from bagdar.models.train import Train
from bagdar.models.world import World

EPS = 0.5  # с, допуск на округление


@dataclass(slots=True)
class Violation:
    kind: str          # section | headway | track | track_length | throat | loco | crew | runtime | dwell | closed
    resource: str
    trains: list[str]
    t: float
    message: str


@dataclass(slots=True)
class _Hold:
    train: str
    t0: float
    t1: float


def _overlap(a0: float, a1: float, b0: float, b1: float, gap: float = 0.0) -> bool:
    return a0 < b1 + gap - EPS and b0 < a1 + gap - EPS


def validate_plan(world: World, trains: dict[str, Train], plan: Plan, rules: TimingRules,
                  blocked: list[tuple[str, float, float]] | None = None) -> list[Violation]:
    out: list[Violation] = []
    by_section: dict[str, list[PlanLeg]] = defaultdict(list)
    track_holds: dict[str, list[_Hold]] = defaultdict(list)
    throat_use: dict[str, list[_Hold]] = defaultdict(list)

    for tid, legs in plan.legs.items():
        tr = trains.get(tid)
        if tr is None or not legs:
            continue
        cls = TRAIN_CLASSES[tr.cls]
        for i, leg in enumerate(legs):
            sec = world.sections[leg.section_id]
            by_section[leg.section_id].append(leg)
            # физически минимальное время хода
            vmax = min(cls.vmax_kmh, sec.speed_limit_kmh) / 3.6
            if leg.arr - leg.dep < sec.length_m / vmax - EPS:
                out.append(Violation("runtime", sec.id, [tid], leg.dep,
                                     f"Поезд {tr.number}: время хода по {sec.id} меньше физически возможного"))
            if i + 1 < len(legs):
                nxt = legs[i + 1]
                if nxt.k != leg.k + 1 or nxt.from_id != leg.to_id:
                    out.append(Violation("runtime", leg.to_id, [tid], leg.arr,
                                         f"Поезд {tr.number}: разрыв маршрута после {leg.to_id}"))
                if nxt.dep < leg.arr - EPS:
                    out.append(Violation("dwell", leg.to_id, [tid], leg.arr,
                                         f"Поезд {tr.number}: отправление раньше прибытия на {leg.to_id}"))
                stop = tr.schedule[leg.k + 1] if leg.k + 1 < len(tr.schedule) else None
                if stop is not None and stop.dwell_s > 0 and leg.stop and nxt.dep - leg.arr < stop.dwell_s - EPS:
                    out.append(Violation("dwell", leg.to_id, [tid], leg.arr,
                                         f"Поезд {tr.number}: стоянка на {leg.to_id} короче плановой"))
            # путь приёма: длина и существование
            st = world.stations[leg.to_id]
            track = next((t for t in st.tracks if t.id == leg.track_id), None)
            if track is None:
                out.append(Violation("track", leg.to_id, [tid], leg.arr,
                                     f"Поезд {tr.number}: путь {leg.track_id} не существует на {st.name}"))
            elif track.length_m < tr.length_m:
                out.append(Violation("track_length", track.id, [tid], leg.arr,
                                     f"Поезд {tr.number} ({tr.length_m} м) не помещается на путь "
                                     f"{track.name} ст. {st.name} ({track.length_m} м)"))
            # интервал занятия пути приёма
            single = sec.tracks == 1
            h0 = leg.dep if single else leg.arr - rules.approach_s
            if i + 1 < len(legs):
                h1 = legs[i + 1].dep + rules.clear_s
            elif leg.to_id == tr.route[-1]:
                h1 = leg.arr + rules.terminate_s
            else:
                h1 = leg.arr + rules.clear_s
            track_holds[leg.track_id].append(_Hold(tid, h0, h1))
            # горловины
            stopped_before = i == 0 and leg.k == 0 or (i > 0 and legs[i - 1].stop)
            d0 = leg.dep if stopped_before else leg.dep - rules.approach_s
            throat_use[sec.departure_throat(leg.direction)].append(_Hold(tid, d0, leg.dep + rules.throat_s))
            throat_use[sec.arrival_throat(leg.direction)].append(_Hold(tid, leg.arr - rules.approach_s, leg.arr))
        # путь на станции формирования
        first = legs[0]
        if first.k == 0 and tid in plan.origin_track:
            track_holds[plan.origin_track[tid]].append(
                _Hold(tid, first.dep - rules.prep_s, first.dep + rules.clear_s))

    # перегоны
    for sid, legs in by_section.items():
        sec = world.sections[sid]
        legs.sort(key=lambda lg: lg.dep)
        for i, a in enumerate(legs):
            for b in legs[i + 1:]:
                if b.dep > a.arr + max(rules.tau_cross_s, rules.headway_s) + 3600:
                    break
                if sec.tracks == 2 and a.direction != b.direction:
                    continue
                if a.direction != b.direction or sec.signalling == "PAB":
                    if _overlap(a.dep, a.arr, b.dep, b.arr, rules.tau_cross_s):
                        kind = "section"
                        what = "встречные" if a.direction != b.direction else "два поезда при ПАБ"
                        out.append(Violation(kind, sid, [a.train_id, b.train_id], max(a.dep, b.dep),
                                             f"Перегон {sid}: {what} {trains[a.train_id].number} и "
                                             f"{trains[b.train_id].number} одновременно"))
                    continue
                # попутные, b отправился не раньше a
                if b.dep < a.dep + rules.headway_s - EPS or b.arr < a.arr + rules.headway_arr_s - EPS:
                    out.append(Violation("headway", sid, [a.train_id, b.train_id], b.dep,
                                         f"Перегон {sid}: нарушен межпоездной интервал "
                                         f"{trains[a.train_id].number} → {trains[b.train_id].number}"))

    # пути станций
    for track_id, holds in track_holds.items():
        holds.sort(key=lambda h: h.t0)
        for i, a in enumerate(holds):
            for b in holds[i + 1:]:
                if b.t0 > a.t1:
                    break
                if a.train != b.train and _overlap(a.t0, a.t1, b.t0, b.t1):
                    out.append(Violation("track", track_id, [a.train, b.train], b.t0,
                                         f"Путь {track_id}: одновременно {trains[a.train].number} и "
                                         f"{trains[b.train].number}"))

    # горловины
    for th, uses in throat_use.items():
        uses.sort(key=lambda h: h.t0)
        for i, a in enumerate(uses):
            for b in uses[i + 1:]:
                if b.t0 > a.t1:
                    break
                if a.train != b.train and _overlap(a.t0, a.t1, b.t0, b.t1):
                    out.append(Violation("throat", th, [a.train, b.train], b.t0,
                                         f"Горловина {th}: два маршрута одновременно "
                                         f"({trains[a.train].number}, {trains[b.train].number})"))

    # локомотивы и бригады
    for attr, kind in (("loco_id", "loco"), ("crew_id", "crew")):
        spans: dict[str, list[_Hold]] = defaultdict(list)
        for tid, legs in plan.legs.items():
            if not legs or tid not in trains:
                continue
            spans[getattr(trains[tid], attr)].append(_Hold(tid, legs[0].dep, legs[-1].arr))
        for res, hs in spans.items():
            hs.sort(key=lambda h: h.t0)
            for a, b in zip(hs, hs[1:]):
                if _overlap(a.t0, a.t1, b.t0, b.t1):
                    out.append(Violation(kind, res, [a.train, b.train], b.t0,
                                         f"{'Локомотив' if kind == 'loco' else 'Бригада'} {res} назначен "
                                         f"на два поезда одновременно"))

    # закрытые элементы
    for res, t0, t1 in blocked or []:
        for leg in by_section.get(res, []):
            if _overlap(leg.dep, leg.arr, t0, t1):
                out.append(Violation("closed", res, [leg.train_id], max(leg.dep, t0),
                                     f"Поезд {trains[leg.train_id].number} запланирован на закрытый {res}"))
        for h in track_holds.get(res, []):
            if _overlap(h.t0, h.t1, t0, t1):
                out.append(Violation("closed", res, [h.train], max(h.t0, t0),
                                     f"Поезд {trains[h.train].number} запланирован на недоступный путь {res}"))
    return out
