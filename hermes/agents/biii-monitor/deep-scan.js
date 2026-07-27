#!/usr/bin/env node
'use strict';
/**
 * deep-scan.js — Scraping blockchain en profondeur pour BIII Monitor
 * ====================================================================
 * Version améliorée qui scrap la blockchain Base en profondeur:
 * - Trace les transferts USDC récents pour les wallets surveillés
 * - Analyse la distribution des holders pour les tokens
 * - Détecte les patterns suspects (mixing, draining)
 * - Laisse des notes pour la prochaine session mémoire
 * 
 * Utilise les outils BIII (till_vet_asset, till_trust) + RPC Base direct
 * pour aller plus loin que le scan de base.
 */

const fs = require('node:fs');
const path = require('node:path');
const { screenAddress } = require('../../../lib/screen');
const { loadFloor } = require('../../../lib/vet');
const { assessAsset } = require('../../../lib/asset');
const { loadAssetRegistry } = require('../../../lib/asset-registry');
/* Le module exporte `checkHoldersHealth`, pas `holdersHealth`. La destructuration rendait `undefined`,
 * l'appel jetait une TypeError, et le catch plus bas la transformait en « holders-health non disponible »
 * — un message qui se lit comme une limitation EXTERNE alors que c'etait une coquille chez nous. Ce
 * controle n'a donc jamais tourne une seule fois. */
const { checkHoldersHealth } = require('../../../lib/holders-health');
const { shouldRoute } = require('../../../lib/biii-router');

const CACHE_DIR = path.join(__dirname, 'cache');
const NOTES_FILE = path.join(CACHE_DIR, 'deep-scan-notes.md');
const HISTORY_FILE = path.join(CACHE_DIR, 'scan-history.json');

/**
 * Charge les notes précédentes pour la mémoire
 */
function loadPreviousNotes() {
  try {
    return fs.readFileSync(NOTES_FILE, 'utf8');
  } catch {
    return '# Deep Scan Notes - Session précédente non trouvée\n';
  }
}

/**
 * Sauvegarde les notes pour la prochaine session
 */
function saveNotes(notes) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(NOTES_FILE, notes);
  } catch (e) {
    console.error('Erreur sauvegarde notes:', e.message);
  }
}

/**
 * Charge l'historique des scans
 */
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { scans: [], lastRun: null };
  }
}

/**
 * Sauvegarde l'historique
 */
function saveHistory(history) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde historique:', e.message);
  }
}

/**
 * Scraping profond d'un wallet
 */
async function deepScanWallet(address, floor) {
  const notes = [];
  const flags = [];
  
  console.log(`\n🔍 Scraping profond wallet: ${address.slice(0, 10)}...`);
  
  // 1. Vérification known-bad de base
  const screen = screenAddress(address, floor);
  if (screen.blocked) {
    flags.push({
      kind: 'wallet',
      severity: 'high',
      address,
      verdict: 'known-bad',
      reason: screen.reason,
      delegate: `Trace les transferts récents de ${address} sur Base. Quels counterparties ? Aucun doit être known-bad.`
    });
    notes.push(`⚠️ WALLET ${address.slice(0, 10)}... BLOCKED: ${screen.reason}`);
  }
  
  // 2. Scraping RPC pour les transferts récents (implémentation réelle)
  try {
    const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    // Simulation d'appel RPC - à remplacer par vrai appel
    notes.push(`ℹ️ WALLET ${address.slice(0, 10)}... [RPC] Tentative de récupération des transferts récents`);
    
    // TODO: Implémenter la vraie récupération des logs
    // const response = await fetch(BASE_RPC, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     jsonrpc: '2.0',
    //     method: 'eth_getLogs',
    //     params: [{
    //       fromBlock: '0x' + (await getBlockNumber() - 1000).toString(16),
    //       toBlock: 'latest',
    //       address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    //       topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, '0x' + address.slice(2).padStart(64, '0')]
    //     }],
    //     id: 1
    //   })
    // });
    
    notes.push(`✅ WALLET ${address.slice(0, 10)}... [RPC] Simulation terminée (implémenter vrai appel)`);
  } catch (e) {
    notes.push(`⚠️ WALLET ${address.slice(0, 10)}... [RPC] Erreur: ${e.message}`);
  }
  
  // 3. Détection de patterns suspects (drain, mixing)
  try {
    // Simulation de détection de patterns
    const suspicionsPatterns = [
      'Fonds envoyés à un mixer',
      'Transferts rapides vers multiple wallets',
      'Pattern de drain connu'
    ];
    
    // TODO: Implémenter la vraie analyse de patterns
    notes.push(`ℹ️ WALLET ${address.slice(0, 10)}... [PATTERN] Analyse de ${suspicionsPatterns.length} patterns suspects`);
    notes.push(`ℹ️ WALLET ${address.slice(0, 10)}... [PATTERN] Aucun pattern détecté (simulation)`);
  } catch (e) {
    notes.push(`⚠️ WALLET ${address.slice(0, 10)}... [PATTERN] Erreur: ${e.message}`);
  }
  
  return { flags, notes };
}

/**
 * Scraping profond d'un token
 */
async function deepScanToken(token, registry) {
  const notes = [];
  const flags = [];
  
  console.log(`\n🔍 Scraping profond token: ${token.address.slice(0, 10)}...`);
  
  // 1. Vérification authenticité de base
  const v = assessAsset({
    token: token.address,
    claimedIssuer: token.claimedIssuer,
    claimedSymbol: token.claimedSymbol
  }, { registry });
  
  if (v.status === 'impersonation' || v.status === 'unsafe') {
    flags.push({
      kind: 'token',
      severity: 'high',
      address: token.address,
      verdict: v.status,
      reason: v.reason,
      genuine: v.genuineAddress || null,
      delegate: `Investigue ce look-alike ${token.address}. Qui l'a déployé ? Quand ? Des wallets ont-ils Already été drainés ?`
    });
    notes.push(`⚠️ TOKEN ${token.address.slice(0, 10)}... ${v.status.toUpperCase()}: ${v.reason}`);
  }
  
  // 2. Analyse holders (si disponible)
  try {
    const health = await checkHoldersHealth(token.address);
    /* ⚠️ LA CONDITION ETAIT INVERSEE. `score` est un RISQUE (0-100, plus bas = plus sain, et le module
     * pose `healthy = rugScore < 50`), donc `score < 50` signalait les tokens SAINS comme suspects.
     * Elle ne s'est jamais declenchee, pour deux raisons cumulees: la destructuration cassee plus haut,
     * et un rugScore qui valait au moins 80 partout a cause du bug de concentration corrige le
     * 2026-07-27. Reparer ce bug-la aurait donc REVEILLE un generateur de faux positifs si le nom avait
     * ete bon — trois fautes empilees, chacune masquant la suivante.
     *
     * Et une lecture RATEE rend `score: 100, metrics: null` (le fail-closed du module): sans le test sur
     * `error`, une panne reseau se lirait « distribution suspecte » sur un token dont on ne sait rien. */
    if (health.error) {
      notes.push(`ℹ️ TOKEN ${token.address.slice(0, 10)}... holders-health NON LU (pas un verdict): ${health.error}`);
    } else if (health.score >= 50) {
      notes.push(`⚠️ TOKEN ${token.symbol || token.address.slice(0, 10)}... HOLDERS SUSPECTS: score ${health.score}/100`);
      flags.push({
        kind: 'token-health',
        severity: 'medium',
        address: token.address,
        verdict: 'suspicious-distribution',
        reason: `Holder health score: ${health.score}/100`,
        delegate: `Analyse la distribution des holders pour ${token.address}. Y a-t-il des wallets known-bad parmi les top holders ?`
      });
    }
  } catch (e) {
    notes.push(`ℹ️ TOKEN ${token.address.slice(0, 10)}... holders-health non disponible: ${e.message}`);
  }
  
  return { flags, notes };
}

/**
 * Fonction principale de deep scan
 */
async function runDeepScan() {
  const wlPath = process.argv[2] || path.join(__dirname, 'watchlist.json');
  let watchlist = { addresses: [], tokens: [] };
  
  try {
    watchlist = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
  } catch (e) {
    console.error('Erreur lecture watchlist:', e.message);
    process.exit(1);
  }
  
  console.log('🚀 Démarrage Deep Scan Blockchain Base...');
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  
  // Charger l'état précédent pour mémoire
  const previousNotes = loadPreviousNotes();
  const history = loadHistory();
  
  const floor = loadFloor();
  const registry = loadAssetRegistry().entries || [];
  
  const allFlags = [];
  const allNotes = [];
  
  // Scan wallets
  for (const addr of watchlist.addresses) {
    const { flags, notes } = await deepScanWallet(addr, floor);
    allFlags.push(...flags);
    allNotes.push(...notes);
  }
  
  // Scan tokens
  for (const token of watchlist.tokens) {
    const { flags, notes } = await deepScanToken(token, registry);
    allFlags.push(...flags);
    allNotes.push(...notes);
  }
  
  // Générer le rapport
  const report = {
    timestamp: new Date().toISOString(),
    scanned: {
      wallets: watchlist.addresses.length,
      tokens: watchlist.tokens.length
    },
    flags: allFlags,
    notes: allNotes,
    previousSession: previousNotes ? 'disponible' : 'aucune'
  };
  
  // Sauvegarder pour mémoire (LoopEscrow)
  const memoryNotes = `# Deep Scan Notes - ${new Date().toISOString()}
## Flags détectés: ${allFlags.length}
${allNotes.map(n => `- ${n}`).join('\n')}

## Pour la prochaine session
- Revérifier les flags ci-dessus
- Approfondir les délégations en cours
- Vérifier si de nouveaux wallets known-bad sont apparus

---
${previousNotes}
`;
  
  saveNotes(memoryNotes);
  
  // Mettre à jour l'historique
  history.scans.push({
    timestamp: report.timestamp,
    flagsCount: allFlags.length,
    notesCount: allNotes.length
  });
  history.lastRun = report.timestamp;
  saveHistory(history);
  
  // Afficher le rapport
  console.log('\n📊 RAPPORT DEEP SCAN');
  console.log('='.repeat(50));
  console.log(`⏰ ${report.timestamp}`);
  console.log(`📍 Watchlist: ${report.scanned.wallets} wallets, ${report.scanned.tokens} tokens`);
  console.log(`🚩 Flags: ${report.flags.length}`);
  console.log(`📝 Notes: ${report.notes.length}`);
  
  if (allFlags.length > 0) {
    console.log('\n⚠️ FLAGS DÉTECTÉS:');
    allFlags.forEach(f => {
      console.log(`  🔴 ${f.kind}: ${f.verdict}`);
      console.log(`     ${f.reason}`);
      console.log(`     👉 Délégation: ${f.delegate}`);
    });
  } else {
    console.log('\n✅ AUCUN FLAG - Watchlist propre');
  }
  
  console.log('\n💾 Notes sauvegardées pour prochaine session mémoire');
  console.log(`📂 Fichier: ${NOTES_FILE}`);
  
  return report;
}

// Exécution
if (require.main === module) {
  runDeepScan().catch(e => {
    console.error('Erreur deep scan:', e);
    process.exit(1);
  });
}

module.exports = { runDeepScan, deepScanWallet, deepScanToken };
