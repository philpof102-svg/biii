#!/usr/bin/env bash
# ============================================================================
#  BIII Hermes trust NODE — bootstrap.sh
#  Stand up the read-only living-economy agent on ANY Linux host, identical
#  everywhere. This is Layer 1 of "no single point of failure": the brain is a
#  portable, versioned repo; run it on N always-on hosts and killing one does
#  not stop the swarm. gitlawb makes it portable + coordinated — it does NOT
#  run it; this script is what runs it.
#
#  SAFETY: READ-ONLY by design. The pre_tool_call guard blocks every write/spend
#  across biii/gitlawb/lawbor/base. NEVER put a wallet key on this node. A node
#  that is hard to kill must stay a MONITOR, not an actor.
#
#  Usage:
#    OPENROUTER_API_KEY=sk-or-... bash bootstrap.sh
#  Optional env:
#    HERMES_NODE_HOME   (default ~/.hermes-biii)   MEMORY_ROOTS (default empty = no recall)
#    BIII_REPO LAWBOR_REPO HERMES_REPO             HERMES_MODEL (default tencent/hy3)
#    WORK               (default ~/hermes-node-src)
# ============================================================================
set -euo pipefail

HERMES_NODE_HOME="${HERMES_NODE_HOME:-$HOME/.hermes-biii}"
WORK="${WORK:-$HOME/hermes-node-src}"
BIII_REPO="${BIII_REPO:-https://github.com/philpof102-svg/biii.git}"
LAWBOR_REPO="${LAWBOR_REPO:-https://github.com/philpof102-svg/lawbor.git}"
HERMES_REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_MODEL="${HERMES_MODEL:-tencent/hy3}"
GITLAWB_NODE="${GITLAWB_NODE:-https://node.gitlawb.com}"
MAINSTREET_URL="${MAINSTREET_URL:-https://avisradar-production.up.railway.app}"
MEMORY_ROOTS="${MEMORY_ROOTS:-}"

: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY in the environment (never commit it)}"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1 — install it first (need: git, node>=18, python3.11)"; exit 1; }; }

say "prereqs"
need git; need node; need python3

say "clone deps into $WORK"
mkdir -p "$WORK"
[ -d "$WORK/biii/.git" ]   || git clone --depth 1 "$BIII_REPO"   "$WORK/biii"
[ -d "$WORK/lawbor/.git" ] || git clone --depth 1 "$LAWBOR_REPO" "$WORK/lawbor"
BIII_DIR="$WORK/biii"; LAWBOR_DIR="$WORK/lawbor"

say "install node deps (biii-mcp + lawbor-mcp)"
( cd "$BIII_DIR"   && npm ci --omit=dev 2>/dev/null || npm install --omit=dev )
( cd "$LAWBOR_DIR" && { npm ci --omit=dev 2>/dev/null || npm install --omit=dev; } ) || echo "  (lawbor has no deps or install skipped — ok)"

say "install Hermes (git) into a venv"
if [ ! -x "$HOME/.hermes-venv/bin/hermes" ]; then
  [ -d "$WORK/hermes-src/.git" ] || git clone --depth 1 "$HERMES_REPO" "$WORK/hermes-src"
  python3 -m venv "$HOME/.hermes-venv"
  "$HOME/.hermes-venv/bin/pip" install -q --upgrade pip
  "$HOME/.hermes-venv/bin/pip" install -q -e "$WORK/hermes-src[cli,mcp]"
fi
HERMES_BIN="$HOME/.hermes-venv/bin/hermes"

say "locate gl (gitlawb CLI)"
GL_BIN="${GL_BIN:-$(command -v gl || true)}"
if [ -z "$GL_BIN" ]; then
  echo "  gl not found on PATH. Install the gitlawb CLI, then re-run (or export GL_BIN=/path/to/gl)."
  echo "  The gitlawb toolset will be disabled until gl is present."
  GL_BIN="/usr/local/bin/gl"   # templated in; the toolset simply fails closed if absent
fi

say "render config into $HERMES_NODE_HOME"
mkdir -p "$HERMES_NODE_HOME"
export BIII_DIR LAWBOR_DIR GL_BIN GITLAWB_NODE MAINSTREET_URL HERMES_MODEL
envsubst < "$BIII_DIR/hermes/node/config.template.yaml" > "$HERMES_NODE_HOME/config.yaml"
# recall: append ONLY if MEMORY_ROOTS is set (host-specific, privacy-sensitive)
if [ -n "$MEMORY_ROOTS" ]; then
  cat >> "$HERMES_NODE_HOME/config.yaml" <<EOF
  recall:
    command: node
    args:
      - $BIII_DIR/hermes/memory-mcp.js
    enabled: true
    env:
      MEMORY_ROOTS: "$MEMORY_ROOTS"
EOF
  echo "  recall wired (MEMORY_ROOTS set)"
else
  echo "  recall SKIPPED (no MEMORY_ROOTS — remote node runs without our private brain)"
fi

say "persona + secret"
cp -f "$BIII_DIR/hermes/agents/biii-monitor/SOUL.md" "$HERMES_NODE_HOME/SOUL.md"
umask 077; printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" > "$HERMES_NODE_HOME/.env"

say "verify toolsets handshake"
HERMES_HOME="$HERMES_NODE_HOME" "$HERMES_BIN" mcp test biii 2>&1 | grep -iE "Connected|Tools" | head -2 || true

cat <<EOF

✅ Node ready at $HERMES_NODE_HOME  (READ-ONLY monitor; guard baked in).
   Run it:   HERMES_HOME=$HERMES_NODE_HOME bash $BIII_DIR/hermes/node/run.sh
   Ask it:   HERMES_HOME=$HERMES_NODE_HOME $HERMES_BIN -z "..." -t biii,gitlawb,lawbor

   Next (your gesture): register this node's identity on gitlawb so the fleet can
   coordinate it —  GL_BIN=$GL_BIN; \$GL_BIN register   (creates/uses the node DID).
   Layer 2 (always-on) = keep this on a host that isn't a laptop. Layer 3 = run it on
   ≥2 hosts + lawbor leader-election so killing one never stops the swarm.
EOF
