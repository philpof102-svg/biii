'use strict';
/**
 * x402-settle — single-use + freshness guard for the paid /x402 verdicts.
 * =======================================================================
 * A confirmed USDC-on-Base payment TO the merchant, ≥ the price, redeems EXACTLY ONE verdict.
 * Without this, the paywall is trivially defeated: one $0.002 txHash replays into unlimited
 * verdicts, and ANY old qualifying payment to the merchant can be dredged up and reused. That
 * is zero revenue. `lib/chain.js` already binds one transfer to at most one charge; this applies
 * the same discipline to the x402 path.
 *
 * Non-custodial + bounded: we hold no key. Consumed txHashes are remembered only within the
 * freshness window (older ones are rejected by freshness anyway), so the store self-prunes.
 * Persistence is best-effort (survives a restart within the window); on an ephemeral host the
 * freshness window still caps the replay surface to a few minutes. For a stronger guarantee use a
 * persistent volume (BIII_X402_CONSUMED) or an on-chain nonce — see DEPLOY notes.
 */
const fs = require('node:fs'), path = require('node:path');

const STORE = process.env.BIII_X402_CONSUMED || path.join(__dirname, '..', 'data', 'x402-consumed.json');
const DEFAULT_MAX_AGE_BLOCKS = Number(process.env.BIII_X402_MAX_AGE_BLOCKS || 900); // ~30 min on Base (~2s blocks)

const consumed = new Map();   // txHash(lower) -> blockNumber it was consumed at
let loaded = false;
function load() {
  if (loaded) return; loaded = true;
  try { for (const [h, bn] of JSON.parse(fs.readFileSync(STORE, 'utf8'))) consumed.set(String(h).toLowerCase(), Number(bn)); }
  catch { /* no prior store — fresh */ }
}
function persist() {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify([...consumed])); }
  catch { /* best-effort; freshness still caps replay if this fails */ }
}
function prune(headBlock, maxAge) {
  if (!headBlock) return;
  for (const [h, bn] of consumed) if (headBlock - bn > maxAge) consumed.delete(h);
}

/**
 * settleOnce — validate a verifyTxHash proof against the price/merchant AND consume it single-use.
 * @returns {{ok:true}} or {{ok:false, code:number, reason:string}} (code 402 = pay/again, 409 = already redeemed)
 */
function settleOnce({ proof, merchant, needMicro, maxAgeBlocks = DEFAULT_MAX_AGE_BLOCKS } = {}) {
  load();
  if (!proof || !proof.paid) return { ok: false, code: 402, reason: 'no confirmed USDC payment on Base' };
  if (String(proof.to || '').toLowerCase() !== String(merchant || '').toLowerCase())
    return { ok: false, code: 402, reason: 'payment was not sent TO the merchant (payTo)' };
  let paidMicro, priceNeed;
  try { paidMicro = BigInt(String(proof.valueMicro || '0')); priceNeed = BigInt(String(needMicro || '0')); }
  catch { return { ok: false, code: 402, reason: 'unreadable payment amount' }; }   // fail-closed, never throw a 500
  if (paidMicro < priceNeed)
    return { ok: false, code: 402, reason: 'underpaid: payment value < the price' };
  const age = Number(proof.confirmations || 0);           // ≈ blocks since the payment landed
  if (maxAgeBlocks && age > maxAgeBlocks)
    return { ok: false, code: 402, reason: 'payment too old — pay fresh for this call (anti-reuse of an old transfer)' };
  const h = String(proof.txHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) return { ok: false, code: 402, reason: 'missing/invalid txHash in proof' };
  if (consumed.has(h)) return { ok: false, code: 409, reason: 'payment already redeemed — one payment = one verdict' };
  const headNow = Number(proof.blockNumber || 0) + age;   // reconstruct chain head to self-prune stale entries
  prune(headNow, maxAgeBlocks);
  consumed.set(h, Number(proof.blockNumber || 0));
  persist();
  return { ok: true };
}

// test hook: clear in-memory + reload state
function _reset() { consumed.clear(); loaded = false; }

module.exports = { settleOnce, DEFAULT_MAX_AGE_BLOCKS, _consumed: consumed, _reset };
