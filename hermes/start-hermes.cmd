@echo off
REM ============================================================================
REM  start-hermes.cmd  —  run the MainStreet/BIII living economy STANDALONE.
REM  Double-click this (or run it from a Windows cmd). It does NOT depend on the
REM  Claude terminal — it keeps the Hermes gateway alive so the keyless watchdog
REM  (biii-watch, every 30m) fires and on-demand agents can run, on its own.
REM
REM  Economy = one local Hermes with 5 toolsets: biii + gitlawb + lawbor + monid
REM  + recall (our Obsidian/mainstreet memory). Read-only guard stays on.
REM  Close this window to stop the gateway.
REM ============================================================================
title Hermes - MainStreet/BIII living economy (gateway)
echo(
echo   Starting the Hermes gateway...
echo   - fires biii-watch (Base trust scan) every 30m, keyless, $0 spend
echo   - keep this window OPEN; close it to stop.
echo(
REM Kill any gateway already running so we never double-bind, then start fresh.
wsl.exe bash -lc "pkill -f 'hermes gateway run' 2>/dev/null; sleep 1; export HERMES_HOME=/root/.hermes-biii; export PATH=/usr/local/bin:/usr/bin:/bin; cd /root/.hermes-biii; exec /root/.hermes-venv/bin/hermes gateway run"
echo(
echo   Gateway stopped. Press any key to close.
pause >nul
