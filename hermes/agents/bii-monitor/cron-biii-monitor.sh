#!/bin/bash
# Script de cron pour BIII Monitor - Deep Scan amélioré
# Ce script est appelé par Hermes cron toutes les 30 minutes

set -e

# Aller dans le répertoire du projet
cd "$(dirname "$0")/../.." || exit 1

# Charger les variables d'environnement si nécessaire
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Exécuter le deep scan
echo "🚀 Démarrage BIII Monitor Deep Scan - $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
node hermes/agents/bii-monitor/deep-scan.js hermes/agents/bii-monitor/watchlist.json

# Vérifier le résultat
if [ $? -eq 0 ]; then
    echo "✅ Deep scan terminé avec succès"
else
    echo "❌ Erreur lors du deep scan"
    exit 1
fi

# Afficher un résumé
echo "📊 Résumé disponible dans hermes/agents/bii-monitor/cache/deep-scan-notes.md"
