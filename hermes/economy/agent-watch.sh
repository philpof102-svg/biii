#!/usr/bin/env bash
# agent-watch.sh — watch the PUBLIC agent surface change: a rotating slice of the MCP registry per run,
# reporting only what changed. Introspection only, no tool ever called. $0, no LLM, read-only.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
exec node /mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agent-watch.js
