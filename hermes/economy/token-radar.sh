#!/usr/bin/env bash
# token-radar.sh — the market-watch daemon: harvest fresh launches, judge who can still rug them, and grade
# our own past calls against what actually happened. $0, no LLM. Set RADAR_CHAIN to watch another chain.
# no_agent Hermes cron: stdout is delivered as the brief.
#
# THE SECOND STEP EXISTS BECAUSE FRESHNESS WAS ACCIDENTAL.
# The radar wrote its database every hour and committed nothing, so the hosted node and the npm package both
# served whatever snapshot happened to be committed alongside some unrelated code change. Measured on this
# database: a registry frozen 6h ago misses 20% of the rugs it could have named, 38% at 12h, 41% at 24h.
#
# `exec` used to be on the node line, which replaces this shell entirely — nothing could ever run after it.
# That is why there was no second step rather than a broken one.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
cd /mnt/d/Users/VolKov/veilleIA/biii || { echo "token-radar: cannot reach the repo — nothing ran."; exit 1; }

node hermes/economy/token-radar.js
radar_status=$?

# Only record a run that finished. A crashed harvest can leave the database half-written, and committing that
# would publish a snapshot nobody chose — worse than an hour of staleness.
if [ "$radar_status" -ne 0 ]; then
  echo ""
  echo "⏸ data NOT committed: the radar exited $radar_status, so this database may be half-written."
  exit "$radar_status"
fi

echo ""
# The script refuses on its own if anything outside the data paths changed, if something is already staged, or
# on a detached head — so an unattended run cannot sweep code along with the numbers. A push failure means the
# remote moved; the commit is still safe locally and a human rebases. Reported, never retried in a loop.
node scripts/commit-radar-data.js --commit --push
commit_status=$?
if [ "$commit_status" -eq 2 ]; then
  echo "   (the commit is recorded locally; only the push failed — rebase and push by hand)"
elif [ "$commit_status" -ne 0 ]; then
  echo "   (data left uncommitted, reason above — the radar itself ran fine)"
fi

# The brief's exit code tracks the RADAR, not the bookkeeping: a failed push is not a failed observation, and
# making it one would teach whoever reads these briefs to ignore a red line that usually means nothing.
exit 0
