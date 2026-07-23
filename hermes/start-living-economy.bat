@echo off
title MainStreet / BIII -- living economy
echo ============================================================
echo   MainStreet / BIII  --  living economy launcher
echo   Brings the local Hermes fleet up and opens the console.
echo ============================================================
echo.

REM --- 1) Hermes gateway (scheduler + biii-watch sentinel) in WSL, only if not already running.
echo [1/4] Hermes gateway (scheduler + biii-watch)...
start "hermes-gateway" /min wsl.exe bash -lc "pgrep -f 'hermes gateway run' >/dev/null && echo up || HERMES_HOME=/root/.hermes-biii exec /root/.hermes-venv/bin/hermes gateway run"

REM --- 2) Fleet console (live dashboard: who works, spend, journal), only if not already running.
echo [2/4] Fleet console -> http://localhost:4799 ...
start "fleet-console" /min wsl.exe bash -lc "pgrep -f fleet-console.js >/dev/null && echo up || HERMES_HOME=/root/.hermes-biii HERMES_BIN=/root/.hermes-venv/bin/hermes exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-console.js"

REM --- 3) Give them a moment, then open the console + confirm the live sell server.
echo [3/4] Opening the console + live services...
timeout /t 3 >nul
start "" http://localhost:4799/
start "" https://biii-production.up.railway.app/health

REM --- 4) Status.
echo.
echo   [ LIVE ON RAILWAY - always up, no local launch needed ]
echo     Sell server : https://biii-production.up.railway.app   (x402 $0.25, real settle proven)
echo     Monitor node: biii-node worker (read-only guard ON)
echo   [ LOCAL - the two minimized windows above ]
echo     Hermes gateway + biii-watch sentinel (every 30m, $0, no_agent)
echo     Fleet console : http://localhost:4799  (grid + LLM spend + run journal)
echo.
echo   Stop the local pieces: close the hermes-gateway / fleet-console windows.
echo   Resume the WORK autonomously: see the vault BOOTSTRAP-zero1-tencent.md + Fleet.md.
echo.
pause
