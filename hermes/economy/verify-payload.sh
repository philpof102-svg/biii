#!/usr/bin/env bash
# verify-payload.sh — refuse to execute code that changed without us pinning it.
# ==============================================================================
# THE PROBLEM THIS ANSWERS. Six of the eight scheduled jobs are `no_agent: true`: plain shell scripts
# that never reach a `pre_tool_call` hook, so the read-only guard does not cover them at all. Three of
# those six — meme-scan, wallet-watch, agent-watch — `exec node` against a path under /mnt/d, the
# Windows filesystem. Whatever can write D: therefore chooses what the fleet executes, unattended,
# every couple of hours. That is not hypothetical on this machine: four implants are documented between
# 2026-05-29 and 2026-07-25, a window during which these jobs were already running.
#
# WHY A HASH PIN IS THE RIGHT SHAPE HERE, AND NOT ELSEWHERE. The wrappers live in
# /root/.hermes-biii/scripts/ — inside WSL's ext4 root, under a drwx------ /root that Windows cannot
# write. The payloads live on /mnt/d, which it can. Verifier above, verified below: the check is out of
# reach of the thing it checks. Had both sat on D:, an attacker would edit both and this file would be
# theatre.
#
# WHY A PIN IS AFFORDABLE. Measured churn on the three payloads: 5, 3 and 5 commits over 60 days — one
# legitimate change every two to three weeks. A control that breaks weekly gets switched off; at this
# rate a re-pin is rare, and the refusal message carries the exact command to do it.
#
# FAILS CLOSED, deliberately: unknown file, missing manifest, unreadable file and hash mismatch all
# refuse. For an integrity check there is no useful "observe mode" — logging that the code changed and
# running it anyway is precisely the outcome the check exists to prevent.
#
#   usage:  . /root/.hermes-biii/scripts/verify-payload.sh && verify_payload /path/to/file.js
#   re-pin: /root/.hermes-biii/scripts/verify-payload.sh --pin /path/to/file.js

MANIFEST="${PAYLOAD_MANIFEST:-/root/.hermes-biii/scripts/payload-hashes.txt}"

verify_payload() {
  local target="$1"
  if [ -z "$target" ]; then
    echo "[verify-payload] REFUS: aucun fichier fourni." >&2
    return 1
  fi
  if [ ! -r "$target" ]; then
    echo "[verify-payload] REFUS: '$target' illisible ou absent. Un payload qu'on ne peut pas lire ne peut pas etre execute." >&2
    return 1
  fi
  if [ ! -r "$MANIFEST" ]; then
    echo "[verify-payload] REFUS: manifeste '$MANIFEST' absent. Sans reference, aucune verification n'est possible — on ne devine pas." >&2
    return 1
  fi
  local expected actual
  expected=$(awk -v p="$target" '$2 == p { print $1; exit }' "$MANIFEST")
  if [ -z "$expected" ]; then
    echo "[verify-payload] REFUS: '$target' absent du manifeste. Fail-closed: un fichier non epingle n'est pas un fichier de confiance." >&2
    echo "[verify-payload] Si ce changement est voulu: /root/.hermes-biii/scripts/verify-payload.sh --pin '$target'" >&2
    return 1
  fi
  actual=$(sha256sum "$target" 2>/dev/null | awk '{print $1}')
  if [ -z "$actual" ]; then
    echo "[verify-payload] REFUS: impossible de hacher '$target'." >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "[verify-payload] REFUS: '$target' a CHANGE depuis son epinglage." >&2
    echo "[verify-payload]   attendu: $expected" >&2
    echo "[verify-payload]   obtenu : $actual" >&2
    echo "[verify-payload] Ce fichier vit sur /mnt/d, que Windows peut ecrire. Verifiez le diff AVANT de re-epingler." >&2
    echo "[verify-payload] Si le changement est voulu: /root/.hermes-biii/scripts/verify-payload.sh --pin '$target'" >&2
    return 1
  fi
  return 0
}

# `--pin` re-epingle un fichier. Deliberement une action explicite et separee: si le wrapper pouvait
# re-epingler tout seul en cas d'ecart, le controle ne controlerait plus rien.
if [ "$1" = "--pin" ]; then
  f="$2"
  [ -r "$f" ] || { echo "[verify-payload] --pin: '$f' illisible." >&2; exit 1; }
  h=$(sha256sum "$f" | awk '{print $1}')
  touch "$MANIFEST"
  grep -v -F " $f" "$MANIFEST" > "$MANIFEST.tmp" 2>/dev/null || true
  echo "$h $f" >> "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
  echo "[verify-payload] epingle: $h $f"
  exit 0
fi
