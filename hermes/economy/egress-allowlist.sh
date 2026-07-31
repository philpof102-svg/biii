#!/usr/bin/env bash
# egress-allowlist.sh — the unattended jobs may reach seven hosts, and nothing else.
# =================================================================================
# WHY. Three no_agent jobs (meme-scan, wallet-watch, agent-watch) execute JS from /mnt/d, a path
# Windows can write, on a machine with four documented implants between 2026-05-29 and 2026-07-25.
# verify-payload.sh now refuses code that changed without being pinned — that answers "is this the code
# we intended". This answers the other half: "if it were not, where could it send what it read".
#
# WHY IT IS CHEAP HERE. Measured: those three payloads read only configuration env vars
# (WALLET_WATCH, MEME_CHAINS, AGENT_WATCH_N…), none of their wrappers sources the secret .env, and they
# write one state file. They need no credentials at all, so dropping them to an unprivileged user costs
# them nothing they use. Least privilege is usually a trade; here it is free.
#
# SCOPE, AND WHY IT IS SAFE TO APPLY. Every rule is matched on `-m owner --uid-owner $JOB_UID`, a user
# that runs nothing else on this box. Root, Hermes, the agent jobs and this shell are untouched by
# construction — the blast radius of a mistake in this file is one dedicated account.
#
# WHY IPs ARE RESOLVED AT EACH RUN. dexscreener, binance and openrouter sit behind CDNs whose addresses
# rotate; a hand-written IP allowlist would be wrong within days and would then be deleted rather than
# fixed. Resolving immediately before a short job keeps the list correct without a proxy. The residual
# gap is honest and named: an address that rotates DURING a run is refused, and a run that outlives its
# resolution fails closed rather than opening up.
#
#   usage: egress-allowlist.sh apply     # (re)build the chain from the allowlist
#          egress-allowlist.sh status
#          egress-allowlist.sh clear     # remove everything this script installed

set -u

JOB_USER="${HERMES_JOB_USER:-hermesjob}"
CHAIN="HERMES_JOB_EGRESS"

# The seven hosts, taken from the scripts and payloads themselves rather than from memory.
ALLOWED_HOSTS="${HERMES_JOB_ALLOWED_HOSTS:-api.dexscreener.com openrouter.ai mainnet.base.org base.blockscout.com api.geckoterminal.com api.binance.com registry.modelcontextprotocol.io}"

uid_of() { id -u "$JOB_USER" 2>/dev/null; }

cmd_clear() {
  iptables -D OUTPUT -m owner --uid-owner "$1" -j "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
}

cmd_apply() {
  local uid; uid=$(uid_of)
  if [ -z "$uid" ]; then
    echo "[egress] REFUS: l'utilisateur '$JOB_USER' n'existe pas. Sans UID dedie, une regle viserait root — donc Hermes lui-meme." >&2
    return 1
  fi

  cmd_clear "$uid"
  iptables -N "$CHAIN" 2>/dev/null || true

  # Loopback and DNS first: without name resolution the job cannot reach even an allowed host.
  iptables -A "$CHAIN" -o lo -j ACCEPT
  iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
  iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT

  local resolved=0 host ip
  for host in $ALLOWED_HOSTS; do
    # getent walks the same resolver the job will use, so what we allow is what it will contact.
    for ip in $(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
      iptables -A "$CHAIN" -d "$ip" -p tcp --dport 443 -j ACCEPT
      iptables -A "$CHAIN" -d "$ip" -p tcp --dport 80 -j ACCEPT
      resolved=$((resolved + 1))
    done
  done

  if [ "$resolved" -eq 0 ]; then
    # Nothing resolved: almost certainly DNS is broken, not "no hosts are allowed". Installing a
    # deny-all chain here would look like a security decision and would actually be an outage.
    echo "[egress] REFUS: aucun hote n'a pu etre resolu — DNS probablement casse. On n'installe PAS une chaine tout-refus sur cette base." >&2
    cmd_clear "$uid"
    return 1
  fi

  # Everything else from this UID is refused, with a reject rather than a silent drop so a blocked job
  # fails fast and says so instead of hanging until a timeout nobody reads.
  iptables -A "$CHAIN" -j REJECT --reject-with icmp-admin-prohibited
  iptables -A OUTPUT -m owner --uid-owner "$uid" -j "$CHAIN"
  echo "[egress] applique: $resolved adresses autorisees pour uid=$uid ($JOB_USER), tout le reste refuse."
}

cmd_status() {
  local uid; uid=$(uid_of)
  echo "[egress] user=$JOB_USER uid=${uid:-ABSENT}"
  iptables -L "$CHAIN" -n 2>/dev/null | head -30 || echo "[egress] chaine absente"
}

case "${1:-}" in
  apply)  cmd_apply ;;
  clear)  cmd_clear "$(uid_of)"; echo "[egress] retire." ;;
  status) cmd_status ;;
  *) echo "usage: $0 {apply|status|clear}" >&2; exit 2 ;;
esac
