"""Выгрузка OpenAPI-схемы в backend/openapi.json (из неё генерируются TS-типы фронтенда)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bagdar.api.app import create_app  # noqa: E402

out = Path(__file__).resolve().parents[1] / "openapi.json"
out.write_text(json.dumps(create_app(autostart_loop=False).openapi(), ensure_ascii=False, indent=1), encoding="utf-8")
print(f"OpenAPI → {out}")
