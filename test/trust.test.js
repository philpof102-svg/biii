'use strict';
// BIII trust triangle — pure composition. Run: node test/trust.test.js
const assert = require('node:assert');
const { assessTriangle, standingVertex } = require('../lib/trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };

console.log('BIII trust triangle — three vertices, one fail-closed verdict:');

t('a flag on the counterparty overrides EVERYTHING — never pay', () => {
  const r = assessTriangle({ reputation: { decision: 'REFUSE' }, standing: { paidMicro: '9999999' }, settlement: PAID });
  assert.equal(r.trust, 'unsafe');
  assert.equal(r.payable, false);
});

t('settled = the top state: a verified on-chain payment is proven, whatever else', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 70 }, settlement: PAID });
  assert.equal(r.trust, 'settled'); assert.equal(r.proven, true); assert.equal(r.payable, true);
  assert.equal(r.vertices.settlement.txHash, PAID.txHash);
});

t('trusted (safe to pay) when reputation is safe OR standing is proven, before settlement', () => {
  assert.equal(assessTriangle({ reputation: { decision: 'PROCEED', score: 55 } }).trust, 'trusted');
  assert.equal(assessTriangle({ standing: { paidMicro: '5000000' } }).trust, 'trusted');
  assert.equal(assessTriangle({ standing: { paidMicro: '5000000' } }).vertices.standing.paidUsd, '5.00');
});

t('unknown when there is no positive signal (fail-closed: absence is never trust)', () => {
  const r = assessTriangle({});
  assert.equal(r.trust, 'unknown'); assert.equal(r.payable, false);
  assert.equal(r.vertices.reputation.status, 'unknown');
  /* CHANGED 2026-07-27: this line used to assert 'none', and in doing so it LOCKED IN the defect —
   * it required a never-consulted vertex to report the same verdict as a consulted-and-empty one.
   * A test can protect a bug as firmly as it protects a property. The vertex is now 'unqueried'
   * because assessTriangle({}) passes no standing at all: nobody was asked. */
  assert.equal(r.vertices.standing.status, 'unqueried');
  assert.equal(r.vertices.settlement.status, 'pending');
});

t('a weak score is not safe and not unsafe — it does not by itself make a payment trusted', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 12 } });   // below floor 40
  assert.equal(r.vertices.reputation.status, 'weak');
  assert.equal(r.trust, 'unknown', 'a weak score alone is not enough to trust');
});

t('greens count + a failed settlement never reads as paid', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 90 }, standing: { paidMicro: '3000000' }, settlement: { paid: false, reason: 'underpaid' } });
  assert.equal(r.trust, 'trusted');          // vetted, but the payment itself failed
  assert.equal(r.proven, false);
  assert.equal(r.greens, 2);                 // reputation + standing green, settlement failed
  assert.equal(r.vertices.settlement.status, 'failed');
});

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * NOT ASKING IS NOT A FINDING — the three states of the standing vertex.
 *
 * Fixed 2026-07-27. `standingVertex` folded `null` (never consulted) and `paidMicro: 0` (consulted, no
 * history) into ONE verdict with ONE sentence: "no proven history yet". Those are opposite facts — the
 * first is a gap on OUR side, the second is information about the counterparty.
 *
 * Measured on the shipped binary before the fix, with BIII_LAWBOR_URL unset: `till_trust` returned
 * `standing: {status:'none', reason:'no proven history yet'}` while never having made a call. The word
 * LAWBOR appeared nowhere in the output and nothing flagged the missing vertex — a caller read a "trust
 * triangle" computed from two vertices without knowing it.
 *
 * This is the SAME repair already made in rugsignals (`ownerState`: live/renounced/unknown), where a
 * missing owner read as a renounced one and defused live flags. Same fault, one module over, still in
 * place because nobody had gone to look. These tests exist so it cannot come back a third time.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\nnot asking is not a finding: the standing vertex has THREE states');

t('null standing = UNQUERIED, and the reason blames OUR side, not the counterparty', () => {
  const v = standingVertex(null);
  assert.equal(v.status, 'unqueried', 'never consulted must not read as "none"');
  assert.match(v.reason, /not.*set|never asked/i, 'the reason must name the missing configuration');
  assert.match(v.reason, /NOT a statement about the counterparty/i,
    'it must state explicitly that this is NOT a claim about the counterparty');
});

t('an explicit unqueried marker carries ITS OWN reason through', () => {
  const v = standingVertex({ unqueried: true, reason: 'HTTP 503 from the node' });
  assert.equal(v.status, 'unqueried');
  assert.match(v.reason, /503/, 'a node failure must not be flattened into a generic message');
});

t('a CONSULTED zero is a real finding, and says so', () => {
  const v = standingVertex({ paidMicro: '0' });
  assert.equal(v.status, 'none', 'consulted-and-empty stays "none"');
  assert.match(v.reason, /consulted/i, 'the wording must distinguish it from "unqueried"');
});

t('unqueried and none never share a wording — the bug was that they did', () => {
  const un = standingVertex(null).reason;
  const none = standingVertex({ paidMicro: '0' }).reason;
  assert.notEqual(un, none, 'identical reasons is exactly the defect being fixed');
});

t('a real paid history still reads as proven', () => {
  const v = standingVertex({ paidMicro: '2500000' });
  assert.equal(v.status, 'proven');
  assert.ok(v.paidUsd, 'the amount must be surfaced for the reader');
});

console.log('\nan incomplete triangle must SAY it is incomplete');

t('an unqueried vertex flips `complete` and names itself', () => {
  const r = assessTriangle({ reputation: null, standing: null, settlement: null });
  assert.equal(r.complete, false, 'two-of-three is not a triangle');
  assert.deepStrictEqual(r.unqueriedVertices, ['standing']);
  assert.match(r.incompleteNote, /INCOMPLETE/);
  assert.match(r.incompleteNote, /not a negative one/i,
    'the note must say a missing vertex is not a negative one');
});

t('a fully read triangle carries NO warning — a permanent banner stops being read', () => {
  const r = assessTriangle({
    reputation: { decision: 'PROCEED', score: 80 },
    standing: { paidMicro: '0' },
    settlement: null,
  });
  assert.equal(r.complete, true, 'all three were consulted, even if two answered negatively');
  assert.deepStrictEqual(r.unqueriedVertices, []);
  assert.equal(r.incompleteNote, undefined, 'no note when there is nothing to warn about');
});

t('unqueried never counts as a green, and never lifts the verdict', () => {
  const r = assessTriangle({ reputation: null, standing: null, settlement: null });
  assert.equal(r.greens, 0, 'a vertex we did not read cannot be a positive signal');
  assert.equal(r.trust, 'unknown');
  assert.equal(r.payable, false, 'fail-closed: an unread vertex never makes something payable');
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
