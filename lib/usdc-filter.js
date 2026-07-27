'use strict';
/**
 * usdc-filter.js — USDC transfer log filter for BIII safe-to-pay routing
 * ====================================================================
 * Streams Base RPC eth_getLogs for USDC transfers and tracks daily settlement
 * volumes per address. Routes BIII calls ONLY to addresses with >$1k daily
 * settlement (strategist idea #1 from IDEAS-agent.md).
 *
 * Pure + dependency-free: injectable fetch for testing.
 */

const { USDC_BASE } = require('./till');
const { findPayment } = require('./chain');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DAILY_VOLUME_THRESHOLD = 1000; // $1k USDC
const DEFAULT_RPC = 'https://mainnet.base.org';
const LOOKBACK_BLOCKS = 900; // ~3 hours on Base (12s block time)

// In-memory store for daily volumes (resets on restart)
const dailyVolumes = new Map(); // address -> { volume, lastUpdate, blocks }

/**
 * Fetch USDC transfers for a given block range and update daily volumes
 */
async function scanTransfers({ fromBlock, toBlock, rpcUrl = DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const rpc = async (method, params) => {
    const r = await f(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  };

  const logs = await rpc('eth_getLogs', [{
    address: USDC_BASE,
    fromBlock: typeof fromBlock === 'bigint' ? '0x' + fromBlock.toString(16) : fromBlock,
    toBlock: typeof toBlock === 'bigint' ? '0x' + toBlock.toString(16) : toBlock,
    topics: [TRANSFER_TOPIC]
  }]);

  const now = Date.now();
  for (const log of logs || []) {
    try {
      if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
      if (String(log.address || '').toLowerCase() !== USDC_BASE) continue;

      const to = '0x' + String(log.topics[2]).slice(26);
      const valueMicro = BigInt(log.data);
      const valueUsd = Number(valueMicro) / 1e6; // USDC has 6 decimals

      // Update daily volume for this address
      if (!dailyVolumes.has(to)) {
        dailyVolumes.set(to, { volume: 0, lastUpdate: now, blocks: new Set() });
      }
      const entry = dailyVolumes.get(to);
      entry.volume += valueUsd;
      entry.lastUpdate = now;
      entry.blocks.add(log.blockNumber);
    } catch { /* skip malformed logs */ }
  }

  return logs?.length || 0;
}

/**
 * Check if an address has >$1k daily settlement.
 *
 * ⚠️ DEUX ETATS SEULEMENT — ne pas s'en servir pour decider d'un paiement. Ce `false` recouvre
 * « volume MESURE sous le seuil » et « aucun balayage n'a encore tourne », qui sont un fait sur le
 * beneficiaire et une lacune de notre cote. C'est exactement la confusion corrigee le 2026-07-27 dans
 * lib/biii-router.js: utiliser `routeVerdict()`, qui rend `basis: 'measured' | 'unscanned'` avec sa
 * raison, et qui tient compte en plus de la peremption et du vidage de minuit.
 *
 * Au 2026-07-27 cette fonction n'a plus AUCUN appelant de production (le dernier, biii-router, est passe
 * a getActivePayees); elle reste exportee et testee. Ce commentaire est la pour que le prochain qui la
 * trouve ne refasse pas le chemin.
 */
function isActivePayee(address) {
  const entry = dailyVolumes.get(String(address).toLowerCase());
  if (!entry) return false;

  // Reset daily volume if last update was >24h ago
  const now = Date.now();
  if (now - entry.lastUpdate > 24 * 60 * 60 * 1000) {
    dailyVolumes.delete(String(address).toLowerCase());
    return false;
  }

  return entry.volume >= DAILY_VOLUME_THRESHOLD;
}

/**
 * Get active payees (addresses with >$1k daily volume)
 */
function getActivePayees() {
  const now = Date.now();
  const active = [];
  for (const [address, entry] of dailyVolumes) {
    if (now - entry.lastUpdate > 24 * 60 * 60 * 1000) {
      dailyVolumes.delete(address);
      continue;
    }
    if (entry.volume >= DAILY_VOLUME_THRESHOLD) {
      active.push({ address, volume: entry.volume, blocks: entry.blocks.size });
    }
  }
  return active;
}

/* COMBIEN DE FOIS la table a ete videe. Sans ce compteur, un consommateur ne peut pas distinguer « j'ai
 * balaye et cette adresse n'a rien regle » de « la table vient d'etre remise a zero et personne n'a
 * encore rebalaye ». C'est la meme confusion que partout ailleurs ici, un etage plus bas: lib/biii-router
 * annoncait `basis: 'measured', volumeUsd: 0` — une observation sur le beneficiaire — juste apres un
 * reset de minuit, pour toute adresse de Base.
 *
 * ⚠️ UN COMPTEUR, PAS UNE DATE. Le premier jet comparait deux `Date.now()`. Les deux ont une resolution
 * d'une milliseconde, et un vidage suivi d'un balayage y tombent dans le MEME tick: `>` cassait alors le
 * cas minuit et `>=` cassait le cas normal — une horloge ne sait pas ordonner deux evenements qui
 * partagent un tick. Un entier monotone les ordonne exactement, quelle que soit la resolution. */
let generation = 0;

/**
 * Reset daily volumes (call at midnight UTC)
 */
function resetDailyVolumes() {
  dailyVolumes.clear();
  generation++;
}

/** Numero de generation de la table. Un consommateur retient celui sous lequel il a balaye. */
function volumesGeneration() { return generation; }

module.exports = {
  scanTransfers,
  isActivePayee,
  getActivePayees,
  resetDailyVolumes,
  volumesGeneration,
  dailyVolumes // exported for testing
};
