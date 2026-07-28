'use strict';
/**
 * holders-health.js — MEME vet layer 2: on-chain holder distribution health
 * ========================================================================
 * Checks if a meme token has healthy holder distribution (not a rug/pump scheme).
 * Uses Base RPC eth_getLogs to analyze Transfer events and compute:
 *   - Top 10 holders concentration (% of supply)
 *   - Holder count (unique addresses that received tokens)
 *   - Rug risk score (0-100, lower = healthier)
 *
 * Pure + dependency-free: injectable fetch for testing.
 * Complements canonical verification (layer 1) and deployer trust (layer 3).
 */

const { USDC_BASE } = require('./till');

// Common meme token ABIs (minimal ERC-20)
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';
const DEFAULT_BLOCK_RANGE = 10000; // ~33k blocks ≈ 4.5 days on Base

/**
 * Fetch transfer events for a token contract
 */
async function fetchTransfers(tokenAddress, { fromBlock, toBlock, rpcUrl = DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const rpc = async (method, params) => {
    const r = await f(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  };

  const toAddr = (topic) => '0x' + String(topic).slice(26);

  const logs = await rpc('eth_getLogs', [{
    address: tokenAddress,
    fromBlock: typeof fromBlock === 'bigint' ? '0x' + fromBlock.toString(16) : fromBlock,
    toBlock: typeof toBlock === 'bigint' ? '0x' + toBlock.toString(16) : toBlock,
    topics: [ERC20_TRANSFER_TOPIC]
  }]);

  return (logs || []).map(log => ({
    from: toAddr(log.topics[1]),
    to: toAddr(log.topics[2]),
    value: BigInt(log.data),
    blockNumber: Number(log.blockNumber)
  }));
}

/**
 * Compute holder health metrics from transfer events
 */
function computeHealthMetrics(transfers) {
  const balances = new Map(); // address -> balance (BigInt)
  const holders = new Set(); // unique addresses that ever received

  // Track balances (simplified: just count transfers in/out)
  for (const tx of transfers) {
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();

    // Skip zero address (mint/burn)
    if (from !== '0x0000000000000000000000000000000000000000') {
      const bal = balances.get(from) || 0n;
      balances.set(from, bal - tx.value);
    }

    if (to !== '0x0000000000000000000000000000000000000000') {
      const bal = balances.get(to) || 0n;
      balances.set(to, bal + tx.value);
      holders.add(to);
    }
  }

  /* ═══ CORRIGE LE 2026-07-27: LA CONCENTRATION VALAIT 100 POUR TOUT LE MONDE ═══
   * L'ancien calcul definissait `totalSupply` comme la somme des DIX PREMIERS soldes, puis divisait
   * cette meme somme par elle-meme:
   *
   *     const sorted     = [...].slice(0, 10);
   *     const totalSupply = sorted.reduce(...);                       // somme du top 10
   *     const top10Concentration = Number(sorted.reduce(...) * 100n / totalSupply);   // = 100, toujours
   *
   * Mesure avant correction, sur quatre distributions: 1 baleine -> 100, 2 porteurs egaux -> 100,
   * 500 porteurs identiques -> 100, top-10 detenant 10 % -> 100. Un signal a variance nulle: il
   * n'observait rien, il affirmait. Et comme le rugScore ajoute 50 au-dessus de 80 et 30 au-dessus de
   * 60, il valait au minimum 80 partout, donc `healthy = rugScore < 50 && ...` etait TOUJOURS faux.
   *
   * Ce verdict n'est pas interne: lib/meme.js l'attache au resultat de till_vet_meme pour tout token
   * Base. On expediait donc `healthy:false, score:100, top10Concentration:100` sur des tokens
   * parfaitement distribues — un chiffre jamais mesure, et une affirmation negative sur des tiers.
   *
   * Le denominateur est desormais la somme de TOUS les soldes positifs observes. */
  const positifs = Array.from(balances.entries()).filter(([, bal]) => bal > 0n);
  const totalSupply = positifs.reduce((sum, [, bal]) => sum + bal, 0n);

  const sorted = positifs
    /* Comparer les BigInt entre eux et ne convertir QUE le signe: `Number(b - a)` sur des soldes a 18
     * decimales depasse Number.MAX_SAFE_INTEGER et rendrait un ordre approximatif. */
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, 10);

  const top10Sum = sorted.reduce((sum, [, bal]) => sum + bal, 0n);

  /* ⚠️ SOUS ONZE PORTEURS, « LE TOP 10 DETIENT 100 % » EST UNE TAUTOLOGIE, PAS UNE MESURE.
   * Quand il y a dix porteurs ou moins, le top 10 EST tout le monde: le ratio vaut 100 par construction,
   * y compris sur la distribution la plus egalitaire possible. Mesure du 2026-07-28, N porteurs a parts
   * strictement egales:
   *
   *    1 -> 100 %    5 -> 100 %    10 -> 100 %  | 11 -> 90 %    20 -> 50 %    101 -> 9 %
   *
   * Le chiffre n'observe rien avant 11, et il entrait tel quel dans le score (+50 au-dessus de 80, +30
   * au-dessus de 60). Un token a dix porteurs parfaitement repartis recevait donc exactement la note
   * d'un token tenu par une seule baleine — indiscernables.
   *
   * C'est le meme motif que le bug de denominateur corrige au-dessus, en plus discret: la variance nulle
   * n'etait plus globale, elle s'etait refugiee dans une SOUS-POPULATION. Et cette sous-population n'est
   * pas rare ici: les soldes sont reconstruits sur une fenetre de blocs bornee, donc tout token peu
   * echange sur la fenetre y tombe, quelle que soit sa vraie distribution.
   *
   * ⚠️ PREMIER JET TROP LARGE, ET C'EST UN TEST EXISTANT QUI L'A DIT. J'avais rendu `null` sous onze
   * porteurs et casse cinq cas. L'un d'eux tranchait deja la question en commentaire — « un porteur
   * unique EST le top 10 » — et il avait raison: a UN porteur, 100 % est vrai ET informatif (un
   * portefeuille possede tout). Seul le voisin trompe: dix porteurs a parts egales rendent 100 % aussi,
   * et la le chiffre ne dit plus rien d'une concentration. Supprimer les deux jetait le cas utile avec
   * l'inutile.
   *
   * Le chiffre reste donc TOUJOURS calcule, et le score ne bouge pas. Ce qu'on ajoute est sa PORTEE:
   * `concentrationDiscriminating` dit si le ratio separe encore quelque chose. La conclusion de risque
   * tient dans les deux cas — dix portefeuilles, c'est peu — mais elle doit se lire « trop peu de
   * porteurs », pas « concentre sur un seul »: un verdict prudent pour une raison fausse envoie
   * l'operateur chercher la mauvaise chose. */
  const CONCENTRATION_MIN_PORTEURS = 11;
  const concentrationDiscriminante = holders.size >= CONCENTRATION_MIN_PORTEURS;
  const top10Concentration = totalSupply > 0n ? Number(top10Sum * 100n / totalSupply) : 0;

  // Rug risk score (0-100): higher concentration = higher risk
  let rugScore = 0;
  if (top10Concentration > 80) rugScore += 50; // Very concentrated
  if (top10Concentration > 60) rugScore += 30;
  if (holders.size < 100) rugScore += 20; // Very few holders

  return {
    top10Concentration,
    /* La PORTEE du chiffre, pas le chiffre. Il reste toujours calcule — a un seul porteur, « le top 10
     * detient 100 % » est vrai ET informatif: un portefeuille possede tout. Ce qui est trompeur, c'est
     * le cas voisin: DIX porteurs a parts strictement egales rendent 100 % aussi, et la le chiffre ne
     * dit plus rien d'une concentration. La distinction est fine et j'ai d'abord tranche trop large en
     * annulant les deux — un test existant tranchait deja la question en commentaire (« un porteur
     * unique EST le top 10 »), et il avait raison. */
    concentrationDiscriminating: concentrationDiscriminante,
    concentrationNote: concentrationDiscriminante ? null
      : 'the top-10 ratio does not DISCRIMINATE here: only ' + holders.size + ' holder(s) were observed, so '
        + 'the top 10 is everyone and the figure reads 100% even on a perfectly even split. Measured on '
        + '2026-07-28, N holders with strictly equal shares: 1 -> 100%, 5 -> 100%, 10 -> 100%, 11 -> 90%, '
        + '20 -> 50%. The risk conclusion still holds — ten wallets IS few — but read it as "too few '
        + 'holders", not as "concentrated in one".',
    holderCount: holders.size,
    rugScore: Math.min(rugScore, 100),
    top10Holders: sorted.map(([addr, bal]) => ({
      address: addr,
      balance: bal.toString(),
      percent: totalSupply > 0n ? Number(bal * 100n / totalSupply) : 0
    })),
    /* CE QUE CES CHIFFRES NE SONT PAS. Ils sont reconstruits a partir des Transfer d'une FENETRE de
     * blocs, pas lus dans l'etat de la chaine. `holderCount` compte les adresses ayant RECU pendant la
     * fenetre — y compris celles qui ont tout renvoye depuis, et sans celles qui detenaient deja avant.
     * Les soldes sont donc des deltas sur la fenetre, pas des positions. Un token ancien et sain analyse
     * sur une fenetre courte parait concentre; c'est prudent dans le bon sens, mais ca reste une lecture
     * partielle et l'appelant doit pouvoir le savoir sans lire ce fichier. */
    disclosure: 'balances and holder count are RECONSTRUCTED from Transfer logs over a bounded block '
      + 'window, not read from chain state: they are deltas over that window, not positions. holderCount '
      + 'counts addresses that RECEIVED during the window, including any that have since sent everything '
      + 'away, and excludes holders who did not transact in it.',
  };
}

/**
 * Check if a token has healthy holder distribution
 * @param {string} tokenAddress - Token contract address
 * @param {object} options - RPC and block range options
 * @returns {Promise<object>} Health report { healthy, score, metrics, error }
 */
async function checkHoldersHealth(tokenAddress, options = {}) {
  try {
    const rpcUrl = options.rpcUrl || DEFAULT_RPC;
    const f = options.fetchImpl || fetch;

    // Get current block
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

    const fromBlock = '0x' + Math.max(0, head - DEFAULT_BLOCK_RANGE).toString(16);
    const toBlock = '0x' + head.toString(16);

    const transfers = await fetchTransfers(tokenAddress, { fromBlock, toBlock, rpcUrl, fetchImpl: f });
    const metrics = computeHealthMetrics(transfers);

    const healthy = metrics.rugScore < 50 && metrics.holderCount > 50;

    return {
      healthy,
      score: metrics.rugScore,
      metrics,
      error: null
    };
  } catch (err) {
    return {
      healthy: false,
      score: 100,
      metrics: null,
      error: err.message
    };
  }
}

module.exports = {
  checkHoldersHealth,
  fetchTransfers,
  computeHealthMetrics
};
