"""REST-эндпоинты. Команды идут через REST, обновления — через поток."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response

from bagdar import __version__, dto
from bagdar.api import schemas as S
from bagdar.config import AutonomyConfig, BagdarConfig
from bagdar.planner.conflicts import shift_plan
from bagdar.planner.runner import ActionError
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


@router.get("/plan", response_model=S.PlanOut, tags=["planner"],
            summary="Действующий, предыдущий или прогнозный план (действующий, сдвинутый на текущие отклонения)")
def get_plan(request: Request, which: str = Query("current", pattern="^(current|previous|projected)$")) -> dict:
    r = rt(request)
    assert r.engine is not None
    if which == "projected":
        return dto.plan_dto(shift_plan(r.engine, r.engine.ex.plan))
    plan = r.engine.ex.plan if which == "current" else r.planner.previous
    if plan is None:
        raise HTTPException(404, "Предыдущего плана ещё нет")
    return dto.plan_dto(plan)


@router.get("/decisions", response_model=S.DecisionsOut, tags=["planner"], summary="Лента карточек решений")
def get_decisions(request: Request, since: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=300)) -> dict:
    r = rt(request)
    cards = [c for c in r.planner.cards if c.get("seq", 0) > since]
    return {"run_id": r.run_id, "cards": cards[-limit:]}


@router.post("/decisions/{card_id}/action", response_model=S.ActionResultOut, tags=["planner"],
             summary="Действие диспетчера: отменить решение B или выбрать вариант C",
             responses={409: {"description": "Окно закрыто, поезд уже на перегоне или вариант недопустим"}})
def decision_action(card_id: str, body: S.DecisionActionIn, request: Request) -> dict:
    r = rt(request)
    try:
        msg = r.decision_action(card_id, body.action, body.variant_id)
    except ActionError as e:
        raise HTTPException(409, str(e)) from e
    return {"ok": True, "message": msg}


@router.post("/autonomy", response_model=AutonomyConfig, tags=["planner"],
             summary="Переключатель «полный авто»: A и B сразу, C — лучшим вариантом")
def set_autonomy(body: S.AutonomyIn, request: Request) -> dict:
    return rt(request).set_autonomy(body.full_auto)


@router.get("/index", response_model=S.IndexHistoryOut, tags=["state"],
            summary="Индекс эффективности: текущий, прогноз на час по плану, история")
def get_index(request: Request, since: float | None = Query(None)) -> dict:
    return rt(request).index_payload(since)


@router.get("/saturation", response_model=S.SaturationOut, tags=["planner"],
            summary="Радар насыщения и варианты придержания грузовых (оценка на 4 ч вперёд)")
def get_saturation(request: Request) -> dict:
    return rt(request).saturation_payload()


@router.get("/traces", response_model=S.TracesOut, tags=["state"],
            summary="Факт движения для графика: точки [t, км] по поездам после since")
def get_traces(request: Request, since: float = Query(0.0)) -> dict:
    return rt(request).traces_since(since)


@router.get("/occupancy", response_model=S.OccupancyOut, tags=["planner"],
            summary="Занятость путей и перегонов для Ганта: факт + действующий или предыдущий план")
def get_occupancy(request: Request, which: str = Query("current", pattern="^(current|previous)$"),
                  t_from: float | None = Query(None), t_to: float | None = Query(None),
                  at: float | None = Query(None, description="Перемотка: показать занятость на момент at")) -> dict:
    return rt(request).occupancy(which, t_from, t_to, at)


@router.get("/history", response_model=S.HistoryOut, tags=["history"],
            summary="Журнал прогона: что записано и какой интервал доступен для перемотки")
def get_history(request: Request) -> dict:
    return rt(request).history_payload()


@router.get("/history/at", response_model=S.HistoryAtOut, tags=["history"],
            summary="Перемотка: состояние, план, лента, карточки и индекс на момент t")
def get_history_at(request: Request, t: float = Query(...)) -> dict:
    try:
        return rt(request).history_at(t)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


def _range(t_from: float | None, t_to: float | None, last_min: float | None, now: float) -> tuple:
    if last_min is not None:
        return now - last_min * 60, now
    return t_from, t_to


@router.get("/export/events.csv", tags=["export"], summary="CSV: события прогона (из журнала)")
def export_events(request: Request, t_from: float | None = None, t_to: float | None = None,
                  last_min: float | None = Query(None, ge=1, le=1440)) -> Response:
    from bagdar.export import csv_events
    r = rt(request)
    a, b = _range(t_from, t_to, last_min, r.engine.t)
    return Response(csv_events(r, a, b), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="bagdar-events-{r.run_id}.csv"'})


@router.get("/export/plan.csv", tags=["export"], summary="CSV: действующий план по поездам")
def export_plan(request: Request) -> Response:
    from bagdar.export import csv_plan
    r = rt(request)
    return Response(csv_plan(r), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="bagdar-plan-{r.run_id}.csv"'})


@router.get("/export/report.pdf", tags=["export"],
            summary="PDF: период, показатели, инциденты, изменения плана, вывод")
def export_pdf(request: Request, t_from: float | None = None, t_to: float | None = None,
               last_min: float | None = Query(None, ge=1, le=1440)) -> Response:
    from bagdar.export import pdf_report
    r = rt(request)
    a, b = _range(t_from, t_to, last_min, r.engine.t)
    return Response(pdf_report(r, a, b), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="bagdar-report-{r.run_id}.pdf"'})


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
             summary="Внешнее событие или сбой: задержка, закрытие перегона, отказ светофора или стрелки, "
                     "недоступный путь, ограничение скорости, рост потока, внеочередной поезд")
def post_event(body: S.EventIn, request: Request) -> dict:
    r = rt(request)
    try:
        msg = r.external_event(body.type, body.model_dump(exclude_none=True))
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e)) from e
    return {"ok": True, "message": msg}


@router.get("/incidents", response_model=S.IncidentsOut, tags=["simulation"],
            summary="Инциденты прогона с разбором «до / после» и таймерами")
def get_incidents(request: Request) -> dict:
    r = rt(request)
    tl = [{"t": t, "kind": k, "source": src, "params": p} for t, _, k, p, src in r.incidents.timeline]
    return {"run_id": r.run_id, "incidents": r.incidents.payload(), "timeline": tl}


@router.post("/incidents/{inc_id}/restore", response_model=S.EventAck, tags=["simulation"],
             summary="Снять сбой раньше таймера (открыть перегон, починить светофор или стрелку)")
def restore_incident(inc_id: str, request: Request) -> dict:
    r = rt(request)
    try:
        msg = r.restore_incident(inc_id)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return {"ok": True, "message": msg}


@router.get("/events", response_model=S.EventsOut, tags=["state"], summary="Журнал событий текущего прогона")
def get_events(request: Request, since: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=20000),
               min_severity: S.Severity = "debug") -> dict:
    r = rt(request)
    return {"run_id": r.run_id, "events": r.events_since(since, limit, min_severity)}


@router.get("/scenarios", response_model=list[S.ScenarioOut], tags=["scenarios"])
def get_scenarios(request: Request) -> list[dict]:
    from bagdar.incidents import KINDS
    return [{"id": s.id, "title": s.title, "summary": s.summary.strip(), "mode": s.mode, "seed": s.seed,
             "start_time": s.start_time, "difficulty": s.difficulty, "wave": s.wave,
             "disruptions": len(s.disruptions), "situation": s.situation, "plain": s.plain.strip(),
             "events": [{"at": d.at, "type": d.type, "label": KINDS.get(d.type, d.type)} for d in s.disruptions]}
            for s in rt(request).scenarios.values()]


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


@router.get("/versus", response_model=S.VersusOut, tags=["versus"],
            summary="Человек против Бағдара: счёт обеих сторон и состояние левой (без Бағдара)")
def get_versus(request: Request, state: bool = True) -> dict:
    return rt(request).versus.payload(with_state=state)


@router.post("/versus/start", response_model=S.VersusOut, tags=["versus"],
             summary="Запустить сценарий дважды: слева «кто первый пришёл», справа Бағдар")
def start_versus(body: S.VersusStartIn, request: Request) -> dict:
    r = rt(request)
    if body.scenario_id and body.scenario_id not in r.scenarios:
        raise HTTPException(404, f"Сценарий {body.scenario_id} не найден")
    r.versus.start(body.scenario_id, body.seed)
    return r.versus.payload(with_state=False)


@router.post("/versus/stop", response_model=S.VersusOut, tags=["versus"])
def stop_versus(request: Request) -> dict:
    r = rt(request)
    r.versus.stop()
    return r.versus.payload()


@router.post("/versus/hold", response_model=S.EventAck, tags=["versus"],
             summary="Решение человека слева: придержать поезд на станции")
def versus_hold(body: S.VersusHoldIn, request: Request) -> dict:
    try:
        return {"ok": True, "message": rt(request).versus.hold(body.train_id, body.minutes)}
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/settings", response_model=S.SettingsOut, tags=["config"],
            summary="Настройки, меняемые на лету: веса и пороги индекса, строгий ПТЭ, тарифы")
def get_settings(request: Request) -> dict:
    return rt(request).settings_payload()


@router.put("/settings", response_model=S.SettingsOut, tags=["config"],
            summary="Изменить веса и пороги индекса, строгий ПТЭ, тарифы (без перезапуска)")
def put_settings(body: S.SettingsIn, request: Request) -> dict:
    try:
        return rt(request).apply_settings(body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/meet", response_model=S.MeetOut, response_model_by_alias=True, tags=["planner"],
             summary="«Кто первым?»: пассажирский и грузовой навстречу на однопутном перегоне — цена обоих порядков")
def post_meet(body: S.MeetIn, request: Request) -> dict:
    from bagdar import meet
    p = meet.MeetIn(section_km=body.section_km, speed_limit_kmh=body.speed_limit_kmh, gap_min=body.gap_min,
                    pax=meet.PaxIn(**body.pax.model_dump()), freight=meet.FreightIn(**body.freight.model_dump()),
                    pte_strict=body.pte_strict)
    return meet.compare(p, rt(request).cfg)


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
