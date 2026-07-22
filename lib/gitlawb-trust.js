'use strict';
/**
 * gitlawb-trust — compose BIII safe-to-pay with gitlawb's native per-DID reputation, fail-closed.
 * ================================================================================================
 * gitlawb gives every agent DID a `trust_score` (0..1) via `gl node trust <did>` (a fresh agent is ~0.05).
 * BIII gives a safe-to-pay verdict on the payout ADDRESS (known-bad floor + trust-core). They answer
 * different questions:
 *   - BIII: "is this payout address dangerous?"          → a DECISIVE block (denylist / sanctioned).
 *   - gitlawb: "does this agent have network standing?"  → a POSITIVE, earn-over-time reputation signal.
 * Neither alone is "safe to pay an agent for a bounty". This composes them the only defensible way:
 *   1. a BIII block is ABSOLUTE — reputation can never buy back a denylisted address (absence of proof
 *      is not proof; a high score does not sanitise a sanctioned wallet).
 *   2. once BIII is clear, gitlawb reputation gates the AMOUNT: a new/low-standing agent is fine for small
 *      payouts, must have earned standing for large ones. Unknown reputation → small payouts only.
 * Pure + deterministic. No network, no keys. Returns a release decision the escrow holder acts on.
 */

/** Reputation required to release a given payout size — large money demands earned network standing. */
function requiredTrust(amountUsd) {
  const amt = Number(amountUsd) || 0;
  if (amt >= 1000) return 0.5;   // big payout: a proven agent only
  if (amt >= 100) return 0.2;    // mid payout: some standing
  return 0;                      // small payout: BIII-clear is enough (reputation is earned somewhere)
}

/**
 * combineAgentTrust — the release decision for paying a gitlawb agent DID.
 * @param {object} o
 * @param {boolean} o.biiiAllowed  the BIII safe-to-pay verdict on the payout address (allowed=false → block)
 * @param {string} [o.biiiDecision] the BIII decision label (for the reason string)
 * @param {number|null} [o.gitlawbTrust] `gl node trust <did>` score 0..1, or null/undefined if unavailable
 * @param {string|number} o.amountUsd  the payout size
 * @returns {{release:boolean, tier:string, reason:string, gitlawbTrust:(number|null), needed:number}}
 */
function combineAgentTrust({ biiiAllowed, biiiDecision, gitlawbTrust, amountUsd }) {
  const needed = requiredTrust(amountUsd);
  const amt = Number(amountUsd) || 0;
  const gt = typeof gitlawbTrust === 'number' && isFinite(gitlawbTrust) && gitlawbTrust >= 0 ? gitlawbTrust : null;

  // 1. BIII block is DECISIVE — a denylisted / unsafe payout address is never released, at any reputation.
  if (!biiiAllowed) {
    return { release: false, tier: 'blocked', gitlawbTrust: gt, needed,
      reason: 'BIII: ' + (biiiDecision || 'not safe') + ' — a gitlawb reputation score cannot override a denylisted payout address' };
  }
  // 2. Reputation unavailable → only small payouts proceed (fail-closed on the missing signal).
  if (gt === null) {
    return { release: amt < 100, tier: amt < 100 ? 'low-value-ok' : 'caution', gitlawbTrust: null, needed,
      reason: amt < 100 ? 'BIII clear; no gitlawb trust signal — small payout proceeds' : 'BIII clear but gitlawb trust is unavailable — hold a $' + amt + ' payout until reputation is known' };
  }
  // 3. BIII clear + reputation meets the amount-scaled bar.
  if (gt >= needed) {
    return { release: true, tier: gt >= 0.5 ? 'reputable' : 'ok', gitlawbTrust: gt, needed,
      reason: 'BIII clear + gitlawb trust ' + gt + ' ≥ ' + needed + ' required for $' + amt };
  }
  // 4. BIII clear but under-reputed for this amount → caution (new/low-standing agent, large payout).
  return { release: false, tier: 'caution', gitlawbTrust: gt, needed,
    reason: 'BIII clear but gitlawb trust ' + gt + ' < ' + needed + ' required for $' + amt + ' — new/low-standing agent for a large payout; split it or build standing first' };
}

module.exports = { combineAgentTrust, requiredTrust };
