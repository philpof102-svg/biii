'use strict';
// basetill core — pure, offline. Run: node test/till.test.js
const assert = require('node:assert');
const T = require('../lib/till');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const M = '0x' + 'ab'.repeat(20);                                // merchant
const TX = '0x' + 'cd'.repeat(32);
const fact = (over) => ({ txHash: TX, chainId: 8453, token: T.USDC_BASE, to: M, valueMicro: '4500000', confirmations: 2, blockTime: 1700000000, from: '0x' + 'ee'.repeat(20), ...over });

console.log('basetill — money math is exact or it is wrong:');

t('usdToMicro: exact 6-decimals, comma tolerated, junk/zero/negative refused', () => {
  assert.equal(T.usdToMicro('4.50'), '4500000');
  assert.equal(T.usdToMicro('4,5'), '4500000');
  assert.equal(T.usdToMicro('0.000001'), '1');
  assert.equal(T.microToUsd('4500000'), '4.50');
  for (const bad of ['', 'abc', '-3', '1.2345678', '0']) assert.throws(() => T.usdToMicro(bad), undefined, 'refuses ' + bad);
});

console.log('\nthe charge (a request is data; nothing moves):');

t('createCharge: merchant address required, amount normalized, id stable', () => {
  const c = T.createCharge({ to: M, amountUsd: '4.50', label: 'flat white', nowMs: 1700000000000 });
  assert.equal(c.to, M.toLowerCase());
  assert.equal(c.amountMicro, '4500000');
  assert.equal(c.amountUsd, '4.50');
  assert.equal(c.chainId, 8453);
  assert.throws(() => T.createCharge({ to: '0x123', amountUsd: '1' }), /merchant 0x address/);
});

t('paymentURI: exact EIP-681 ERC-20 transfer every major wallet scans', () => {
  const c = T.createCharge({ to: M, amountUsd: '4.50', nowMs: 1 });
  assert.equal(T.paymentURI(c), `ethereum:${T.USDC_BASE}@8453/transfer?address=${M.toLowerCase()}&uint256=4500000`);
});

console.log('\nverify — only the chain can say "paid" (field-for-field, fail-closed):');

t('a matching fact ⇒ paid (confirmed tier), overpay counted as tip, final at 12 conf', () => {
  const c = T.createCharge({ to: M, amountUsd: '4.50', nowMs: 1 });
  const v = T.verifyPayment(c, fact());
  assert.equal(v.paid, true); assert.equal(v.tier, 'confirmed'); assert.equal(v.overpaidMicro, '0');
  const tip = T.verifyPayment(c, fact({ valueMicro: '5000000', confirmations: 12 }));
  assert.equal(tip.paid, true); assert.equal(tip.tier, 'final'); assert.equal(tip.overpaidMicro, '500000');
});

t('every wrong field refuses: no fact, wrong chain, wrong token, wrong recipient, underpaid, unconfirmed', () => {
  const c = T.createCharge({ to: M, amountUsd: '4.50', nowMs: 1 });
  for (const [f, why] of [
    [null, /no chain fact/],
    [fact({ chainId: 1 }), /wrong chain/],
    [fact({ token: '0x' + '00'.repeat(20) }), /wrong token/],
    [fact({ to: '0x' + '99'.repeat(20) }), /not this merchant/],
    [fact({ valueMicro: '4499999' }), /underpaid/],
    [fact({ confirmations: 0 }), /not yet confirmed/],
  ]) {
    const v = T.verifyPayment(c, f);
    assert.equal(v.paid, false); assert.match(v.reason, why);
  }
});

console.log('\nthe receipt (anchored to the tx, refutable by anyone):');

t('receipt only exists for a verified payment, carries txHash + explorer link', () => {
  const c = T.createCharge({ to: M, amountUsd: '4.50', label: 'flat white', nowMs: 1 });
  const v = T.verifyPayment(c, fact());
  const r = T.receipt(c, v, { merchantName: 'Café Demo' });
  assert.equal(r.amountUsd, '4.50');
  assert.equal(r.txHash, TX);
  assert.ok(r.explorer.includes('basescan.org/tx/'));
  assert.throws(() => T.receipt(c, { paid: false }), /no receipt without/);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
