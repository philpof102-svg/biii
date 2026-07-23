#!/usr/bin/env bash
# fleet-run.sh — launch ONE living-economy service in the FOREGROUND (via exec) so the wsl.exe window
# that calls it stays alive keeping the service up. Called by start-living-economy.bat as:
#   wsl.exe bash <this> gateway   |   wsl.exe bash <this> console
# If the service is already running, exit 0 immediately (the window just closes).
export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}
export HERMES_HOME=/root/.hermes-biii
export HERMES_BIN=/root/.hermes-venv/bin/hermes

case "$1" in
  gateway)
    pgrep -f 'hermes gateway run' >/dev/null && { echo "gateway already up"; sleep 2; exit 0; }
    echo "starting hermes gateway..."
    exec /root/.hermes-venv/bin/hermes gateway run
    ;;
  console)
    pgrep -f fleet-console.js >/dev/null && { echo "fleet console already up"; sleep 2; exit 0; }
    echo "starting fleet console on :4799..."
    exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/fleet-console.js
    ;;
  *)
    echo "usage: fleet-run.sh gateway|console"; sleep 2; exit 2
    ;;
esac
