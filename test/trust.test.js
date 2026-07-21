'use strict';
// BIII trust triangle — pure composition. Run: node test/trust.test.js
const assert = require('node:assert');
const { assessTriangle } = require('../lib/trust');

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
  assert.equal(r.vertices.standing.status, 'none');
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

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
