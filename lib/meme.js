'use strict';
/**
 * meme.js — "which contract is the REAL memecoin, and is it safe to ape?" — BIII genuineness for memes.
 * =====================================================================================================
 * A meme symbol has many look-alike contracts across chains (BRETT = 10, TOSHI = 8, proven live). Aping the
 * wrong one = total loss. This returns a FAIL-CLOSED verdict from live market data (DexScreener, free), the
 * same discipline as our RWA `assessAsset`: never falsely certify "this is the real one" — ABSTAIN when the
 * top candidates are tied, and flag look-alikes. Advisory + re-verifiable (DexScreener/basescan links).
 *
 * Layer 2: holders health (on-chain distribution) to detect rugs/pump schemes.
 *
 * Pure + dependency-free: the HTTP fetch is injectable (fetchImpl) so it unit-tests offline.
 */
const https = require('node:https');
const { checkHoldersHealth } = require('./holders-health');

const LIQ_FLOOR = 10000;          // below this = not a credible contract
const DOMINANCE = 3;              // canonical must hold >= 3x the runner-up's liquidity

function getJSON(url, fetchImpl) {
  if (fetchImpl) return fetchImpl(url);
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
      if (res.statusCode !== 200) return reject(new Error('dexscreener http ' + res.statusCode));
      try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

/**
 * Les identifiants de chaine cotes DexScreener sont des SLUGS ('base', 'solana', 'ethereum'), jamais des
 * nombres. Un appelant, lui, ecrit naturellement 8453. On accepte donc les deux et on ramene tout au slug.
 *
 * ⚠️ `null` = « je ne sais pas ce que cette chaine designe », et ce n'est PAS « pas de filtre ».
 * Confondre les deux est exactement la faute mesuree ci-dessous.
 */
const SLUG_PAR_ID = {
  1: 'ethereum', 8453: 'base', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 56: 'bsc', 43114: 'avalanche',
};
function slugDeChaine(v) {
  if (v == null || v === '') return undefined;                       // aucun filtre demande
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return SLUG_PAR_ID[Number(v)] || null;
  return String(v).toLowerCase();
}

/**
 * Collapse DexScreener pairs to one row per token contract (best pair's liquidity wins).
 *
 * ═══ CORRIGE LE 2026-07-27: LE FILTRE DE CHAINE NE FILTRAIT RIEN, OU FILTRAIT TOUT ═══
 * bin/biii-mcp.js passait `Number(a.chainId)`. Or DexScreener rend des slugs:
 *
 *   chainId: 'base'  ->  Number('base') = NaN  ->  `if (chainId && ...)` est FAUX  ->  AUCUN filtre
 *   chainId: 8453    ->  'base' !== 8453       ->  TOUT est ecarte
 *
 * Mesure sur le service en production, symbole DEGEN:
 *   sans chainId       status=genuine   canonical.chain=solana   11 candidats
 *   chainId:'base'     status=genuine   canonical.chain=solana   11 candidats   <- le filtre est mort
 *   chainId:8453       status=thin      canonical=null            0 candidat    <- tout efface
 *
 * Un appelant demandant Base se voyait certifier un contrat SOLANA comme « genuine ». L'autre forme
 * rendait « thin », qui se lit « ce token existe a peine ici » alors que le filtre avait tout supprime.
 * Les deux sens faux, aucune erreur levee. C'est aussi pourquoi la couche 2 (holders-health) ne
 * s'executait jamais: elle est gardee par `canonical.chain === 'base'`.
 */
function candidatesFrom(pairs, symbol, chainId) {
  const S = String(symbol || '').toUpperCase();
  const slug = slugDeChaine(chainId);
  /* FAIL-CLOSED: une chaine demandee mais non reconnue ne doit pas se degrader en « toutes les chaines ».
   * Rendre l'ensemble vide fait remonter un verdict `thin`/`ambiguous`, jamais un `genuine` sur une chaine
   * que l'appelant n'a pas demandee. */
  if (slug === null) return [];
  const byTok = {};
  for (const p of (pairs || [])) {
    if (!p.baseToken || String(p.baseToken.symbol || '').toUpperCase() !== S) continue;
    if (slug && String(p.chainId || '').toLowerCase() !== slug) continue;
    const k = p.chainId + ':' + p.baseToken.address;
    /* ⚠️ « LIQUIDITE NON RAPPORTEE » DEVENAIT « ZERO DOLLAR ».
     * `(p.liquidity && p.liquidity.usd) || 0` ecrasait un champ ABSENT sur la valeur la plus
     * incriminante possible. Le contrat tombait alors sous LIQ_FLOOR, sortait de `credible`, et si
     * c'etait le VRAI contrat dominant qui disparaissait, l'usurpateur devenait `top`: un appelant
     * verifiant l'usurpateur recevait `genuine`. Le detecteur d'usurpation certifiait l'usurpateur.
     *
     * Sonde de l'API REELLE le 2026-07-28, sur les six symboles que ce module surveille: DexScreener
     * omet le champ `liquidity` sur certaines paires (3 sur 30 pour DEGEN, 1 sur 30 pour BRETT). Apres
     * deduplication par le MAXIMUM, 6 tokens sur 91 n'avaient AUCUNE paire rapportant sa liquidite —
     * 6,6 %, lus « 0 $ ». Ce n'est pas une hypothese de schema, c'est ce que l'API rend.
     *
     * `null` = pas mesure. `0` = mesure, et il n'y a rien. */
    const liq = p.liquidity && typeof p.liquidity.usd === 'number' ? p.liquidity.usd : null;
    /* Une valeur MESUREE l'emporte toujours sur une non mesuree, quel que soit son montant: entre
     * « 0 $ constate » et « on ne sait pas », c'est le constat qui informe. */
    const mieux = !byTok[k]
      || (liq != null && byTok[k].liquidityUsd == null)
      || (liq != null && byTok[k].liquidityUsd != null && byTok[k].liquidityUsd < liq);
    if (mieux) byTok[k] = {
      chain: p.chainId, address: p.baseToken.address, name: p.baseToken.name || '',
      liquidityUsd: liq, volume24: (p.volume && p.volume.h24) || 0, pairCreatedAt: p.pairCreatedAt || 0,
      dexscreener: p.url || ('https://dexscreener.com/' + p.chainId + '/' + p.baseToken.address),
    };
  }
  /* Les non mesures vont en FIN de tri: ils ne peuvent pretendre a la premiere place, qui decide du
   * contrat canonique. On ne certifie pas ce qu'on n'a pas pu mesurer — dans les deux sens. */
  return Object.values(byTok).sort((a, b) => {
    if (a.liquidityUsd == null && b.liquidityUsd == null) return 0;
    if (a.liquidityUsd == null) return 1;
    if (b.liquidityUsd == null) return -1;
    return b.liquidityUsd - a.liquidityUsd;
  });
}

/**
 * vetMeme — fail-closed verdict for a meme symbol (+ optional chain + a specific address to judge).
 * @param {object} opts - { symbol, chainId, address, fetchImpl, holderHealthImpl }
 * @returns { status, reason, canonical, candidates, disclosure, health, ...mesure }
 *   status: 'genuine' | 'impersonation' | 'ambiguous' | 'thin' | 'unknown'
 *   health: holders health metrics for the canonical candidate (if available)
 */
async function vetMeme({ symbol, chainId, address, fetchImpl, holderHealthImpl } = {}) {
  if (!symbol) return { status: 'unknown', reason: 'a symbol is required' };
  let pairs;
  try { pairs = (await getJSON('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(symbol), fetchImpl)).pairs; }
  catch (e) { return { status: 'unknown', reason: 'market data unavailable', candidates: [] }; }

  const cands = candidatesFrom(pairs, symbol, chainId);
  /* Explicite plutot qu'implicite: `null >= LIQ_FLOOR` est deja faux, mais s'appuyer sur la coercition
   * pour un fail-closed, c'est un garde qui tient par accident. Et on COMPTE les non mesures, parce
   * qu'un « un contrat domine » calcule en ignorant N concurrents illisibles n'est pas la meme
   * affirmation selon que N vaut 0 ou 4. */
  const credible = cands.filter((c) => typeof c.liquidityUsd === 'number' && c.liquidityUsd >= LIQ_FLOOR);
  const unmeasured = cands.filter((c) => c.liquidityUsd == null).length;
  const mesure = { unmeasured, unmeasuredNote: unmeasured
    ? unmeasured + ' contract(s) carrying this symbol report NO liquidity figure at all. They are NOT '
      + 'counted as $0 and NOT certified — they are simply unread, so any dominance claim below is made '
      + 'among the contracts that could be measured.'
    : null };
  const disclosure = 'ADVISORY, fail-closed: "genuine" = one contract dominates liquidity (>=' + DOMINANCE + 'x the runner-up); tied leaders are AMBIGUOUS (never certified); look-alikes/thin never read as safe. Re-verify each on DexScreener/Basescan — a verdict is a pointer to the chain, not a badge.';

  /* `canonical: null` EXPLICITE, comme dans les autres chemins. Il manquait ici, donc la reponse `thin`
   * n'avait tout simplement pas la cle: un appelant ecrivant `r.canonical === null` lisait faux, alors
   * que le meme test sur un verdict `ambiguous` lisait vrai. Une forme de reponse qui change selon le
   * verdict oblige a deviner, et « la cle est absente » ne dit pas « il n'y a pas de contrat canonique ». */
  if (!credible.length) return { status: 'thin', reason: 'no contract with credible liquidity for "' + symbol + '"' + (chainId ? ' on ' + chainId : ''), canonical: null, candidates: cands.slice(0, 12), disclosure, ...mesure };

  const top = credible[0], second = credible[1];
  const clearWinner = !second || top.liquidityUsd >= DOMINANCE * second.liquidityUsd;
  const canonical = clearWinner ? { chain: top.chain, address: top.address, liquidityUsd: top.liquidityUsd, dexscreener: top.dexscreener } : null;

  // Layer 2: holders health check (only for Base chain candidates with clear winner)
  let health = null;
  if (canonical && canonical.chain === 'base' && (holderHealthImpl || checkHoldersHealth)) {
    try {
      const healthCheck = holderHealthImpl || checkHoldersHealth;
      health = await healthCheck(canonical.address, { fetchImpl });
    } catch (e) {
      health = { healthy: false, score: 100, error: 'health check failed: ' + e.message };
    }
  }

  // Judging a SPECIFIC address the caller is about to ape:
  if (address) {
    const a = String(address).toLowerCase();
    const isTop = top.address.toLowerCase() === a;
    if (!clearWinner) return { status: 'ambiguous', reason: 'the top contracts are within ' + DOMINANCE + 'x liquidity of each other — cannot certify a single real one', canonical: null, candidates: credible.slice(0, 12), disclosure, health, ...mesure };
    if (isTop) return { status: 'genuine', reason: 'this IS the dominant-liquidity contract for "' + symbol + '"', canonical, candidates: credible.slice(0, 12), disclosure, health, ...mesure };
    const asCand = cands.find((c) => c.address.toLowerCase() === a);
    return { status: 'impersonation', reason: 'this is NOT the dominant contract — the real one holds far more liquidity', canonical, thisContract: asCand || { address, note: 'not found in credible set' }, candidates: credible.slice(0, 12), disclosure, health, ...mesure };
  }

  // No specific address: report which is canonical, or abstain.
  if (!clearWinner) return { status: 'ambiguous', reason: credible.length + ' contracts, top two within ' + DOMINANCE + 'x liquidity — no single real one can be certified', canonical: null, candidates: credible.slice(0, 12), disclosure, health, ...mesure };
  return { status: 'genuine', reason: 'one contract dominates for "' + symbol + '"', canonical, candidates: credible.slice(0, 12), disclosure, health, ...mesure };
}

module.exports = { vetMeme, candidatesFrom };
