@echo off
REM deploy.cmd — Deploy to Railway + test vet-meme.html (autonome script)
REM Usage: deploy.cmd [environment]
REM Default: production (biii-production.up.railway.app)

setlocal enabledelayedexpansion

set "ENV=%~1"
if "%ENV%"=="" set "ENV=production"

echo [1/5] Building...
cd /d %~dp0
call build.cmd "chore: pre-deploy build"

echo [2/5] Pushing to GitHub...
git push origin master
if errorlevel 1 (
  echo ⚠ Git push failed (maybe already up to date)
) else (
  echo ✓ Pushed to GitHub
)

echo [3/5] Deploying to Railway...
if "%ENV%"=="production" (
  echo Deploying to: biii-production
  railway up --environment production
) else (
  echo Deploying to: %ENV%
  railway up --environment %ENV%
)

echo [4/5] Testing vet-meme.html live...
timeout /t 10 /nobreak > nul
curl -s -o nul -w "%%{http_code}" https://biii-production.up.railway.app/vet-meme.html
if errorlevel 1 (
  echo ⚠ Live test failed (curl not available)
) else (
  echo ✓ vet-meme.html is live
)

echo [5/5] Done!
echo.
echo Next steps:
echo 1. Test vet-meme.html manually: https://biii-production.up.railway.app/vet-meme.html
echo 2. Replace demo watchlist in biii-watch with real targets
echo 3. Recharge OpenRouter key before $0
endlocal
