#!/usr/bin/env bash
# Start the BIII Hermes trust node's gateway (keyless watchdog scheduler + on-demand agents).
# Read-only by design. Keep this process alive; run it under a supervisor for always-on.
set -euo pipefail
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes-biii}"
HERMES_BIN="${HERMES_BIN:-$HOME/.hermes-venv/bin/hermes}"
# load OPENROUTER_API_KEY from the node's .env if present (never committed)
if [ -f "$HERMES_HOME/.env" ]; then set -a; . "$HERMES_HOME/.env"; set +a; fi
: "${OPENROUTER_API_KEY:?no OPENROUTER_API_KEY — set it or put it in $HERMES_HOME/.env}"
echo "▸ gateway up (HERMES_HOME=$HERMES_HOME) — biii-watch fires on schedule; Ctrl-C to stop."
exec "$HERMES_BIN" gateway run
