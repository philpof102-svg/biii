@echo off
REM build.cmd — Build + test + commit (autonome script for Windows)
REM Usage: build.cmd [commit-message]

setlocal enabledelayedexpansion

set "MSG=%~1"
if "%MSG%"=="" set "MSG=chore: auto-build update"

echo [1/4] Running tests...
cd /d %~dp0
node test/holders-health.test.js
if errorlevel 1 (
  echo ✗ holders-health tests failed
  exit /b 1
)
node test/usdc-filter.test.js
if errorlevel 1 (
  echo ✗ usdc-filter tests failed
  exit /b 1
)
echo ✓ Tests passed

echo [2/4] Linting...
REM Add linting if available (e.g., npm run lint)

echo [3/4] Git add + commit...
git add -A
git commit -m "%MSG%"
if errorlevel 1 (
  echo ⚠ Git commit failed (maybe nothing to commit)
) else (
  echo ✓ Committed: %MSG%
)

echo [4/4] Done!
endlocal
