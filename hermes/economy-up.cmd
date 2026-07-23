@echo off
title MainStreet / BIII -- economy up (one command)
echo ============================================================
echo   MainStreet / BIII  --  living economy, one command
echo   gateway + sentinel + fleet agents + console + dashboard
echo ============================================================
echo.

echo [1/5] Hermes gateway (scheduler)...
start "hermes-gateway" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh gateway

echo [2/5] Fleet console on http://localhost:4799 ...
start "fleet-console" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh console

echo [3/5] Hermes dashboard on http://localhost:4711 (first run builds; be patient)...
start "hermes-dashboard" /min wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-run.sh dashboard

echo [4/5] Registering the fleet agents (from economy/agents.json)...
timeout /t 3 >nul
wsl.exe bash /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy-register.sh

echo [5/5] Opening the console + confirming the live sell server...
start "" http://localhost:4799/
start "" https://biii-production.up.railway.app/health

echo.
echo   Console   : http://localhost:4799     grid + spend + sessions + journal
echo   Dashboard : http://localhost:4711     Hermes native (sessions/config)
echo   Sell srv  : biii-production.up.railway.app   LIVE, x402 0.25 USDC
echo.
echo   Fleet agents are declared in hermes\economy\agents.json.
echo   The free sentinel (biii-watch) is ON. LLM agents are OFF by default
echo   (each run costs OpenRouter credits) - flip "enabled" to true to schedule.
echo.
pause
