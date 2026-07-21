'use strict';
/**
 * BIII trust triangle — the sellable core: three independent vertices → one payment verdict.
 * ==========================================================================================
 * The white-label pitch, as code. A partner brings merchants; BIII decides whether a payment
 * is TRUSTED by composing three signals that already exist in the stack — none of which any
 * single party can fake:
 *
 *   REPUTATION  (MainStreet) — is the counterparty safe to pay?      → before money moves
 *   STANDING    (LAWBOR)     — proven paid history, agent↔agent?      → the agent economy
 *   SETTLEMENT  (BIII/chain) — is THIS payment real on-chain?         → the receipt
 *
 * Pure & fail-closed: every vertex is INJECTED (already-fetched data), so this is deterministic,
 * testable, and a partner can wire their OWN oracle for any vertex. Unknown is never "safe".
 * The MCP/server fetches the vertices (MainStreet HTTP, LAWBOR, the chain) and calls this.
 */

const T = require('./till');

/** REPUTATION vertex: MainStreet "safe to pay". rep = { decision, score } | null. */
function repVertex(rep, minScore = 40) {
  if (!rep || (rep.decision == null && rep.score == null)) return { status: 'unknown', reason: 'no reputation data' };
  const d = String(rep.decision || '').toUpperCase();
  if (d === 'REFUSE' || d === 'AVOID' || d === 'BLOCK') return { status: 'unsafe', reason: 'oracle flags this counterparty', score: rep.score ?? null };
  const s = Number(rep.score);
  if (Number.isFinite(s) && s < minScore) return { status: 'weak', reason: `score ${s} < floor ${minScore}`, score: s };
  return { status: 'safe', reason: d ? `oracle: ${d}` : `score ${s}`, score: Number.isFinite(s) ? s : null };
}

/** STANDING vertex: LAWBOR proven paid history WITH this counterparty. st = { paidMicro } | null. */
function standingVertex(st) {
  const micro = st && (st.paidMicro ?? st.micro);
  if (micro == null || BigInt(String(micro || '0')) <= 0n) return { status: 'none', reason: 'no proven history yet' };
  return { status: 'proven', reason: 'proven paid history', paidUsd: T.microToUsd(String(micro)) };
}

/** SETTLEMENT vertex: the BIII on-chain verification of THIS payment. verdict = till.verifyPayment() | null. */
function settlementVertex(verdict) {
  if (!verdict) return { status: 'pending', reason: 'no payment observed yet' };
  if (verdict.paid === true) return { status: 'settled', reason: `paid on-chain (${verdict.tier})`, txHash: verdict.txHash || null };
  return { status: 'failed', reason: verdict.reason || 'not paid' };
}

/**
 * assessTriangle — compose the three vertices into ONE payment verdict.
 * Inputs are already-fetched vertex data (all optional):
 *   { reputation:{decision,score}|null, standing:{paidMicro}|null, settlement:verifyResult|null }
 * Returns { trust, level, vertices, reasons, greens } where trust ∈
 *   'unsafe'   — the counterparty is flagged: DO NOT PAY (any other green is overridden)
 *   'settled'  — the payment is proven real on-chain (the strongest post-pay state)
 *   'trusted'  — vetted to pay (reputation safe OR proven standing), settlement not yet in
 *   'unknown'  — no positive signal: proceed with caution
 */
function assessTriangle({ reputation, standing, settlement } = {}, opts = {}) {
  const v = {
    reputation: repVertex(reputation, opts.minScore),
    standing: standingVertex(standing),
    settlement: settlementVertex(settlement),
  };
  const greens = ['reputation', 'standing', 'settlement'].filter((k) =>
    ['safe', 'proven', 'settled'].includes(v[k].status)).length;

  let trust;
  if (v.reputation.status === 'unsafe') trust = 'unsafe';           // a flag overrides everything
  else if (v.settlement.status === 'settled') trust = 'settled';    // money is proven — the top state
  else if (v.reputation.status === 'safe' || v.standing.status === 'proven') trust = 'trusted';
  else trust = 'unknown';

  const level = { unsafe: 0, unknown: 1, trusted: 2, settled: 3 }[trust];
  return {
    trust, level, greens, vertices: v,
    reasons: Object.entries(v).map(([k, x]) => `${k}: ${x.status} (${x.reason})`),
    payable: trust === 'trusted' || trust === 'settled',           // safe to hand money to
    proven: trust === 'settled',                                   // money already changed hands, verified
  };
}

module.exports = { assessTriangle, repVertex, standingVertex, settlementVertex };
