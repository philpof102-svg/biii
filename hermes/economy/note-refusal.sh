#!/usr/bin/env bash
# note-refusal.sh — laisser une trace LISIBLE quand un job de la flotte refuse de tourner.
# ==============================================================================================
# LE PROBLEME, mesure le 2026-08-05 et paye 4 heures. Les quatre wrappers de la flotte commencent par
# `verify_payload … || exit 1`, et deux d'entre eux ajoutent `egress-allowlist … || exit 1`. Six
# chemins de refus, et AUCUN n'ecrit quoi que ce soit dans le depot. Les messages partent sur stdout,
# donc dans le log du cron Hermes — a l'interieur de WSL, hors d'atteinte de la machine Windows d'ou
# le diagnostic se fait.
#
# Consequence: « a refuse » et « n'a jamais tourne » sont IDENTIQUES vus d'ici. Le radar a ete
# diagnostique comme une panne pendant quatre heures alors qu'un garde d'integrite faisait son travail.
# Et si on a pu s'en apercevoir, c'est seulement parce que token-radar est le seul des quatre dont le
# SUCCES laisse une trace (il commite sa base). Les trois autres n'ecrivent jamais rien, dans aucun
# etat — pour eux, « tout va bien » est indistinguable de « rien ne tourne depuis trois semaines ».
#
# CE QUE CE SCRIPT NE FAIT PAS, et c'est deliberé: il ne juge pas, ne relance rien, ne re-epingle rien.
# Il ecrit une ligne datee. Un refus reste un refus; ce qui change est qu'il devienne VISIBLE.
#
# Usage (dans un wrapper, apres le refus et AVANT le `exit`):
#   note_refusal "token-radar" "payload non epingle"
#
# ⚠️ IL NE DOIT JAMAIS FAIRE ECHOUER SON APPELANT. Un journal qui casse le job qu'il observe serait
# pire que pas de journal du tout: toutes les ecritures sont tolerantes a l'echec et la fonction rend
# toujours 0. C'est le seul endroit de ce depot ou avaler une erreur est correct — parce que la valeur
# de retour ne sera lue par personne comme une affirmation sur le monde.
set -u

# La racine du depot, deduite de l'emplacement de ce fichier — pas d'un cwd qui depend de l'appelant.
_NR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
NOTE_REFUSAL_LOG="${NOTE_REFUSAL_LOG:-$_NR_ROOT/data/fleet-refusals.log}"
NOTE_REFUSAL_MAX="${NOTE_REFUSAL_MAX:-500}"   # borne: un journal non borne finit par remplir le volume

note_refusal() {
  local job="${1:-inconnu}"
  local raison="${2:-aucune raison fournie}"
  local quand
  quand="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 'date-illisible')"

  mkdir -p "$(dirname "$NOTE_REFUSAL_LOG")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\n' "$quand" "$job" "$raison" >> "$NOTE_REFUSAL_LOG" 2>/dev/null || return 0

  # Rotation par troncature: on garde les N dernieres lignes. Un incident de 2026-06-07 a corrompu la
  # base SQLite parce qu'un volume s'est rempli — un journal de diagnostic ne doit pas rejouer ca.
  local n
  n="$(wc -l < "$NOTE_REFUSAL_LOG" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -gt "$NOTE_REFUSAL_MAX" ]; then
    tail -n "$NOTE_REFUSAL_MAX" "$NOTE_REFUSAL_LOG" > "$NOTE_REFUSAL_LOG.tmp" 2>/dev/null \
      && mv "$NOTE_REFUSAL_LOG.tmp" "$NOTE_REFUSAL_LOG" 2>/dev/null
  fi
  return 0
}

# Appelable aussi en direct: `note-refusal.sh <job> <raison>`
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  note_refusal "${1:-}" "${2:-}"
fi
