#!/usr/bin/env bash
# Запуск для разработки: backend на :8000, фронтенд (Vite) на :5173.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"
python3 -m uvicorn bagdar.api.app:app --host 0.0.0.0 --port 8000 --reload &
BACK=$!
trap 'kill $BACK 2>/dev/null || true' EXIT
cd "$ROOT/frontend"
npx vite --port 5173
