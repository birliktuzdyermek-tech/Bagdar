"""Выгрузка OpenAPI-схемы в backend/openapi.json (из неё генерируются TS-типы фронтенда)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bagdar.api.app import create_app  # noqa: E402

out = Path(__file__).resolve().parents[1] / "openapi.json"
# newline="\n": на Windows write_text иначе пишет CRLF, и файл расходится с закоммиченным
with open(out, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(json.dumps(create_app(autostart_loop=False).openapi(), ensure_ascii=False, indent=1))
# ASCII-вывод: консоль Windows с cp1251 не печатает «→» и роняет скрипт
print(f"OpenAPI -> {out}")
