"""WebSocket-поток /api/stream.

Начальная загрузка и переподключение:
  клиент подключается с ?world_version=N&run_id=R&last_seq=M (всё необязательно);
  сервер шлёт hello; world — только если версия мира у клиента устарела;
  events — пропущенные с last_seq (если прогон тот же) или последние события
  с reset=true; затем state. Дальше state идёт с частотой broadcast_hz,
  events — по мере появления. Так после обрыва клиент всегда согласован.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from bagdar.runtime import SimulationRuntime

log = logging.getLogger("bagdar.stream")
router = APIRouter()
PROTOCOL = 1
INITIAL_EVENTS = 400


def _dump(msg: dict) -> str:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":"))


async def _send_initial(ws: WebSocket, r: SimulationRuntime, world_version: int, run_id: str,
                        last_seq: int) -> None:
    await ws.send_text(_dump({"type": "hello", "protocol": PROTOCOL, "run_id": r.run_id,
                              "world_version": r.world_version}))
    if world_version != r.world_version:
        await ws.send_text(_dump({"type": "world", "world": r.world_payload()}))
    if run_id == r.run_id and last_seq > 0:
        events = r.events_since(last_seq)
        await ws.send_text(_dump({"type": "events", "reset": False, "events": events}))
    else:
        events = r.events_since(0)[-INITIAL_EVENTS:]
        await ws.send_text(_dump({"type": "events", "reset": True, "events": events}))
    await ws.send_text(_dump(r.state_payload()))


@router.websocket("/api/stream")
async def stream(ws: WebSocket) -> None:
    r: SimulationRuntime = ws.app.state.runtime
    await ws.accept()
    qp = ws.query_params
    try:
        world_version = int(qp.get("world_version", "0"))
        last_seq = int(qp.get("last_seq", "0"))
    except ValueError:
        world_version, last_seq = 0, 0
    run_id = qp.get("run_id", "")
    sub = r.subscribe()
    try:
        await _send_initial(ws, r, world_version, run_id, last_seq)

        async def sender() -> None:
            while True:
                text = await sub.queue.get()
                if sub.overflowed:
                    sub.overflowed = False
                    await _send_initial(ws, r, -1, "", 0)
                    continue
                await ws.send_text(text)

        async def receiver() -> None:
            while True:
                msg = await ws.receive_text()
                if msg == "ping":
                    await ws.send_text(_dump({"type": "pong"}))

        done, pending = await asyncio.wait({asyncio.create_task(sender()), asyncio.create_task(receiver())},
                                           return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                log.warning("stream task failed: %r", exc)
    except WebSocketDisconnect:
        pass
    finally:
        r.unsubscribe(sub)
