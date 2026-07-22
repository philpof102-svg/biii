#!/usr/bin/env bash
# Keyless watchdog — run the biii-monitor scan and print its brief to stdout.
# `hermes cron create '30m' --script biii-scan.sh --no-agent` delivers this stdout verbatim (no model key).
# Install: cp this to ~/.hermes-biii/scripts/biii-scan.sh and set BIII_DIR to your biii checkout.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"   # cron's exec env may lack node — make it resolvable
BIII_DIR="${BIII_DIR:-$HOME/biii}"
MON="$BIII_DIR/hermes/agents/biii-monitor"
exec node "$MON/scan.js" "$MON/watchlist.json"
