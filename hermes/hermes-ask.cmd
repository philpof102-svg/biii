@echo off
REM ============================================================================
REM  hermes-ask.cmd  —  ask the living-economy agent ONE thing, from a Windows cmd.
REM  Independent of the Claude terminal. The agent has the read-only guard on.
REM  Toolsets: biii (safe-to-pay) + gitlawb + lawbor + recall (our memory).
REM  (monid is OAuth/remote and not -t-selectable; omit -t in a custom run to add it.)
REM
REM  Usage:   hermes-ask "your prompt here"  [model]
REM  Models:  tencent/hy3        (default — cheap, routine RC)
REM           moonshotai/kimi-k3 (hard RC — 1M ctx, pricier; the Kimi 3 model)
REM
REM  Examples:
REM    hermes-ask "use memory_search to recall what we decided about buzz"
REM    hermes-ask "vet Base address 0x... with till_trust" moonshotai/kimi-k3
REM ============================================================================
setlocal
if "%~1"=="" (
  echo Usage: hermes-ask "prompt" [model]
  echo   default model: tencent/hy3   ^|   hard RC: moonshotai/kimi-k3
  exit /b 1
)
set "HERMES_PROMPT=%~1"
set "HERMES_MODEL=%~2"
if "%HERMES_MODEL%"=="" set "HERMES_MODEL=tencent/hy3"
REM Share the two vars into WSL (/u = pass Win32 -> WSL) so bash reads them
REM directly — no fragile quote-nesting through the cmd -> wsl arg boundary.
set "WSLENV=HERMES_PROMPT/u:HERMES_MODEL/u"
wsl.exe bash -lc "export HERMES_HOME=/root/.hermes-biii; export PATH=/usr/local/bin:/usr/bin:/bin; exec /root/.hermes-venv/bin/hermes -z \"$HERMES_PROMPT\" -m \"$HERMES_MODEL\" -t biii,gitlawb,lawbor,recall"
endlocal
