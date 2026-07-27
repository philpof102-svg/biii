#!/usr/bin/env node
'use strict';
/**
 * deep-scan-v2.js — Scraping blockchain + plateformes de lancement (B20 focus)
 * ====================================================================
 * Version améliorée qui:
 * - Scrap la blockchain Base en profondeur (wallets, tokens)
 * - Surveille les plateformes de lancement (B20, pump.fun, etc.)
 * - Détecte les nouveaux tokens à risque sur ces plateformes
 * - Laisse des notes pour la prochaine session mémoire
 */

const fs = require('node:fs');
const path = require('node:path');
const { screenAddress } = require('../../../lib/screen');
const { loadFloor } = require('../../../lib/vet');
const { assessAsset } = require('../../../lib/asset');
const { loadAssetRegistry } = require('../../../lib/asset-registry');
/* Le module exporte `checkHoldersHealth`. La destructuration rendait `undefined`, l'appel jetait, et le
 * catch transformait ca en « holders-health non disponible » — une coquille chez nous deguisee en
 * limitation externe. Meme faute que dans deep-scan.js: le fichier a ete copie avec. */
const { checkHoldersHealth } = require('../../../lib/holders-health');

const CACHE_DIR = path.join(__dirname, 'cache');
const NOTES_FILE = path.join(CACHE_DIR, 'deep-scan-notes.md');
const HISTORY_FILE = path.join(CACHE_DIR, 'scan-history.json');

// Importer l'intégration B20
const { B20Monitor } = require('./launchers-integration-v3.js');

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
  
  // 2. TODO: Implémenter RPC pour transferts réels
  notes.push(`ℹ️ WALLET ${address.slice(0, 10)}... [RPC] À implémenter: récupération transferts USDC`);
  
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
    /* ⚠️ CONDITION INVERSEE, comme dans deep-scan.js. `score` est un RISQUE (plus bas = plus sain), donc
     * `score < 50` signalait les tokens SAINS. Et une lecture ratee rend `score: 100, metrics: null`:
     * sans le test sur `error`, une panne se lirait « distribution suspecte ». */
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
 * Scan des plateformes de lancement (B20 focus)
 */
async function scanLaunchPlatforms(platforms) {
  const notes = [];
  const flags = [];
  
  console.log('\n🚀 Scan des plateformes de lancement...');
  
  for (const platform of platforms) {
    if (!platform.enabled) {
      console.log(`⏭️  ${platform.name} désactivé`);
      continue;
    }
    
    console.log(`📡 Scan ${platform.name} (${platform.chain})...`);
    
    try {
      if (platform.name === 'b20') {
        const b20Monitor = new B20Monitor();
        const tokens = await b20Monitor.getRecentLaunches(20);
        
        notes.push(`ℹ️ PLATEFORME ${platform.name}: ${tokens.length} tokens trouvés`);
        
        // Analyser chaque token pour risques
        for (const token of tokens) {
          if (token.risk > 70) {
            flags.push({
              kind: 'platform-token',
              severity: 'high',
              platform: platform.name,
              address: token.address,
              symbol: token.symbol,
              verdict: 'high-risk-launch',
              reason: `Score risque ${token.risk}/100 sur ${platform.name}`,
              delegate: `Investigue ce token ${token.symbol} lancé sur ${platform.name}. Pourquoi score si élevé ?`
            });
            notes.push(`⚠️ ${platform.name} TOKEN ${token.symbol}: RISQUE ÉLEVÉ ${token.risk}/100`);
          } else if (token.risk > 40) {
            notes.push(`⚠️ ${platform.name} TOKEN ${token.symbol}: Risque moyen ${token.risk}/100`);
          } else {
            notes.push(`✅ ${platform.name} TOKEN ${token.symbol}: Risque faible ${token.risk}/100`);
          }
        }
      } else {
        notes.push(`ℹ️ PLATEFORME ${platform.name}: Scan à implémenter pour cette plateforme`);
      }
    } catch (e) {
      notes.push(`⚠️ PLATEFORME ${platform.name}: Erreur ${e.message}`);
    }
  }
  
  return { flags, notes };
}

/**
 * Fonction principale de deep scan
 */
async function runDeepScan() {
  const wlPath = process.argv[2] || path.join(__dirname, 'watchlist.json');
  let watchlist = { addresses: [], tokens: [], platforms: [] };
  
  try {
    watchlist = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
  } catch (e) {
    console.error('Erreur lecture watchlist:', e.message);
    process.exit(1);
  }
  
  console.log('🚀 Démarrage Deep Scan V2 (Blockchain + Plateformes)...');
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  
  // Charger l'état précédent pour mémoire
  const previousNotes = loadPreviousNotes();
  
  const floor = loadFloor();
  const registry = loadAssetRegistry().entries || [];
  
  const allFlags = [];
  const allNotes = [];
  
  // 1. Scan wallets
  console.log('\n📍 PHASE 1: Scan wallets...');
  for (const addr of watchlist.addresses) {
    const { flags, notes } = await deepScanWallet(addr, floor);
    allFlags.push(...flags);
    allNotes.push(...notes);
  }
  
  // 2. Scan tokens
  console.log('\n📍 PHASE 2: Scan tokens...');
  for (const token of watchlist.tokens) {
    const { flags, notes } = await deepScanToken(token, registry);
    allFlags.push(...flags);
    allNotes.push(...notes);
  }
  
  // 3. Scan plateformes de lancement (B20 focus)
  console.log('\n📍 PHASE 3: Scan plateformes de lancement...');
  if (watchlist.platforms && watchlist.platforms.length > 0) {
    const { flags, notes } = await scanLaunchPlatforms(watchlist.platforms);
    allFlags.push(...flags);
    allNotes.push(...notes);
  } else {
    allNotes.push('ℹ️ Aucune plateforme configurée dans watchlist.json');
  }
  
  // Générer le rapport
  const report = {
    timestamp: new Date().toISOString(),
    scanned: {
      wallets: watchlist.addresses.length,
      tokens: watchlist.tokens.length,
      platforms: watchlist.platforms ? watchlist.platforms.length : 0
    },
    flags: allFlags,
    notes: allNotes,
    previousSession: previousNotes ? 'disponible' : 'aucune'
  };
  
  // Sauvegarder pour mémoire (LoopEscrow)
  const memoryNotes = `# Deep Scan V2 Notes - ${new Date().toISOString()}
## Flags détectés: ${allFlags.length}
${allNotes.map(n => `- ${n}`).join('\n')}

## Pour la prochaine session
- Revérifier les flags ci-dessus
- Approfondir les délégations en cours
- Vérifier si de nouveaux wallets known-bad sont apparus
- **B20 FOCUS**: Surveiller les nouveaux tokens sur B20 (Base)
- Analyser la qualité des lancements sur B20 vs autres plateformes

---
${previousNotes}
`;
  
  saveNotes(memoryNotes);
  
  // Afficher le rapport
  console.log('\n📊 RAPPORT DEEP SCAN V2');
  console.log('='.repeat(50));
  console.log(`⏰ ${report.timestamp}`);
  console.log(`📍 Watchlist: ${report.scanned.wallets} wallets, ${report.scanned.tokens} tokens, ${report.scanned.platforms} plateformes`);
  console.log(`🚩 Flags: ${report.flags.length}`);
  console.log(`📝 Notes: ${report.notes.length}`);
  
  if (allFlags.length > 0) {
    console.log('\n⚠️ FLAGS DÉTECTÉS:');
    allFlags.forEach(f => {
      console.log(`  🔴 ${f.kind}: ${f.verdict}`);
      console.log(`     ${f.reason}`);
      if (f.delegate) console.log(`     👉 Délégation: ${f.delegate}`);
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
    console.error('Erreur deep scan v2:', e);
    process.exit(1);
  });
}

module.exports = { runDeepScan, deepScanWallet, deepScanToken, scanLaunchPlatforms };
