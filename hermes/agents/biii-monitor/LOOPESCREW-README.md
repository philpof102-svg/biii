# LoopEscrow - Boucle de Vérification Continue avec Mémoire

## Qu'est-ce que LoopEscrow ?

LoopEscrow est une boucle de vérification système continue qui :
1. Scrape la blockchain Base en profondeur (DIG DEEP)
2. Détecte les menaces (known-bad wallets, tokens impersonators)
3. **Laisse des notes détaillées pour la prochaine session mémoire**
4. Améliore le système en continu grâce à l'apprentissage

## Architecture

```
Watchlist (wallets + tokens)
    ↓ (toutes les 30 min)
Deep Scan (deep-scan.js)
    ↓
Détection de flags (known-bad, impersonation, suspicious)
    ↓
Délégation d'investigations (sub-agents Hermes)
    ↓
Notes pour mémoire (cache/deep-scan-notes.md)
    ↓
Historique (cache/scan-history.json)
    ↓
Prochaine session : lit les notes et continue l'investigation
```

## Fichiers Créés/Modifiés

### 1. `deep-scan.js` (NOUVEAU)
- Scraping profond de la blockchain Base
- Utilise BIII (till_vet_asset, till_trust) + holders-health
- Sauvegarde l'historique et les notes pour mémoire
- Track les patterns suspects (drain, mixing, fake tokens)

### 2. `deep-scan-prompt.md` (NOUVEAU)
- Instructions détaillées pour l'agent Hermes
- Patterns de détection (DIG DEEP)
- Format de délégation des investigations
- Boucle d'amélioration continue

### 3. `continuous-loop.cmd` (NOUVEAU)
- Lance le deep scan en continu (toutes les 30 min)
- Compatible avec Hermes cron ou service Windows
- Logs datés dans `cache/`

### 4. `LOOPESCREW-README.md` (CE FICHIER)
- Documentation de l'approche LoopEscrow
- Guide pour la prochaine session mémoire

## Utilisation

### Lancer en manuel (test)
```bash
cd D:\Users\VolKov\veilleIA\biii
node hermes/agents/biii-monitor/deep-scan.js
```

### Lancer en continu (production)
```bash
cd D:\Users\VolKov\veilleIA\biii\hermes\agents\biii-monitor
continuous-loop.cmd
```

### Configurer avec Hermes Cron
```bash
# Keyless watchdog (toutes les 30 min, pas de modèle nécessaire)
hermes cron create '30m' --script deep-scan.sh --no-agent --name biii-deep-watch --deliver local

# Avec agent + délégation (nécessite clé OpenRouter)
hermes cron create '30m' --skill base-token-trust --name biii-deep-monitor --deliver local
```

## Notes pour la Prochaine Session Mémoire

Les notes sont sauvegardées dans :
- `cache/deep-scan-notes.md` : Notes textuelles pour l'humain
- `cache/scan-history.json` : Historique machine pour tracking

### Format des notes (exemple)
```markdown
# Deep Scan Notes - 2026-07-24T10:30:00Z
## Nouveaux flags: 2
- Flag 1: wallet 0x098B... known-bad: Scammer wallet detected
  → Délégation: Trace recent transfers
- Flag 2: token 0x4b0a... impersonation: Fake TOSHI token
  → Délégation: Find deployer and creation block

## Patterns détectés cette session
- Drain pattern sur 3 wallets (fonds envoyés à 0xABC...)
- Token DOGIN a un holder health score de 35/100 (suspect)

## Pour la prochaine session (rappel mémoire)
- Revérifier si 0x098B... a de nouveaux counterparties
- Monitorer les nouveaux tokens créés dans les dernières 24h
- Checker si des wallets known-bad ont changé de comportement
```

## Prochaines Étapes pour Améliorer le Système

1. **Ajouter RPC Base direct** : Interroger `eth_getLogs` pour tracer les transferts USDC réels
2. **Étendre la watchlist** : Ajouter plus de tokens meme populaires sur Base
3. **Ajouter détection de patterns** : 
   - Drain attack (fonds → token look-alike → wallet inconnu)
   - Mixing (plusieurs wallets → une adresse → redistribution)
4. **Intégrer avec BIII node** : POST les flags sur `/radar` pour dashboard
5. **Alerting** : Notifications (email, Telegram) quand un flag est détecté

## État du Déploiement BIII

- ✅ BIII sell server sur Railway (1er settle $0.25 USDC prouvé)
- ✅ BIII monitor node + MCP endpoint (`/mcp`, 15 tools `till_*`)
- ✅ Sentinelle biii-watch (cron Hermes 30m, $0)
- ✅ Mini-app `/x402/vet-meme` livrée (Railway, à tester live)
- 🔄 **LoopEscrow** : Boucle de vérification continue (CE QUI VIENT D'ÊTRE CRÉÉ)

## Comment Contribuer/Améliorer

1. Lire `deep-scan-prompt.md` pour comprendre la méthodologie DIG DEEP
2. Ajouter des wallets/tokens à `watchlist.json`
3. Améliorer `deep-scan.js` pour ajouter plus de détections
4. Tester en local avec `node deep-scan.js`
5. Déployer en prod avec Hermes cron

---
**Rappel** : LoopEscrow laisse des notes à CHAQUE session. La prochaine session mémoire doit LIRE ces notes pour continuer l'investigation là où on s'est arrêté.
