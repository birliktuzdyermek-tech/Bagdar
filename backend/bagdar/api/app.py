"""Сборка FastAPI-приложения."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from bagdar import __version__
from bagdar.api.routes import router as rest_router
from bagdar.api.stream import router as stream_router
from bagdar.config import load_config
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios

DESCRIPTION = """
**Бағдар** — консультативный автодиспетчер железнодорожного участка.

Демонстрационный прототип на синтетических данных. **Не система управления
движением**: не управляет реальными сигналами, стрелками и поездами и не
заменяет устройства СЦБ. Веса, цены и «сэкономленные деньги» условные.

Поток реального времени: `ws /api/stream` (формат — `GET /api/stream/schema`).
"""


def create_app(autostart_loop: bool = True, planner_sync: bool = False) -> FastAPI:
    logging.basicConfig(level=os.environ.get("BAGDAR_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    runtime = SimulationRuntime(cfg, load_scenarios(), planner_sync=planner_sync)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime.load(os.environ.get("BAGDAR_SCENARIO", "normal"))
        if autostart_loop:
            await runtime.start()
        yield
        await runtime.stop()

    app = FastAPI(title="Бағдар API", version=__version__, description=DESCRIPTION, lifespan=lifespan)
    app.state.runtime = runtime
    origins = [o for o in os.environ.get("BAGDAR_CORS_ORIGINS", "http://localhost:5173").split(",") if o]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])
    app.include_router(rest_router)
    app.include_router(stream_router)

    # Собранный фронтенд (если есть) раздаётся тем же сервером.
    dist = Path(os.environ.get("BAGDAR_FRONTEND_DIST", Path(__file__).resolve().parents[3] / "frontend" / "dist"))
    if dist.is_dir():
        mount_spa(app, dist)

    return app


def mount_spa(app: FastAPI, dist: Path) -> None:
    """Раздать собранный фронтенд: файлы из dist, на остальные пути — index.html.

    Путь из URL проверяется после resolve(): закодированные «..%2F», «%2e%2e»
    и обратные слэши не должны выводить за пределы dist.
    """
    root = dist.resolve()
    if (root / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path:
            try:
                target = (root / path).resolve()
            except (OSError, ValueError):
                target = None
            if target is not None and target.is_relative_to(root) and target.is_file():
                return FileResponse(target)
        return FileResponse(root / "index.html")


app = create_app()
