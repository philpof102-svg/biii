@echo off
REM continuous-loop.cmd - deep scan BIII en continu (toutes les 30 min).
REM
REM REECRIT LE 2026-07-27. La version precedente avait trois defauts:
REM
REM   1. "Scan termine" avec une coche verte etait imprime INCONDITIONNELLEMENT: errorlevel n'etait
REM      jamais lu, donc un scan qui plantait affichait un succes. Le meme motif que partout ailleurs
REM      dans ce depot — un echec qui se lit comme une reussite.
REM   2. Un fichier de log horodate etait ecrit toutes les 30 minutes et JAMAIS purge: 48 par jour,
REM      environ 17 500 par an. Cette machine a deja subi un volume plein ayant corrompu une base et
REM      fait tomber le service; une boucle infinie qui ecrit sans borne est la meme trajectoire.
REM      On garde desormais les 96 derniers (48 h) et on supprime au-dela.
REM   3. L'horodatage decoupait %date% par positions fixes, ce qui depend de la LOCALE: sur un Windows
REM      francais "27/07/2026" donnait 2026-27-07, jour et mois intervertis, et les logs ne se triaient
REM      donc pas dans l'ordre. On passe par WMIC, qui rend toujours AAAAMMJJHHMMSS.
REM
REM   (BIII_DIR etait aussi defini et jamais utilise: retire.)

setlocal enabledelayedexpansion

set "MONITOR_DIR=%~dp0"
set "LOG_DIR=%MONITOR_DIR%cache"
set "INTERVAL_MIN=30"
set "GARDER=96"

echo BIII Deep Scan - boucle continue
echo ========================================
echo Intervalle : %INTERVAL_MIN% minutes
echo Logs       : %LOG_DIR%  (les %GARDER% derniers sont conserves)
echo.

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:loop
REM Format independant de la locale: AAAAMMJJHHMMSS.
for /f "usebackq tokens=1 delims=." %%T in (`wmic os get LocalDateTime ^| findstr /r "^[0-9]"`) do set "TS=%%T"
if not defined TS set "TS=inconnu"

echo.
echo [!TS!] deep scan...
echo ========================================

node "%MONITOR_DIR%deep-scan.js" "%MONITOR_DIR%watchlist.json" > "%LOG_DIR%\scan_!TS!.log" 2>&1
set "CODE=!errorlevel!"

REM Le code de sortie est LU avant d'annoncer quoi que ce soit.
if "!CODE!"=="0" (
  echo Scan termine.  Log: %LOG_DIR%\scan_!TS!.log
) else (
  echo ECHEC du scan ^(code !CODE!^) -- voir %LOG_DIR%\scan_!TS!.log
)

REM Purge: ne garder que les %GARDER% logs les plus recents. Sans borne, cette boucle remplit le disque.
for /f "skip=%GARDER% delims=" %%F in ('dir /b /o-d "%LOG_DIR%\scan_*.log" 2^>nul') do del "%LOG_DIR%\%%F" >nul 2>&1

echo Attente %INTERVAL_MIN% minutes...
timeout /t 1800 /nobreak > nul

goto loop

endlocal
