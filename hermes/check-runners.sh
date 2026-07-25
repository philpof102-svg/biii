#!/usr/bin/env bash
# check-runners.sh — does every ENABLED agent in agents.json actually have its runner installed where Hermes
# looks for it? Answers the question the cron list cannot: a job can be scheduled, visible, and dead.
# That exact state went unnoticed for an evening — "Script not found" once an hour, with the job showing green.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
export HERMES_HOME=${HERMES_HOME:-/root/.hermes-biii}
CFG=/mnt/d/Users/VolKov/veilleIA/biii/hermes/economy/agents.json
bad=0
echo "== runner check (${HERMES_HOME}/scripts) =="
n=$(jq '.agents | length' "$CFG")
for i in $(seq 0 $((n - 1))); do
  enabled=$(jq -r ".agents[$i].enabled" "$CFG")
  [ "$enabled" = "true" ] || continue
  name=$(jq -r ".agents[$i].name" "$CFG")
  for key in script dataScript; do
    f=$(jq -r ".agents[$i].$key // empty" "$CFG")
    [ -n "$f" ] || continue
    if [ -f "$HERMES_HOME/scripts/$f" ]; then
      echo "  ok   $name -> $f"
    else
      echo "  DEAD $name -> $f is NOT installed; this job fires and fails every run"
      bad=$((bad + 1))
    fi
  done
done
[ "$bad" -eq 0 ] && echo "== every enabled agent can actually run ==" || echo "== $bad agent(s) scheduled but unable to run =="
exit 0
