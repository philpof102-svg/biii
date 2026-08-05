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

. /root/.hermes-biii/scripts/verify-payload.sh
# Le journal vit dans le depot (lisible depuis Windows); le CODE vient de /root, hors de portee de /mnt/d.
NOTE_REFUSAL_LOG=/mnt/d/Users/VolKov/veilleIA/biii/data/fleet-refusals.log
. /root/.hermes-biii/scripts/note-refusal.sh
verify_payload "/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/token-radar.js" || { note_refusal "token-radar" "payload non epingle"; exit 1; }
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
# COMMIT ONLY. `--push` is deliberately absent, and that is a measurement rather than a preference.
#
# This cron runs under WSL. Windows git authenticates through the Windows Credential Manager, which WSL cannot
# see, and WSL git here has no credential helper at all (`git config --get credential.helper` is empty). A push
# from this side does not fail — it HANGS, waiting for a username on a terminal that does not exist, until
# something kills it. Measured: `git push -v` printed "Pushing to …" and then nothing for 90 seconds. That is
# worse than an error, because an hourly job would burn the wait every time and still never publish.
#
# So the data is recorded locally, where it cannot be lost, and reaching the remote stays a deliberate step.
# The script refuses on its own if anything outside the data paths changed, if something is already staged, or
# on a detached head — an unattended run cannot sweep code along with the numbers.
node scripts/commit-radar-data.js --commit
commit_status=$?
if [ "$commit_status" -eq 0 ]; then
  unpushed=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
  if [ "${unpushed:-0}" -gt 0 ]; then
    echo "   ↑ $unpushed commit(s) waiting to be pushed. The hosted node and the npm package only see PUSHED"
    echo "     data, so freshness stops here until someone runs \`git push\` from Windows (WSL has no"
    echo "     credential helper). One-time fix: give WSL git a credential store with a GitHub PAT."
  fi
elif [ "$commit_status" -ne 0 ]; then
  echo "   (data left uncommitted, reason above — the radar itself ran fine)"
fi

# The brief's exit code tracks the RADAR, not the bookkeeping: a failed push is not a failed observation, and
# making it one would teach whoever reads these briefs to ignore a red line that usually means nothing.
exit 0
