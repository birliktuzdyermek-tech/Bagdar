"""Преобразование внутреннего состояния в контракт API (плоские dict).

Формы словарей описаны pydantic-схемами в bagdar.api.schemas; контрактный
тест проверяет, что они совпадают. Словари собираются напрямую, без
промежуточных моделей, чтобы поток состояния оставался дешёвым.
"""
from __future__ import annotations

from bagdar.config import BagdarConfig
from bagdar.core.classes import TRAIN_CLASSES
from bagdar.models.plan import Plan
from bagdar.models.train import Train
from bagdar.models.world import World
from bagdar.sim.engine import Engine, TrainRT
from bagdar.energy import advise, fleet_summary


def _r(x: float | None, nd: int = 1) -> float | None:
    return None if x is None else round(x, nd)


def train_static(t: Train) -> dict:
    return {
        "id": t.id, "number": t.number, "cls": t.cls, "cls_label": TRAIN_CLASSES[t.cls].label,
        "pte_rank": t.pte_rank, "direction": t.direction, "length_m": t.length_m, "mass_t": t.mass_t,
        "passengers": t.passengers, "cargo": t.cargo, "traction": t.traction, "vmax_kmh": t.vmax_kmh,
        "loco_id": t.loco_id, "crew_id": t.crew_id, "crew_shift_end": _r(t.crew_shift_end),
        "route": t.route, "sections": t.sections, "suburban": t.suburban, "transfer": t.transfer,
        "schedule": [{"station_id": s.station_id, "arr": _r(s.arr), "dep": _r(s.dep), "stop": s.stop,
                      "dwell_s": _r(s.dwell_s), "track_id": s.track_id} for s in t.schedule],
    }


def world_dto(world: World, trains: list[Train], cfg: BagdarConfig, *, version: int, scenario_id: str,
              start_time: float, generation: dict) -> dict:
    return {
        "id": world.id, "mode": world.mode, "seed": world.seed, "name": world.name, "version": version,
        "scenario_id": scenario_id, "start_time": start_time, "date": "2026-10-01", "tz": "+05:00",
        "zones": [{"id": z.id, "name": z.name, "station_ids": z.station_ids} for z in world.zones.values()],
        "stations": [{
            "id": s.id, "name": s.name, "kind": s.kind, "km": s.km, "x": s.x, "y": s.y,
            "zone_id": s.zone_id, "crew_change": s.crew_change,
            "tracks": [{"id": t.id, "name": t.name, "length_m": t.length_m, "is_main": t.is_main}
                       for t in s.tracks],
        } for s in sorted(world.stations.values(), key=lambda s: s.km)],
        "sections": [{
            "id": s.id, "a": s.a, "b": s.b, "length_km": s.length_km, "tracks": s.tracks,
            "signalling": s.signalling, "blocks": s.blocks, "speed_limit_kmh": s.speed_limit_kmh,
            "gradient_permille": s.gradient_permille, "no_stop_uphill": s.no_stop_uphill,
            "electrified": s.electrified, "throat_a": s.throat_a, "throat_b": s.throat_b,
        } for s in world.sections.values()],
        "signals": [{"id": g.id, "section_id": g.section_id, "station_id": g.station_id,
                     "direction": g.direction} for g in world.signals.values()],
        "switches": [{"id": w.id, "station_id": w.station_id, "track_id": w.track_id, "number": w.number}
                     for w in world.switches.values()],
        "trains": [train_static(t) for t in trains],
        "classes": [{"key": c.key, "label": c.label, "pte_rank": c.pte_rank,
                     "weight": cfg.weight(c.key), "tolerance_min": cfg.tolerance_s(c.key) / 60}
                    for c in TRAIN_CLASSES.values()],
        "generation": generation,
    }


def _display_status(eng: Engine, rt: TrainRT) -> str:
    if rt.status == "station":
        if rt.k == len(rt.train.route) - 1:
            return "terminated"
        if rt.wait_reason:
            return "held"
        return "ready" if rt.k == 0 else "dwell"
    if rt.status == "section":
        if rt.v < 0.05:
            return "stopped"
        return "braking" if rt.v_target < rt.v - 0.5 or (not rt.through and rt.arr_route) else "running"
    return rt.status


def train_state(eng: Engine, rt: TrainRT) -> dict:
    tr = rt.train
    sec_id = None
    progress = None
    station_id = None
    if rt.status == "section":
        sec = eng.world.sections[tr.sections[rt.k]]
        sec_id = sec.id
        f = min(1.0, max(0.0, rt.dist / sec.length_m))
        d = eng.world.direction(sec, tr.route[rt.k])
        progress = f if d > 0 else 1.0 - f
        next_station = tr.route[rt.k + 1]
    else:
        station_id = tr.route[rt.k]
        next_station = tr.route[rt.k + 1] if rt.k + 1 < len(tr.route) else None
    return {
        "id": tr.id, "status": rt.status, "display": _display_status(eng, rt), "k": rt.k,
        "station_id": station_id, "track_id": rt.track_id, "section_id": sec_id,
        "progress": _r(progress, 4), "v_kmh": _r(rt.v * 3.6), "v_target_kmh": _r(rt.v_target * 3.6),
        "delay_s": round(eng.live_delay(rt)), "wait_reason": rt.wait_reason,
        "dest_track": rt.dest_track, "through": rt.through, "next_station_id": next_station,
        "crew_left_s": round(tr.crew_shift_end - eng.t), "stops": rt.stops,
        "unplanned_stops": rt.unplanned_stops, "stop_energy_kwh": _r(rt.stop_energy_kwh),
        "advice": advise(eng, rt),
    }


def state_dto(eng: Engine, *, running: bool, speed: float, run_id: str, world_version: int,
              perf: dict) -> dict:
    il, now = eng.il, eng.t
    trains = [train_state(eng, rt) for rt in eng.active()]
    return {
        "type": "state", "run_id": run_id, "world_version": world_version, "seq": eng.seq,
        "tick": eng.steps, "t": round(now, 1), "running": running, "speed": speed,
        "trains": trains,
        "advice": fleet_summary([t["advice"] for t in trains]),
        "sections": [{
            "id": sid, "status": s.status, "single": s.single, "restriction_kmh": s.restriction_kmh,
            "occupants": list(s.occupants),
            "dir": (s.dirs[s.occupants[0]] if s.occupants and s.single else 0),
        } for sid, s in il.sections.items()],
        "tracks": [{"id": tid, "occupant": t.occupant, "reserved": t.reserved, "available": t.available}
                   for tid, t in il.tracks.items()],
        "throats": [{"id": th_id, "holder": th.holder} for th_id, th in il.throats.items()
                    if th.busy_until > now],
        "signals": [{"id": sig_id, "state": sig.state(now)} for sig_id, sig in il.signals.items()
                    if sig.state(now) != "closed"],
        "metrics": eng.metrics(),
        "perf": perf,
    }


def plan_dto(plan: Plan) -> dict:
    return {
        "version": plan.version, "created_at": plan.created_at, "solver": plan.solver,
        "status": plan.status, "compute_ms": round(plan.compute_ms, 1), "notes": plan.notes,
        "cost": plan.cost, "horizon_end": plan.horizon_end, "hold_all": plan.hold_all, "held": plan.held,
        "legs": [{"train_id": lg.train_id, "k": lg.k, "section_id": lg.section_id, "from_id": lg.from_id,
                  "to_id": lg.to_id, "direction": lg.direction, "dep": round(lg.dep, 1),
                  "arr": round(lg.arr, 1), "track_id": lg.track_id, "stop": lg.stop}
                 for lg in plan.all_legs()],
    }
