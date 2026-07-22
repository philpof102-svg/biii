@echo off
REM ============================================================================
REM  fleet-console.cmd — the LIVE fleet dashboard of the living economy.
REM  Double-click it, then open  http://localhost:4799  in your browser.
REM  Real status (gateway, cron, toolsets, biii /health + x402), auto-refresh 12s.
REM  Keep this window OPEN; close it to stop.
REM ============================================================================
title Fleet console - MainStreet living economy (localhost:4799)
echo(
echo   Fleet console  ^-^>  http://localhost:4799
echo   live: gateway + cron + toolsets + biii /health + x402   (refresh 12s)
echo   keep this window OPEN; close it to stop.
echo(
wsl.exe bash -lc "pkill -f 'fleet-console.js' 2>/dev/null; sleep 1; export HERMES_HOME=/root/.hermes-biii; export PATH=/usr/local/bin:/usr/bin:/bin; exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-console.js"
echo(
echo   Console stopped. Press any key to close.
pause >nul
