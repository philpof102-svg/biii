#!/usr/bin/env node
'use strict';
/**
 * biii-realtime-monitor.js — Surveillance en temps réel BIII
 * =======================================================
 * Surveille en continu:
 * - Watchlist (wallets + tokens)
 * - Nouveaux lancements sur plateformes (via launchers-integration-v2)
 * - Activité on-chain suspecte
 * 
 * Laisse des notes pour la mémoire
 * Score de risque en temps réel
 * Alertes si seuil dépassé
 */

const fs = require('node:fs');
const path = require('node:path');
const { LaunchersIntegration } = require('./launchers-integration-v2.js');

const CACHE_DIR = path.join(__dirname, 'cache');
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
const ALERTS_FILE = path.join(CACHE_DIR, 'realtime-alerts.json');
const MEMORY_FILE = path.join(CACHE_DIR, 'realtime-memory.md');

// Configuration
const CONFIG = {
  scanInterval: 5 * 60 * 1000, // 5 minutes
  alertThreshold: 70, // Score de risque > 70 = alerte
  maxAlerts: 100,
  enableLaunchers: true,
  enableDeepScan: true
};

/**
 * Charge la watchlist
 */
function loadWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch (e) {
    console.error('Erreur chargement watchlist:', e.message);
    return { addresses: [], tokens: [] };
  }
}

/**
 * Sauvegarde les alertes
 */
function saveAlerts(alerts) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde alertes:', e.message);
  }
}

/**
 * Charge les alertes existantes
 */
function loadAlerts() {
  try {
    return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
  } catch {
    return { alerts: [], lastUpdate: null };
  }
}

/**
 * Ajoute une note en mémoire
 */
function addMemoryNote(note) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const line = `\n## ${timestamp}\n${note}\n`;
    fs.appendFileSync(MEMORY_FILE, line);
  } catch (e) {
    console.error('Erreur mémoire:', e.message);
  }
}

/**
 * Analyse un wallet en temps réel
 */
async function monitorWallet(address, watchlist) {
  const alerts = [];
  
  /* Comparaison INSENSIBLE A LA CASSE. `includes()` sur des adresses brutes ratait toute entree
   * checksummee — la forme que rendent portefeuilles et explorateurs — donc le controle pouvait ne
   * jamais se declencher sur une watchlist ecrite a la main. `monitorToken`, juste en dessous, normalise
   * deja correctement: deux traitements opposes de la meme donnee dans le meme fichier. */
  const cible = String(address || '').toLowerCase();
  const surveillees = (watchlist.addresses || []).map((a) => String(a).toLowerCase());
  if (cible && surveillees.includes(cible)) {
    alerts.push({
      type: 'wallet-watchlist',
      severity: 'high',
      address,
      message: `Wallet ${address.slice(0, 10)}... est dans la watchlist`,
      timestamp: Date.now()
    });
  }
  
  // TODO: Intégrer avec deep-scan.js pour analyse profonde
  // Pour l'instant, retourne juste les alertes de base
  
  return alerts;
}

/**
 * Analyse un token en temps réel
 */
async function monitorToken(token, watchlist) {
  const alerts = [];
  
  // Vérifier si le token est dans la watchlist
  const isWatched = watchlist.tokens.some(t => 
    t.address.toLowerCase() === token.address.toLowerCase()
  );
  
  if (isWatched) {
    alerts.push({
      type: 'token-watchlist',
      severity: 'medium',
      address: token.address,
      symbol: token.symbol,
      message: `Token surveillé ${token.symbol} détecté`,
      timestamp: Date.now()
    });
  }
  
  /* TROIS ETATS, pas deux. `token.risk > 70` avec un `risk` ABSENT donne `false` — donc un token dont on
   * ignore le risque etait traite exactement comme un token mesure a risque faible. Sur un moniteur, ne
   * pas savoir doit se voir. */
  const risque = Number(token.risk);
  if (!Number.isFinite(risque)) {
    alerts.push({
      type: 'risk-unknown', severity: 'low', address: token.address, symbol: token.symbol,
      message: `Token ${token.symbol || token.address} : score de risque NON FOURNI par la source — non evalue, ce n'est pas « faible »`,
      timestamp: Date.now(),
    });
  } else if (risque > CONFIG.alertThreshold) {
    alerts.push({
      type: 'high-risk-token',
      severity: 'high',
      address: token.address,
      symbol: token.symbol,
      risk: token.risk,
      message: `Token ${token.symbol} a un score de risque élevé: ${token.risk}/100`,
      timestamp: Date.now()
    });
  }
  
  return alerts;
}

/**
 * Surveillance principale
 */
class RealtimeMonitor {
  constructor() {
    this.isRunning = false;
    this.timer = null;
    this.launchersIntegration = CONFIG.enableLaunchers ? new LaunchersIntegration() : null;
    this.alertCount = 0;
  }
  
  async start() {
    if (this.isRunning) {
      console.log('⚠️ Surveillance déjà en cours');
      return;
    }
    
    this.isRunning = true;
    console.log('🚀 Démarrage surveillance temps réel BIII...');
    addMemoryNote('Surveillance temps réel démarrée');
    
    // Premier scan immédiat
    await this.scan();
    
    // Boucle continue — le handle est RETENU pour que stop() puisse reellement arreter.
    if (CONFIG.scanInterval > 0) {
      console.log(`⏰ Prochain scan dans ${CONFIG.scanInterval / 60000} min`);
      this.timer = setInterval(async () => {
        if (!this.isRunning) return;               // ceinture: un tick en vol apres stop() ne relance rien
        await this.scan();
      }, CONFIG.scanInterval);
    }
  }
  
  async scan() {
    console.log(`\n🔍 Scan ${new Date().toLocaleTimeString()}...`);

    const watchlist = loadWatchlist();
    const allAlerts = loadAlerts();
    const newAlerts = [];
    /* CE QUI N'A PAS PU ETRE REGARDE. Sans cette liste, un scan dont la source a echoue finissait avec
     * zero alerte et imprimait « ✅ Aucune alerte » — sur un MONITEUR DE SECURITE, un echec qui se lit
     * « tout va bien ». C'est la faute que ce depot corrige partout ailleurs; elle etait ici aussi. */
    const nonLu = [];

    // 1. Scan des plateformes de lancement
    if (this.launchersIntegration) {
      console.log('📡 Scan plateformes de lancement...');
      try {
        const results = await this.launchersIntegration.scanAllPlatforms();

        /* Une plateforme peut echouer SANS que scanAllPlatforms jette: elle rend alors une liste vide.
         * Le `catch` ci-dessous n'attrape donc que l'echec TOTAL, et sans cette lecture le scan pouvait
         * se declarer complet avec toutes ses sources muettes. Corriger la couche du dessus ne suffisait
         * pas — il fallait que celle du dessous dise pourquoi elle est vide. */
        for (const p of (results.unavailable || [])) nonLu.push(p.platform + ': ' + p.reason);

        // Analyser chaque token détecté
        for (const [platform, data] of Object.entries(results.platforms)) {
          for (const token of data.tokens) {
            const tokenAlerts = await monitorToken(token, watchlist);
            newAlerts.push(...tokenAlerts);
          }
        }
      } catch (e) {
        console.error('Erreur scan plateformes:', e.message);
        nonLu.push('plateformes de lancement: ' + e.message);
      }
    }
    
    // 2. TODO: Scan des wallets de la watchlist
    // (nécessite intégration avec deep-scan.js ou RPC)
    
    // 3. Sauvegarder les nouvelles alertes
    if (newAlerts.length > 0) {
      console.log(`⚠️ ${newAlerts.length} nouvelle(s) alerte(s)`);
      
      for (const alert of newAlerts) {
        allAlerts.alerts.push(alert);
        this.alertCount++;
        
        // Note en mémoire
        addMemoryNote(`ALERTE [${alert.severity}]: ${alert.message}`);
      }
      
      // Limiter le nombre d'alertes
      if (allAlerts.alerts.length > CONFIG.maxAlerts) {
        allAlerts.alerts = allAlerts.alerts.slice(-CONFIG.maxAlerts);
      }
      
      allAlerts.lastUpdate = Date.now();
      saveAlerts(allAlerts);
    } else if (nonLu.length) {
      /* Zero alerte APRES un echec de lecture n'est pas « rien a signaler ». Les deux cas etaient
       * confondus sous une seule coche verte. */
      console.log(`⚠️ Aucune alerte, mais ${nonLu.length} source(s) NON LUE(S) — ce n'est pas un feu vert:`);
      for (const r of nonLu) console.log('   - ' + r);
      addMemoryNote('Scan INCOMPLET, sources non lues: ' + nonLu.join(' | '));
    } else {
      console.log('✅ Aucune alerte (toutes les sources ont repondu)');
    }

    console.log(`📊 Total alertes: ${this.alertCount}`);
    return { newAlerts, nonLu, complete: nonLu.length === 0 };
  }

  stop() {
    /* `stop()` ne stoppait RIEN: le handle de setInterval n'etait pas retenu et `scan()` ne consultait
     * pas `isRunning`. On appelait « surveillance arretee » et la boucle continuait a tourner. */
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.isRunning = false;
    console.log('🛑 Surveillance arrêtée');
    addMemoryNote('Surveillance temps réel arrêtée');
  }
}

// CLI
async function main() {
  const monitor = new RealtimeMonitor();
  
  if (process.argv.includes('--start')) {
    await monitor.start();
  } else if (process.argv.includes('--once')) {
    console.log('🔍 Scan unique...');
    await monitor.scan();
  } else if (process.argv.includes('--status')) {
    const alerts = loadAlerts();
    console.log('📊 État de la surveillance:');
    console.log(`Total alertes: ${alerts.alerts.length}`);
    /* `new Date(null)` vaut l'epoch: sans ce test, une installation neuve affichait « 01/01/1970 »,
     * ce qui se lit comme une mise a jour tres ancienne au lieu de « jamais ». */
    console.log(`Dernière mise à jour: ${alerts.lastUpdate ? new Date(alerts.lastUpdate).toLocaleString() : 'jamais (aucun scan enregistré)'}`);
  } else {
    console.log('Usage: node biii-realtime-monitor.js [--start|--once|--status]');
    console.log('');
    console.log('Options:');
    console.log('  --start   Démarre la surveillance continue (toutes les 5 min)');
    console.log('  --once    Lance un scan unique');
    console.log('  --status  Affiche l\'état des alertes');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { RealtimeMonitor, CONFIG };
