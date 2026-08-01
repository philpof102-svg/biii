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

# Both sides spell the same interval differently — agents.json says "every 1h", the scheduler prints
# "every 60m". Comparing the raw strings would have reported five divergences where only three exist,
# and a checker that cries wolf gets ignored, which is how the real three survived. Everything is
# reduced to minutes; anything unrecognised is returned unchanged so it can only compare equal to an
# identical string, never silently to something else.
# 2026-08-01, proven in an isolated HERMES_HOME rig: `hermes cron create "4h"` creates a job that
# fires ONCE and deletes itself ("once in 4h", repeat {times: 1}); `hermes cron create "every 4h"`
# creates an interval that repeats for ever. The word `every` is load-bearing, and omitting it is
# silent — the job appears in `cron list`, runs once, and is simply gone the next time you look.
# That is what happened to market-watch and memory-keeper: both declared a bare schedule, both fired
# on 30 July, both vanished, and nothing reported it. biii-watch — the SENTINEL — also declared a bare
# "30m" and survives only because it was registered by hand as an interval; re-registering it from the
# file would have quietly turned the sentinel into a one-shot.
# Every agent here is a repeating agent, so a bare schedule is always a mistake. It is corrected and
# announced, never corrected quietly.
ensure_interval() {
  case "$1" in
    every\ *|*\ *\ *) printf '%s' "$1" ;;          # already 'every X', or a cron expression
    [0-9]*[mhd]) printf 'every %s' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

norm_sched() {
  printf '%s' "$1" | tr -d ' ' | tr 'A-Z' 'a-z' | sed 's/^every//' | awk '
    /^[0-9]+m$/ { sub(/m/,""); print $0 "m"; next }
    /^[0-9]+h$/ { sub(/h/,""); print $0 * 60 "m"; next }
    /^[0-9]+d$/ { sub(/d/,""); print $0 * 1440 "m"; next }
    { print }'
}

existing=$("$H" cron list 2>/dev/null)
n=$(jq '.agents | length' "$CFG")
reg=0; skip=0; off=0; div=0; failed=0
echo "== registering the economy fleet from agents.json ($n declared) =="

for i in $(seq 0 $((n - 1))); do
  name=$(jq -r ".agents[$i].name" "$CFG")
  enabled=$(jq -r ".agents[$i].enabled" "$CFG")
  kind=$(jq -r ".agents[$i].kind" "$CFG")
  sched=$(jq -r ".agents[$i].schedule" "$CFG")
  cost=$(jq -r ".agents[$i].cost" "$CFG")

  fixed=$(ensure_interval "$sched")
  if [ "$fixed" != "$sched" ]; then
    echo "  ~ $name : schedule '$sched' has no 'every' — that creates a ONE-SHOT that fires once and"
    echo "      deletes itself. Using '$fixed'. Fix agents.json so the file says what it means."
    sched="$fixed"
  fi

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

  # 2026-08-01: "already scheduled" was being read as "scheduled AS DECLARED". This check matched on
  # the NAME alone, so once an agent was registered, editing its schedule in agents.json changed
  # nothing — for ever. Measured live the day this was written: biii-watch declares 30m and runs every
  # 90m (the SENTINEL, at a third of its intended rate), strategist declares 12h and runs every 120m,
  # meme-watch declares 6h and runs every 30m — twelve times what the file says. agents.json had
  # quietly stopped being the truth about what this machine does, and nothing anywhere said so.
  #
  # Re-registering automatically would be worse: it would silently change a live schedule, and cost is
  # the number of scheduled passes. So the divergence is REPORTED and the operator decides.
  if printf '%s' "$existing" | grep -qiF "$name"; then
    livesched=$(printf '%s' "$existing" | awk -v n="$name" '
      $1=="Name:" { cur=($2==n) }
      cur && $1=="Schedule:" { $1=""; sub(/^ +/,""); print; exit }')
    if [ -n "$livesched" ] && [ "$(norm_sched "$sched")" != "$(norm_sched "$livesched")" ]; then
      echo "  ~ $name : SCHEDULE DIVERGED — agents.json says '$sched', the scheduler runs '$livesched'."
      echo "      agents.json is NOT the truth for this agent. To adopt the declared value:"
      echo "      hermes cron delete $name && re-run this script. Cost is the number of passes — check before you do."
      div=$((div+1))
    else
      echo "  = $name : already scheduled $livesched ($cost)"
    fi
    skip=$((skip+1)); continue
  fi

  # The reason a registration failed used to go to /dev/null, so "FAILED to schedule (agent)" was the
  # whole report — a failure with its cause deleted. Captured and printed now.
  #
  # (Correction to an earlier version of this comment: it blamed a missing OPENROUTER_API_KEY for
  # market-watch and memory-keeper being absent. That was wrong. The key IS configured — 73 chars in
  # $HERMES_HOME/.env, mode 600 — and I had checked the gateway's process environ, which is a proxy,
  # not the source hermes reads. The real cause is the bare-schedule one-shot documented above.)
  err=$(mktemp)
  if [ "$kind" = "script" ]; then
    script=$(jq -r ".agents[$i].script" "$CFG")
    "$H" cron create "$sched" --name "$name" --script "$script" --no-agent >"$err" 2>&1 \
      && { echo "  + $name : scheduled $sched ($cost)"; reg=$((reg+1)); } \
      || { echo "  ! $name : FAILED to schedule (script) — $(tr '\n' ' ' <"$err" | cut -c1-200)"; failed=$((failed+1)); }
  else
    prompt=$(jq -r ".agents[$i].prompt" "$CFG")
    dscript=$(jq -r ".agents[$i].dataScript // empty" "$CFG")
    if [ -n "$dscript" ]; then
      # agent + a data script: the script's stdout (live data) is injected into the prompt each run.
      "$H" cron create "$sched" "$prompt" --name "$name" --script "$dscript" >"$err" 2>&1 \
        && { echo "  + $name : scheduled $sched ($cost) — LLM + live data ($dscript)"; reg=$((reg+1)); } \
        || { echo "  ! $name : FAILED to schedule (agent+data) — $(tr '\n' ' ' <"$err" | cut -c1-200)"; failed=$((failed+1)); }
    else
      "$H" cron create "$sched" "$prompt" --name "$name" >"$err" 2>&1 \
        && { echo "  + $name : scheduled $sched ($cost) — LLM"; reg=$((reg+1)); } \
        || { echo "  ! $name : FAILED to schedule (agent) — $(tr '\n' ' ' <"$err" | cut -c1-200)"; failed=$((failed+1)); }
    fi
  fi
  rm -f "$err"
done

# A summary that only counts successes is how two missing agents went unnoticed. Every enabled agent
# ends in exactly one bucket, and the buckets are printed even when they are zero.
echo "== fleet: $reg newly scheduled, $skip already up, $div DIVERGED from agents.json, $failed FAILED, $off off (declared but not enabled) =="
if [ "$failed" -gt 0 ]; then
  echo "== $failed enabled agent(s) are declared but NOT running. The reason is printed above, on the ! line. =="
fi
if [ "$div" -gt 0 ]; then
  echo "== $div agent(s) run on a schedule agents.json does not describe. Reading that file will mislead you until this is resolved. =="
fi
[ "$failed" -gt 0 ] && exit 1
exit 0
