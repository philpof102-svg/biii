#!/usr/bin/env bash
# agent-watch.sh — watch the PUBLIC agent surface change: a rotating slice of the MCP registry per run,
# reporting only what changed. Introspection only, no tool ever called. $0, no LLM, read-only.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
. /root/.hermes-biii/scripts/verify-payload.sh
verify_payload "/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agent-watch.js" || exit 1
exec setpriv --reuid=hermesprobe --regid=hermesprobe --clear-groups node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agent-watch.js
