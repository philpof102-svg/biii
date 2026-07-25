#!/usr/bin/env bash
# token-radar.sh — the market-watch daemon: harvest fresh launches, judge who can still rug them, and grade
# our own past calls against what actually happened. $0, no LLM. Set RADAR_CHAIN to watch another chain.
# no_agent Hermes cron: stdout is delivered as the brief.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/token-radar.js
