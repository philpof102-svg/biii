#!/usr/bin/env bash
# fleet-run.sh — launch ONE living-economy service in the FOREGROUND (via exec) so the wsl.exe window
# that calls it stays alive keeping the service up. Called by start-living-economy.bat as:
#   wsl.exe bash <this> gateway   |   wsl.exe bash <this> console   |   wsl.exe bash <this> dashboard
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
  dashboard)
    # The Hermes native dashboard (sessions / config / keys). MUST run with HERMES_HOME=/root/.hermes-biii
    # (already exported above) or it reads the empty default home and shows "no sessions". First launch
    # runs npm ci + a frontend build (slow, a few minutes); after that it's fast.
    pgrep -f 'hermes dashboard' >/dev/null && { echo "dashboard already up"; sleep 2; exit 0; }
    echo "starting hermes dashboard on :4711 (first run builds the frontend, be patient)..."
    exec "$HERMES_BIN" dashboard --port 4711 --host 127.0.0.1 --no-open
    ;;
  *)
    echo "usage: fleet-run.sh gateway|console|dashboard"; sleep 2; exit 2
    ;;
esac
