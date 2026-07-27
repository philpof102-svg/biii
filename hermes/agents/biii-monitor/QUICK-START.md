# Démarrage Rapide - LoopEscrow Deep Scan

## Ce qui a été créé

### 1. **deep-scan.js** - Moteur de scraping profond
- Scrape la blockchain Base en profondeur
- Utilise BIII (till_vet_asset, till_trust) + holders-health
- Sauvegarde l'historique et les notes pour mémoire
- Détecte les patterns suspects (drain, mixing, fake tokens)

### 2. **deep-scan-prompt.md** - Instructions pour Hermes
- Méthodologie DIG DEEP détaillée
- Patterns de détection (drain, mixing, fake tokens)
- Format de délégation des investigations
- Boucle d'amélioration continue

### 3. **continuous-loop.cmd** - Exécution en continu
- Lance le deep scan toutes les 30 min
- Compatible Windows (peut être adapté pour Linux)
- Logs datés dans `cache/`

### 4. **LOOPESCREW-README.md** - Documentation
- Explique le concept LoopEscrow
- Architecture de la boucle
- Format des notes pour mémoire

## Démarrage immédiat

### Test manuel (Windows)
```cmd
cd D:\Users\VolKov\veilleIA\biii
node hermes/agents/biii-monitor/deep-scan.js
```

### Déploiement avec Hermes Cron
```bash
# Option 1: Keyless watchdog (toutes les 30 min, pas de modèle nécessaire)
hermes cron create '30m' --script deep-scan.sh --no-agent --name biii-deep-watch --deliver local

# Option 2: Avec agent + délégation (nécessite clé OpenRouter)
hermes cron create '30m' 'Scan the biii watchlist via deep-scan.js; for each FLAG, delegate a focused follow-up. Flags first, then what you delegated. Never say "safe".' --skill base-token-trust --name biii-deep-monitor --deliver local
```

### Adaptation pour Linux (Railway)
Créer `deep-scan.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
BIII_DIR="${BIII_DIR:-$HOME/biii}"
MON="$BIII_DIR/hermes/agents/biii-monitor"
exec node "$MON/deep-scan.js" "$MON/watchlist.json"
```

Puis l'ajouter au cron Hermes ou au Dockerfile de Railway.

## Notes pour la mémoire (LoopEscrow)

Les notes sont automatiquement sauvegardées dans:
- `cache/deep-scan-notes.md` - Notes textuelles pour l'humain
- `cache/scan-history.json` - Historique machine

**Important**: À chaque session, LIRE ces notes pour continuer l'investigation là où on s'est arrêté.

## Prochaines étapes pour améliorer

1. **Ajouter RPC Base direct** - Interroger `eth_getLogs` pour tracer les transferts USDC réels
2. **Étendre la watchlist** - Ajouter plus de tokens meme populaires sur Base
3. **Ajouter détection de patterns** - Drain attack, mixing, fake tokens
4. **Intégrer avec BIII node** - POST les flags sur `/radar` pour dashboard
5. **Alerting** - Notifications quand un flag est détecté

## État actuel de BIII (rappel)
- ✅ BIII sell server sur Railway (1er settle $0.25 USDC prouvé)
- ✅ BIII monitor node + MCP endpoint (`/mcp`, 15 tools)
- ✅ Sentinelle biii-watch (cron Hermes 30m, $0)
- ✅ Mini-app `/x402/vet-meme` livrée
- 🔄 **LoopEscrow** - NOUVEAU: Boucle de vérification continue avec mémoire

---
Prêt à être testé et déployé!
