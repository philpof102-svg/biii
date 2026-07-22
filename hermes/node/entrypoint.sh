#!/usr/bin/env bash
# Container entrypoint for the always-on BIII Hermes trust node (Layer 2).
# READ-ONLY: the baked pre_tool_call guard blocks every write/spend. No wallet key lives here —
# only OPENROUTER_API_KEY, injected by the host (Railway service variable), never in the image.
set -euo pipefail

: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY in the Railway service variables (from your agent-veille/.env value)}"

export BIII_DIR=/app/biii
export LAWBOR_DIR=/app/lawbor
export GL_BIN="$(command -v gl || echo /usr/local/bin/gl)"
export GITLAWB_NODE="${GITLAWB_NODE:-https://node.gitlawb.com}"
export MAINSTREET_URL="${MAINSTREET_URL:-https://avisradar-production.up.railway.app}"
export HERMES_MODEL="${HERMES_MODEL:-tencent/hy3}"
export HERMES_HOME="${HERMES_HOME:-/app/home}"
mkdir -p "$HERMES_HOME"

# render config from the portable template
envsubst < "$BIII_DIR/hermes/node/config.template.yaml" > "$HERMES_HOME/config.yaml"

# recall (our private second-brain) ONLY if MEMORY_ROOTS is provided — off by default on a public host
if [ -n "${MEMORY_ROOTS:-}" ]; then
  cat >> "$HERMES_HOME/config.yaml" <<EOF
  recall:
    command: node
    args:
      - $BIII_DIR/hermes/memory-mcp.js
    enabled: true
    env:
      MEMORY_ROOTS: "$MEMORY_ROOTS"
EOF
fi

cp -f "$BIII_DIR/hermes/agents/biii-monitor/SOUL.md" "$HERMES_HOME/SOUL.md"
umask 077; printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" > "$HERMES_HOME/.env"

# keyless watchdog: biii-watch every 30m ($0, no key) — the whole point of an always-on node
hermes cron create 'every 30m' \
  --script "$BIII_DIR/hermes/agents/biii-monitor/biii-scan.sh" \
  --no-agent --deliver local >/dev/null 2>&1 || true

echo "▸ BIII trust node up (READ-ONLY) — HERMES_HOME=$HERMES_HOME model=$HERMES_MODEL"
echo "  toolsets: biii + gitlawb$([ -f "$LAWBOR_DIR/bin/lawbor-mcp.js" ] && echo ' + lawbor')$([ -n "${MEMORY_ROOTS:-}" ] && echo ' + recall') · guard: on · watchdog: biii-watch/30m"
exec hermes gateway run
