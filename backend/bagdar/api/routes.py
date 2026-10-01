"""REST-эндпоинты. Команды идут через REST, обновления — через поток."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from bagdar import __version__, dto
from bagdar.api import schemas as S
from bagdar.config import BagdarConfig
from bagdar.runtime import SimulationRuntime

router = APIRouter(prefix="/api")


def rt(request: Request) -> SimulationRuntime:
    return request.app.state.runtime


@router.get("/health", response_model=S.HealthOut, tags=["service"])
def health(request: Request) -> dict:
    return {"status": "ok", "version": __version__, "world_loaded": rt(request).engine is not None}


@router.get("/world", response_model=S.WorldOut, tags=["state"],
            summary="Инфраструктура участка и состав поездов с исходным расписанием")
def get_world(request: Request) -> dict:
    return rt(request).world_payload()


@router.get("/state", response_model=S.StateOut, tags=["state"], summary="Текущее состояние участка")
def get_state(request: Request) -> dict:
    return rt(request).state_payload()


@router.get("/plan", response_model=S.PlanOut, tags=["planner"], summary="Действующий или предыдущий план")
def get_plan(request: Request, which: str = Query("current", pattern="^(current|previous)$")) -> dict:
    r = rt(request)
    assert r.engine is not None
    plan = r.engine.ex.plan if which == "current" else r.planner.previous
    if plan is None:
        raise HTTPException(404, "Предыдущего плана ещё нет")
    return dto.plan_dto(plan)


@router.get("/decisions", response_model=S.DecisionsOut, tags=["planner"], summary="Лента карточек решений")
def get_decisions(request: Request, since: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=300)) -> dict:
    r = rt(request)
    cards = [c for c in r.planner.cards if c.get("seq", 0) > since]
    return {"run_id": r.run_id, "cards": cards[-limit:]}


@router.get("/planner", response_model=S.PlannerOut, tags=["planner"],
            summary="Статус планировщика и история пересчётов (время, решатель, J)")
def get_planner(request: Request) -> dict:
    r = rt(request)
    return {"summary": r.planner.summary(), "history": list(r.planner.history)}


@router.post("/plan/replan", response_model=S.PlannerSummaryOut, tags=["planner"], summary="Пересчитать план сейчас")
def replan(request: Request) -> dict:
    r = rt(request)
    r.planner.request("запрос диспетчера", urgent=True)
    if r.planner.sync:
        r.planner.tick()
    return r.planner.summary()


@router.post("/events", response_model=S.EventAck, tags=["simulation"],
             summary="Внешнее событие (в демо: задержка поезда; сбои — этап 4)")
def post_event(body: S.EventIn, request: Request) -> dict:
    r = rt(request)
    try:
        msg = r.external_event(body.type, body.model_dump(exclude_none=True))
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e)) from e
    return {"ok": True, "message": msg}


@router.get("/events", response_model=S.EventsOut, tags=["state"], summary="Журнал событий текущего прогона")
def get_events(request: Request, since: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=20000),
               min_severity: S.Severity = "debug") -> dict:
    r = rt(request)
    return {"run_id": r.run_id, "events": r.events_since(since, limit, min_severity)}


@router.get("/scenarios", response_model=list[S.ScenarioOut], tags=["scenarios"])
def get_scenarios(request: Request) -> list[dict]:
    return [{"id": s.id, "title": s.title, "summary": s.summary.strip(), "mode": s.mode, "seed": s.seed,
             "start_time": s.start_time, "difficulty": s.difficulty, "wave": s.wave,
             "disruptions": len(s.disruptions)} for s in rt(request).scenarios.values()]


@router.post("/sim/control", response_model=S.ControlOut, tags=["simulation"],
             summary="Старт, пауза, ускорение ×1…×100, шаг, сброс")
def sim_control(body: S.ControlIn, request: Request) -> dict:
    r = rt(request)
    try:
        r.control(body.action, speed=body.speed, step_s=body.step_s)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    assert r.engine is not None
    return {"running": r.running, "speed": r.speed, "t": r.engine.t, "run_id": r.run_id}


@router.post("/sim/load", response_model=S.LoadOut, tags=["simulation"],
             summary="Загрузить сценарий и/или сгенерировать мир с новым seed")
def sim_load(body: S.LoadIn, request: Request) -> dict:
    r = rt(request)
    if body.scenario_id is not None and body.scenario_id not in r.scenarios:
        raise HTTPException(404, f"Сценарий {body.scenario_id} не найден")
    try:
        r.load(body.scenario_id, body.seed)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    assert r.scenario is not None and r.engine is not None
    return {"world_version": r.world_version, "run_id": r.run_id, "scenario_id": r.scenario.id,
            "seed": r.engine.seed, "trains_total": len(r.trains), "load_ms": r.perf["load_ms"]}


@router.get("/config", response_model=BagdarConfig, tags=["config"], summary="Веса, пороги, параметры")
def get_config(request: Request) -> BagdarConfig:
    return rt(request).cfg


@router.get("/stream/schema", response_model=S.StreamSchema, tags=["stream"],
            summary="Формат сообщений WebSocket /api/stream на живых данных")
def stream_schema(request: Request) -> dict:
    r = rt(request)
    return {
        "hello": {"type": "hello", "protocol": 1, "run_id": r.run_id, "world_version": r.world_version},
        "world": {"type": "world", "world": r.world_payload()},
        "events": {"type": "events", "reset": True, "events": r.events_since(0)[-20:]},
        "state": r.state_payload(),
        "decisions": {"type": "decisions", "reset": True, "cards": list(r.planner.cards)[-10:]},
    }
