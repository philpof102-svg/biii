#!/bin/bash
# cron BIII Monitor — deep scan, appele par Hermes toutes les 30 minutes.
#
# ⚠️ REECRIT LE 2026-07-27. La version precedente vivait dans hermes/agents/bii-monitor/ — un dossier
# avec DEUX i au lieu de trois, contenant ce seul fichier — et elle ne pouvait pas demarrer. Trois
# cassures independantes, chacune suffisante:
#
#   1. `node hermes/agents/bii-monitor/deep-scan.js` : ce chemin n'existe pas. Le script est dans
#      biii-monitor/. Meme chose pour la watchlist. -> « Cannot find module ».
#   2. `cd "$(dirname "$0")/../.."` depuis hermes/agents/X/ atterrit dans hermes/, pas a la racine du
#      depot. Les chemins relatifs qui suivent partaient donc du mauvais endroit de toute facon.
#   3. `set -e` en tete rend le `if [ $? -eq 0 ]` plus bas INATTEIGNABLE en cas d'echec: le shell sort
#      avant. La branche « erreur » ne pouvait jamais s'executer — le meme motif que le code mort
#      derriere un `process.exit` place trop haut, deja documente dans test/agent-vet-gate.js.

set -euo pipefail

# Racine du depot: le script est a hermes/agents/biii-monitor/, donc trois niveaux au-dessus.
ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(cd "$ICI/../../.." && pwd)"
cd "$RACINE"

# `export $(cat .env | xargs)` cassait sur toute valeur contenant une espace et developpait les jokers.
# `set -a` laisse le shell parser le fichier lui-meme.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "🚀 BIII Monitor deep scan — $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# On desarme `-e` autour de l'appel pour pouvoir LIRE le code de sortie au lieu de mourir dessus.
set +e
node hermes/agents/biii-monitor/deep-scan.js hermes/agents/biii-monitor/watchlist.json
CODE=$?
set -e

if [ "$CODE" -eq 0 ]; then
  echo "✅ deep scan termine"
  echo "📊 resume: hermes/agents/biii-monitor/cache/deep-scan-notes.md"
else
  echo "❌ deep scan en echec (code $CODE)" >&2
fi

# Le code du scan est propage: un cron qui rend toujours 0 ne peut pas alerter.
exit "$CODE"
