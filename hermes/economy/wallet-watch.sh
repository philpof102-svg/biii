#!/usr/bin/env bash
# wallet-watch.sh — the continuous wallet guard: diff each watched address, report only what changed.
# $0, no LLM, read-only. Set WALLET_WATCH="0x..,0x.." to change the list.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/wallet-watch.js
