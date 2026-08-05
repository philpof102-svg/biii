#!/usr/bin/env bash
# wallet-watch.sh — the continuous wallet guard: diff each watched address, report only what changed.
# $0, no LLM, read-only. Set WALLET_WATCH="0x..,0x.." to change the list.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
. /root/.hermes-biii/scripts/verify-payload.sh
# Le journal vit dans le depot (lisible depuis Windows); le CODE vient de /root, hors de portee de /mnt/d.
NOTE_REFUSAL_LOG=/mnt/d/Users/VolKov/veilleIA/biii/data/fleet-refusals.log
. /root/.hermes-biii/scripts/note-refusal.sh
verify_payload "/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/wallet-watch.js" || { note_refusal "wallet-watch" "payload non epingle"; exit 1; }
/root/.hermes-biii/scripts/egress-allowlist.sh apply >/dev/null || { echo "[egress] allowlist non appliquee — refus de lancer sans confinement reseau" >&2; note_refusal "wallet-watch" "egress allowlist non appliquee"; exit 1; }
exec setpriv --reuid=hermesjob --regid=hermesjob --clear-groups node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/wallet-watch.js
