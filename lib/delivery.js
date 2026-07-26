'use strict';
/**
 * delivery.js — "I can prove I paid. Can I prove I was SERVED?"
 * =============================================================
 * Everything else here answers questions that come BEFORE money moves: is this address safe to pay, can this
 * agent's tools fire a payment alone, is this token a trap. This module is the question after.
 *
 * The asymmetry it exists for is total, and this codebase already wrote it down without building the fix. The
 * description of `till_settle` says, verbatim: **`settled` means PAID, never delivered.** A payment is a fact on
 * a public ledger, re-checkable by anyone forever. The deliverable is a sentence in a chat window. So an agent
 * can prove it spent and cannot prove it received — and every settlement record in existence, ours included,
 * records the money and takes the goods on trust.
 *
 * x402 settles the payment. ERC-8004 handles identity. Escrow handles the dispute, but only by asking a human
 * whether delivery happened. None of them make delivery CHECKABLE. That is the gap.
 *
 * ═══ THE MECHANISM, AND WHY IT IS NOT A SCORE ═══
 * The seller publishes hash(deliverable) BEFORE being paid. After payment the buyer hashes what it received and
 * compares. That is a commitment, not an opinion, and it settles exactly two things no prose can fake:
 *
 *   1. THE DELIVERABLE EXISTED BEFORE THE MONEY. You cannot commit to the hash of something you have not
 *      produced. It kills "pay me and I will get to it" — the oldest failure in commissioned work, ported to
 *      agents at machine speed.
 *   2. THE BYTES WERE NOT SWAPPED. What arrives is what was promised, not a cheaper substitute sent once the
 *      funds cleared.
 *
 * ═══ WHAT IT DOES NOT DO, STATED FIRST ═══
 * It says NOTHING about whether the work is good. A committed hash of garbage verifies perfectly. This is an
 * existence-and-substitution proof, not a quality proof, and pretending otherwise would be the same over-reach
 * as scoring how convincing a tool description reads. Quality is a judgement; this is arithmetic.
 *
 * ═══ THREE STATES, NEVER TWO ═══
 * The third matters most commercially, because it is where almost every agent transaction sits today: NO
 * COMMITMENT WAS MADE. A verifier that returns "not verified" for both a broken promise and an absent promise is
 * useless — the buyer needs to know whether it was cheated or whether it never had the means to check. So
 * `unverifiable` is a first-class answer, and it is the honest verdict for the entire current market.
 *
 * Pure, deterministic, offline. No network, no keys, no wallet. It compares bytes to a commitment.
 */
const crypto = require('node:crypto');

/** Canonical digest of a deliverable: sha256 over the exact bytes. No normalisation, no cleverness. */
function digest(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return '0x' + crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * A commitment the seller publishes BEFORE payment.
 *
 * `jobId` binds it to one engagement, so a seller cannot reuse a single commitment across buyers. `at` is the
 * seller's own timestamp and is NOT trusted here — the ORDERING is what a ledger proves, by having recorded the
 * commitment before the transaction that paid for it. This function builds and checks the object; establishing
 * that it came first is the chain's job, and assessDelivery refuses to make the strong claim without it.
 */
function commit({ jobId, deliverable, at = null, note = null }) {
  if (!jobId) throw new Error('a commitment must name the job it belongs to');
  if (deliverable === undefined || deliverable === null) throw new Error('nothing to commit to');
  return {
    jobId: String(jobId),
    deliverableHash: digest(deliverable),
    algorithm: 'sha256',
    committedAt: at,
    note: note ? String(note).slice(0, 200) : null,
  };
}

const VERDICTS = ['served', 'substituted', 'commitment_too_late', 'unverifiable'];

const QUALITY_LIMIT = 'A matching hash proves the deliverable existed before payment and was not swapped. It ' +
  'says NOTHING about whether the work is any good — a committed hash of garbage verifies perfectly.';

/**
 * assessDelivery — did the buyer get what was committed to, and can that even be established?
 *
 * @returns { verdict, matches, reason, limits[] }
 *   served              the bytes hash to the commitment, and the commitment provably came first.
 *   substituted         a commitment exists and the bytes DO NOT match it. This is the finding.
 *   commitment_too_late the bytes match, but the commitment was recorded at or after payment, so it proves
 *                       nothing about prior existence. Deliberately NOT `served`: a hash published after the
 *                       money moved can simply be the hash of whatever was eventually sent, which is the exact
 *                       trick this exists to catch.
 *   unverifiable        no commitment, or nothing received. The honest verdict for most of the market today.
 */
function assessDelivery({ commitment = null, received = undefined, receivedHash = undefined,
  paidAt = null, committedAt = null } = {}) {
  /* `receivedHash` exists so a caller can compare WITHOUT handing over the artifact — which is the better
   * habit and, on a hosted server, the only defensible one: nothing here has any business holding someone's
   * deliverable in order to check a digest.
   *
   * It is a first-class parameter rather than something a caller fakes. The first wiring of this did fake it,
   * passing an empty buffer for "matches" and a one-byte buffer for "does not", so the module hashed a decoy
   * and happened to land on the right verdict. That works by accident and breaks the day a real deliverable is
   * the single byte 0x01 — a correct-looking answer produced by the wrong computation, which is the failure
   * this whole module is written against. */
  if (!commitment || !commitment.deliverableHash) {
    return { verdict: 'unverifiable', matches: null,
      reason: 'No commitment was recorded before payment, so there is nothing to check the delivery against. ' +
        'That is not an accusation — it is the state almost every agent transaction is in today, and a buyer ' +
        'should know it had no means of verification rather than believe it passed one.',
      limits: [QUALITY_LIMIT] };
  }
  const gaveBytes = received !== undefined && received !== null;
  const gaveHash = typeof receivedHash === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(receivedHash);
  if (!gaveBytes && !gaveHash) {
    return { verdict: 'unverifiable', matches: null,
      reason: 'A commitment exists but nothing was received to compare against it. Absence of a delivery is a ' +
        'fact about the seller; absence of a comparison is a fact about this check, and this is the second.',
      limits: [QUALITY_LIMIT] };
  }

  // Bytes win when both are given: a digest the caller computed is a claim, and the bytes are the thing.
  const got = gaveBytes ? digest(received)
    : (String(receivedHash).startsWith('0x') ? String(receivedHash).toLowerCase() : '0x' + String(receivedHash).toLowerCase());
  const matches = got === String(commitment.deliverableHash).toLowerCase();

  if (!matches) {
    return { verdict: 'substituted', matches: false,
      reason: 'What arrived does not hash to what was committed. Either the deliverable was replaced after the ' +
        'commitment, or the commitment was never for this artifact. Both are the seller\'s to explain: the buyer ' +
        'holds bytes that provably are not the promised ones.',
      limits: [QUALITY_LIMIT] };
  }

  const ordered = paidAt != null && committedAt != null;
  if (ordered && Number(committedAt) >= Number(paidAt)) {
    return { verdict: 'commitment_too_late', matches: true,
      reason: 'The bytes match, but the commitment was recorded at or after the payment (' + committedAt +
        ' vs ' + paidAt + '). It therefore proves only that nobody edited it afterwards — not that the ' +
        'deliverable existed before the money moved, which is the half worth having.',
      limits: [QUALITY_LIMIT] };
  }

  if (!ordered) {
    return { verdict: 'served', matches: true,
      reason: 'The received bytes hash to the commitment, so nothing was substituted. Ordering was NOT supplied, ' +
        'so prior existence is unproven — pass paidAt and committedAt to get the stronger claim.',
      limits: [QUALITY_LIMIT,
        'No ordering evidence was given. Prior existence needs the block or timestamp at which each of the ' +
        'commitment and the payment was recorded somewhere the seller cannot rewrite.'] };
  }

  return { verdict: 'served', matches: true,
    reason: 'The received bytes hash to a commitment recorded at ' + committedAt + ', before the payment at ' +
      paidAt + '. The deliverable existed before the money moved and was not substituted after.',
    limits: [QUALITY_LIMIT] };
}

module.exports = { digest, commit, assessDelivery, VERDICTS };
