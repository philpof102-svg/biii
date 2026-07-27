'use strict';
/**
 * biii-router.js — BIII safe-to-pay router using USDC transfer log filter
 * ======================================================================
 * Routes BIII calls ONLY to addresses with >$1k daily settlement (strategist idea).
 * Uses lib/usdc-filter.js to track daily volumes from Base RPC eth_getLogs.
 *
 * ⚠️ CE QUE CE MODULE N'EST PAS, ecrit ici parce que l'en-tete disait le contraire jusqu'au 2026-07-27:
 * « Integration: call shouldRoute(payeeAddress) before processing a BIII payment. If returns false, the
 * address is not an active payee → reject or flag. » Suivre cette instruction refuserait de payer TOUT
 * LE MONDE avant le premier balayage, et tout commercant honnete en dessous de 1000 $ de reglement
 * QUOTIDIEN — c'est-a-dire la quasi-totalite d'entre eux. Le volume de reglement est un signe de
 * LIQUIDITE, jamais d'honnetete: une fabrique a rugs bien financee le franchit, une boulangerie non.
 *
 * Utiliser `routeVerdict()` et lire `basis`: « unscanned » est une lacune de notre cote, « measured » est
 * une observation. Ne jamais presenter la premiere comme une propriete du beneficiaire.
 *
 * Etat au 2026-07-27: dormant. `shouldRoute` est importe dans lib/server.js et jamais appele; le balayage
 * est derriere BIII_ROUTER_ENABLED, absente de la production (verifie via `railway variables`).
 */

const { scanTransfers, getActivePayees, volumesGeneration } = require('./usdc-filter');

const DEFAULT_RPC = 'https://mainnet.base.org';
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
/* Deux intervalles rates et la donnee cesse d etre une observation. Le choix vaut mieux que pas de
 * choix, mais c est un choix: il est publie dans routeVerdict pour que le lecteur puisse le contester. */
const STALE_AFTER_MS = 2 * SCAN_INTERVAL_MS;

let scanRunning = false;
let lastScan = 0;
/* Sous QUELLE generation de table le dernier balayage reussi a tourne. -1 = jamais. */
let scannedGeneration = -1;

/**
 * routeVerdict — pourquoi on route ou non, en TROIS etats.
 *
 * ⚠️ `shouldRoute` rendait un booleen documente « true if safe to pay, false otherwise », et ce `false`
 * recouvrait deux faits opposes:
 *   - l'adresse a un volume MESURE sous le seuil (une observation sur elle);
 *   - aucun balayage n'a encore tourne, donc on ne sait rien (une lacune de NOTRE cote).
 * Avant le premier `backgroundScan`, la table est vide et tout le monde repond `false` — « pas sur de
 * payer », a propos de n'importe qui. Et le seuil est de 1000 $ de reglement QUOTIDIEN: un commercant
 * honnete de petite taille ne l'atteint jamais, donc `false` est son etat NORMAL. Appeler ca « safe to
 * pay » transforme une heuristique de routage en verdict de securite.
 *
 * Rien ne consomme ce module aujourd'hui (verifie: `shouldRoute` est importe dans lib/server.js et jamais
 * appele, et le balayage est derriere BIII_ROUTER_ENABLED, absent de la production). C'est donc une faute
 * DORMANTE — mais l'en-tete du fichier invite explicitement a cabler `shouldRoute` avant un paiement, et
 * c'est ce cablage-la qui ferait l'affirmation fausse.
 *
 * @returns {{route: boolean, basis: 'measured'|'unscanned', reason: string, volumeUsd: number|null}}
 */
function routeVerdict(address, { now = Date.now() } = {}) {
  if (!address || typeof address !== 'string') {
    return { route: false, basis: 'unscanned', volumeUsd: null,
      reason: 'not an address — nothing was looked up' };
  }
  /* FRAICHEUR, comme partout ailleurs dans ce depot (le plancher known-bad porte asOf/ageDays/stale).
   * `lastScan` n'avance que sur un balayage REUSSI — c'est deja juste — mais si un balayage echoue apres
   * un premier succes, l'ancien horodatage reste et des chiffres perimes ressortaient en « measured »,
   * c'est-a-dire en observation. Passe le delai, la donnee redevient une lacune de notre cote. */
  const age = lastScan ? now - lastScan : null;
  const perime = age != null && age > STALE_AFTER_MS;
  /* VIDEE DEPUIS LE DERNIER BALAYAGE. `resetDailyVolumes()` est documente « call at midnight UTC »: la
   * table repart a zero et rien n'est rebalaye avant l'intervalle suivant. `lastScan`, lui, ne bougeait
   * pas — donc pendant une demi-heure chaque adresse ressortait en « measured, volumeUsd 0 », c'est-a-dire
   * en OBSERVATION, alors que c'est nous qui venions de tout effacer. Mesure faite dans un processus neuf
   * avant correction. */
  /* `>=` et non `>`: les deux horodatages ont une resolution d'une milliseconde, et a EGALITE on ne peut
   * pas savoir lequel est arrive en premier. Un vidage et un balayage dans la meme milliseconde sont
   * indiscernables, donc on prend la lecture prudente — table potentiellement vide, donc rien de mesure.
   * Trouve en test, ou les deux tombent effectivement dans la meme milliseconde; en production les
   * balayages sont espaces de trente minutes et le cas ne se pose pas. */
  const videeApres = lastScan > 0 && volumesGeneration() !== scannedGeneration;
  if (!lastScan || perime || videeApres) {
    return { route: false, basis: 'unscanned', volumeUsd: null, ageMs: age,
      reason: videeApres && lastScan
        ? 'the volume table was cleared after the last successful scan (the midnight reset), so it is '
          + 'empty by construction — nothing has been measured about this address since'
        : lastScan
          ? 'the last successful scan is ' + Math.round(age / 60000) + ' minutes old (stale past '
            + Math.round(STALE_AFTER_MS / 60000) + '), so these volumes are no longer an observation'
          : 'no scan has completed yet, so NOTHING is known about this address — this is a gap on our '
            + 'side, not an observation about the payee' };
  }
  const vu = getActivePayees().find((p) => p.address === String(address).toLowerCase());
  if (vu) {
    return { route: true, basis: 'measured', volumeUsd: vu.volume, ageMs: age,
      reason: 'measured at or above the daily settlement threshold in the scanned window' };
  }
  return { route: false, basis: 'measured', volumeUsd: 0,
    reason: 'no settlement at or above the threshold in the scanned window. NOT a safety verdict: the '
      + 'threshold is $1k of DAILY settlement, which an honest small merchant never reaches' };
}

/**
 * Check if a payee address should be routed (has >$1k daily USDC volume).
 * Fail-closed by design: unknown reads as "do not route". Use routeVerdict() when the caller needs to
 * tell "measured below threshold" from "never scanned" — presenting the second as a payee property is
 * the fault this file used to invite.
 * @param {string} address - Payee address to check
 * @returns {boolean} true if the address was MEASURED at/above the threshold; false otherwise
 */
function shouldRoute(address) {
  return routeVerdict(address).route;
}

/**
 * Get all active payees (addresses with >$1k daily volume)
 * @returns {Array} List of { address, volume, blocks }
 */
function getActivePayeesList() {
  return getActivePayees();
}

/**
 * Background scan of recent USDC transfers to update daily volumes
 * Call this periodically (every 30 min) to keep the router fresh.
 * @param {object} options - { rpcUrl, fetchImpl }
 */
async function backgroundScan(options = {}) {
  if (scanRunning) return;
  scanRunning = true;

  try {
    const rpcUrl = options.rpcUrl || DEFAULT_RPC;
    const f = options.fetchImpl || fetch;

    // Get current block number
    const headResp = await f(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(8000)
    });
    if (!headResp.ok) throw new Error(`Failed to get block number: HTTP ${headResp.status}`);
    const headJson = await headResp.json();
    if (headJson.error) throw new Error(`eth_blockNumber: ${headJson.error.message}`);
    const head = parseInt(headJson.result, 16);

    const fromBlock = '0x' + Math.max(0, head - 900).toString(16); // ~3 hours
    const toBlock = '0x' + head.toString(16);

    const count = await scanTransfers({ fromBlock, toBlock, rpcUrl, fetchImpl: f });
    lastScan = Date.now();
    scannedGeneration = volumesGeneration();
    console.log(`[biii-router] Scanned ${count} USDC transfers, ${getActivePayeesList().length} active payees`);
  } catch (err) {
    console.error('[biii-router] Background scan failed:', err.message);
  } finally {
    scanRunning = false;
  }
}

/**
 * Start the background scanner (call once when server starts)
 * @param {object} options - { rpcUrl, fetchImpl, intervalMs }
 */
function startBackgroundScan(options = {}) {
  const intervalMs = options.intervalMs || SCAN_INTERVAL_MS;

  // Initial scan
  backgroundScan(options);

  /* Le handle est RENDU: sans lui le minuteur ne peut plus etre arrete, ce qui empeche tout test de se
   * terminer et laisse un balayage tourner apres un arret propre du serveur. */
  const timer = setInterval(() => { backgroundScan(options); }, intervalMs);
  if (timer.unref) timer.unref();

  console.log('[biii-router] Background scanner started (interval: ' + (intervalMs / 60000) + ' min)');
  return timer;
}

module.exports = {
  shouldRoute,
  routeVerdict,
  STALE_AFTER_MS,
  SCAN_INTERVAL_MS,
  getActivePayeesList,
  backgroundScan,
  startBackgroundScan
};
