"""Поезда, которые появляются во время прогона: рост потока, внеочередные,
поезда сценария. Расписание — «идеальная нитка» каждого поезда без учёта
остальных (заявка на проезд): опоздание считается от неё, а вписать поезд в
движение — задача планировщика.
"""
from __future__ import annotations

import random

from bagdar.core.classes import TRAIN_CLASSES
from bagdar.core.rules import TimingRules
from bagdar.generator.timetable import TimetableBuilder
from bagdar.generator.trains_gen import TrainSpec, _Numbers
from bagdar.models.train import Train
from bagdar.models.world import World

NUM_KEY = {"high_speed_passenger": "high_speed_passenger", "fast_passenger": "fast_passenger",
           "passenger": "passenger", "express_freight": "express_freight", "freight": "freight",
           "local_freight": "local_freight", "light_engine": "light_engine", "extraordinary": "extraordinary"}


def _line(world: World) -> list[str]:
    return [s.id for s in sorted(world.stations.values(), key=lambda s: s.km)]


def make_trains(world: World, rules: TimingRules, existing: list[Train], items: list[dict],
                seed: int) -> list[Train]:
    """items: [{cls, direction, dep, length_m?, mass_t?, cargo?, from_idx?, to_idx?}]."""
    rng = random.Random(seed)
    used = {int(t.number) for t in existing if t.number.isdigit()}
    base = _Numbers().next
    line = _line(world)

    def take(key: str, d: int) -> int:
        n = base[key][d]
        while n in used:
            n += 2
        used.add(n)
        return n

    out: list[Train] = []
    for it in items:
        cls = it.get("cls", "freight")
        d = int(it.get("direction", 1))
        i0, i1 = int(it.get("from_idx", 0)), int(it.get("to_idx", len(line) - 1))
        seg = line[i0:i1 + 1]
        route = seg if d > 0 else list(reversed(seg))
        number = take(NUM_KEY.get(cls, "freight"), d)
        info = TRAIN_CLASSES[cls]
        freight = cls in ("freight", "express_freight", "local_freight")
        length = int(it.get("length_m") or (rng.choice([650, 750, 850, 950]) if freight else
                                             300 if cls != "extraordinary" else 250))
        mass = int(it.get("mass_t") or (rng.randint(3500, 6000) if freight else 900))
        spec = TrainSpec(
            id=f"t{number}", number=str(number), cls=cls, direction=d, route=route, desired_dep=float(it["dep"]),
            dwell={}, length_m=length, mass_t=mass,
            passengers=int(it.get("passengers", 0 if freight or cls == "extraordinary" else 400)),
            cargo=list(it.get("cargo", [])), traction="electric" if cls != "extraordinary" else "diesel",
            loco_id=f"{'TE33A' if cls == 'extraordinary' else 'KZ8A'}-{rng.randint(1000, 9999)}",
            crew_id=f"Б-{rng.randint(1000, 9999)}", crew_hours=float(it.get("crew_hours", 8.0)), fixed_time=True)
        builder = TimetableBuilder(world, rules)       # пустая таблица: нитка без учёта других
        att = builder.insert(spec)
        if att is None:
            raise ValueError(f"Нельзя построить нитку для поезда класса {info.label}")
        tr = builder._make_train(spec, att)
        out.append(tr)
    return out
