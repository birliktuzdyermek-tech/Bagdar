# Запуск для разработки в Windows PowerShell: backend на :8000, фронтенд (Vite) на :5173.
# Файл сохранён в UTF-8 с BOM: без него Windows PowerShell 5.1 ломает русские строки.
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Backend идёт из backend\.venv, если оно есть, иначе из python в PATH.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

$Py = Join-Path $Backend ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { $Py = (Get-Command python -ErrorAction Stop).Source }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "Не найден npx: установите Node.js 20.19+ и перезапустите терминал."
}
if (-not (Test-Path (Join-Path $Frontend "node_modules"))) {
    Write-Host "Устанавливаю зависимости фронтенда (npm ci)..."
    Push-Location $Frontend; try { npm ci } finally { Pop-Location }
}

$env:PYTHONUTF8 = "1"   # русские сообщения в логах без ошибок кодировки
$back = Start-Process -FilePath $Py -WorkingDirectory $Backend -NoNewWindow -PassThru `
    -ArgumentList "-m", "uvicorn", "bagdar.api.app:app", "--host", "127.0.0.1", "--port", "8000", "--reload"
try {
    Push-Location $Frontend
    npx vite --port 5173
} finally {
    Pop-Location
    if (-not $back.HasExited) { & taskkill /PID $back.Id /T /F | Out-Null }
}
