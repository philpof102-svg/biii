'use strict';
// BIII qrpay — the P2P core: parse a scanned QR into a validated USDC-on-Base target, build a receive QR.
// Fail-closed: wrong chain / non-USDC / native-ETH / malformed are refused. Pure. Run: node test/qrpay.test.js
const assert = require('node:assert');
const { parsePaymentQR, receiveURI, USDC_BASE, CHAIN } = require('../lib/qrpay');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const ALICE = '0x' + 'a1'.repeat(20), BOB = '0x' + 'b0'.repeat(20);

console.log('BIII qrpay — scan → validated USDC-on-Base target (P2P), fail-closed:');

t('a bare 0x address → valid recipient, no amount (payer enters it)', () => {
  const r = parsePaymentQR(ALICE);
  assert.equal(r.valid, true); assert.equal(r.to, ALICE); assert.equal(r.amountMicro, null);
  assert.equal(r.token, USDC_BASE); assert.equal(r.chainId, CHAIN); assert.equal(r.form, 'address');
});

t('a BIII EIP-681 USDC transfer → recipient + amount parsed', () => {
  const uri = receiveURI({ address: BOB, amountUsd: '12.50' });
  const r = parsePaymentQR(uri);
  assert.equal(r.valid, true); assert.equal(r.to, BOB);
  assert.equal(r.amountMicro, '12500000'); assert.equal(r.amountUsd, '12.50');
  assert.equal(r.form, 'eip681-transfer');
});

t('a bare ethereum:0xADDR@8453 (no amount) → valid recipient, amount entered in-app', () => {
  const r = parsePaymentQR(receiveURI({ address: ALICE }));
  assert.equal(r.valid, true); assert.equal(r.to, ALICE); assert.equal(r.amountMicro, null);
});

t('FAIL-CLOSED: a non-Base chain is refused (never send on the wrong chain)', () => {
  const r = parsePaymentQR('ethereum:' + USDC_BASE + '@1/transfer?address=' + BOB + '&uint256=1000000');
  assert.equal(r.valid, false); assert.match(r.reason, /base|8453/i);
});

t('FAIL-CLOSED: a non-USDC token transfer is refused', () => {
  const r = parsePaymentQR('ethereum:0x' + 'de'.repeat(20) + '@8453/transfer?address=' + BOB + '&uint256=1000000');
  assert.equal(r.valid, false); assert.match(r.reason, /usdc/i);
});

t('FAIL-CLOSED: a native-ETH value QR is NOT auto-sent as ETH — the address is taken, amount entered as USDC', () => {
  const r = parsePaymentQR('ethereum:' + BOB + '@8453?value=1000000000000000000');
  assert.equal(r.valid, true); assert.equal(r.to, BOB); assert.equal(r.amountMicro, null, 'the ETH value is ignored');
  assert.equal(r.token, USDC_BASE);
});

t('FAIL-CLOSED: garbage / bad address / empty is refused', () => {
  assert.equal(parsePaymentQR('hello').valid, false);
  assert.equal(parsePaymentQR('ethereum:0x123@8453/transfer?address=0xnope&uint256=1').valid, false);
  assert.equal(parsePaymentQR('').valid, false);
  assert.equal(parsePaymentQR(null).valid, false);
});

t('receiveURI: with an amount → a scannable transfer intent; without → a bare address URI', () => {
  assert.match(receiveURI({ address: ALICE, amountUsd: '5' }), new RegExp('^ethereum:' + USDC_BASE + '@8453/transfer\\?address=' + ALICE + '&uint256=5000000$'));
  assert.equal(receiveURI({ address: ALICE }), 'ethereum:' + ALICE + '@8453');
  assert.throws(() => receiveURI({ address: 'nope' }));
});

// the round-trip both users rely on: Alice shows a receive QR → Bob scans it → gets Alice as the target.
t('ROUND-TRIP: Alice\'s receive QR, scanned by Bob, resolves to Alice + the amount', () => {
  const r = parsePaymentQR(receiveURI({ address: ALICE, amountUsd: '4.20' }));
  assert.equal(r.to, ALICE); assert.equal(r.amountUsd, '4.20');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
