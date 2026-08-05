#!/usr/bin/env bash
# agent-watch.sh — watch the PUBLIC agent surface change: a rotating slice of the MCP registry per run,
# reporting only what changed. Introspection only, no tool ever called. $0, no LLM, read-only.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
. /root/.hermes-biii/scripts/verify-payload.sh
# Le journal vit dans le depot (lisible depuis Windows); le CODE vient de /root, hors de portee de /mnt/d.
NOTE_REFUSAL_LOG=/mnt/d/Users/VolKov/veilleIA/biii/data/fleet-refusals.log
. /root/.hermes-biii/scripts/note-refusal.sh
verify_payload "/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agent-watch.js" || { note_refusal "agent-watch" "payload non epingle"; exit 1; }
exec setpriv --reuid=hermesprobe --regid=hermesprobe --clear-groups node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agent-watch.js
