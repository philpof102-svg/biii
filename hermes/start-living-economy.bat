@echo off
title MainStreet / BIII -- living economy
echo ============================================================
echo   MainStreet / BIII  --  living economy launcher
echo ============================================================
echo.

echo [1/3] Hermes gateway (scheduler + biii-watch sentinel)...
start "hermes-gateway" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh gateway

echo [2/4] Fleet console on http://localhost:4799 ...
start "fleet-console" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh console

echo [3/4] Hermes dashboard on http://localhost:4711 (sessions/config; first run builds, be patient)...
start "hermes-dashboard" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh dashboard

echo [4/4] Opening the consoles + confirming the live sell server...
timeout /t 4 >nul
start "" http://localhost:4799/
start "" https://biii-production.up.railway.app/health

echo.
echo   Fleet console : http://localhost:4799       grid + LLM spend + run journal
echo   Sell server   : biii-production.up.railway.app   LIVE, x402 0.25 USDC
echo   Sentinel      : biii-watch, every 30m, free (no_agent)
echo.
echo   The two minimized windows (hermes-gateway / fleet-console) keep the local
echo   pieces alive. Close them to stop. Railway services stay up on their own.
echo.
pause
