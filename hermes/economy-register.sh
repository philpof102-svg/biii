#!/usr/bin/env bash
# economy-register.sh — register every ENABLED agent from economy/agents.json as a Hermes cron job.
# Idempotent: an agent already in `cron list` (by name) is skipped, so re-running is safe.
# Called by economy-up (the one-command launcher). Needs jq + the Hermes CLI.
set -uo pipefail
export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}
export HERMES_HOME=/root/.hermes-biii
H=/root/.hermes-venv/bin/hermes
CFG=/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agents.json

[ -f "$CFG" ] || { echo "no agents.json at $CFG"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }

existing=$("$H" cron list 2>/dev/null)
n=$(jq '.agents | length' "$CFG")
reg=0; skip=0; off=0
echo "== registering the economy fleet from agents.json ($n declared) =="

for i in $(seq 0 $((n - 1))); do
  name=$(jq -r ".agents[$i].name" "$CFG")
  enabled=$(jq -r ".agents[$i].enabled" "$CFG")
  kind=$(jq -r ".agents[$i].kind" "$CFG")
  sched=$(jq -r ".agents[$i].schedule" "$CFG")
  cost=$(jq -r ".agents[$i].cost" "$CFG")

  if [ "$enabled" != "true" ]; then echo "  - $name : OFF ($cost) — enable in agents.json to schedule"; off=$((off+1)); continue; fi

  # Install the runner into Hermes' own scripts directory BEFORE the already-scheduled check. Skipping this
  # for an existing job is how token-radar failed silently every hour for a whole evening: the job was
  # registered, `cron list` showed it, and each run died with "Script not found" because the file had never
  # been copied. A job that exists is not the same as a job that can run, and only the second one matters.
  for key in script dataScript; do
    f=$(jq -r ".agents[$i].$key // empty" "$CFG")
    [ -n "$f" ] || continue
    # Runners do not all live in economy/ — the sentinel's sits under agents/biii-monitor/. Searching the
    # hermes tree instead of assuming one directory keeps this from inventing a missing-file warning for a
    # script that is present, which is its own kind of noise.
    src=$(find /mnt/d/Users/VolKov/veilleIA/biii/hermes -maxdepth 3 -name "$f" -type f 2>/dev/null | head -1)
    dst="$HERMES_HOME/scripts/$f"
    if [ -n "$src" ] && [ -f "$src" ]; then
      if ! cmp -s "$src" "$dst" 2>/dev/null; then
        mkdir -p "$HERMES_HOME/scripts" && cp "$src" "$dst" && chmod +x "$dst" && echo "    ↻ $name : installed runner $f"
      fi
    else
      echo "  ! $name : runner $f NOT FOUND anywhere under hermes/ — this agent cannot run"
    fi
  done

  if printf '%s' "$existing" | grep -qiF "$name"; then echo "  = $name : already scheduled ($cost)"; skip=$((skip+1)); continue; fi

  if [ "$kind" = "script" ]; then
    script=$(jq -r ".agents[$i].script" "$CFG")
    "$H" cron create "$sched" --name "$name" --script "$script" --no-agent >/dev/null 2>&1 \
      && { echo "  + $name : scheduled every $sched ($cost)"; reg=$((reg+1)); } \
      || echo "  ! $name : FAILED to schedule (script)"
  else
    prompt=$(jq -r ".agents[$i].prompt" "$CFG")
    dscript=$(jq -r ".agents[$i].dataScript // empty" "$CFG")
    if [ -n "$dscript" ]; then
      # agent + a data script: the script's stdout (live data) is injected into the prompt each run.
      "$H" cron create "$sched" "$prompt" --name "$name" --script "$dscript" >/dev/null 2>&1 \
        && { echo "  + $name : scheduled every $sched ($cost) — LLM + live data ($dscript)"; reg=$((reg+1)); } \
        || echo "  ! $name : FAILED to schedule (agent+data)"
    else
      "$H" cron create "$sched" "$prompt" --name "$name" >/dev/null 2>&1 \
        && { echo "  + $name : scheduled every $sched ($cost) — LLM"; reg=$((reg+1)); } \
        || echo "  ! $name : FAILED to schedule (agent)"
    fi
  fi
done

echo "== fleet: $reg newly scheduled, $skip already up, $off off (declared but not enabled) =="
