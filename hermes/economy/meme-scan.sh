#!/usr/bin/env bash
# meme-scan.sh — the meme-watch agent: grind meme-genuineness (which contract is real / trap). $0, no LLM.
# no_agent Hermes cron: stdout is delivered as the brief. Set MEME_WATCH="SYM,SYM,.." to change the list.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
. /root/.hermes-biii/scripts/verify-payload.sh
verify_payload "/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/meme-scan.js" || exit 1
exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/meme-scan.js
