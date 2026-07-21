'use strict';
// BIII ledger — the till roll. Offline. Run: node test/ledger.test.js
const assert = require('node:assert');
const T = require('../lib/till');
const L = require('../lib/ledger');

const M = '0x' + 'ab'.repeat(20);
const mkReceipt = (tx, usd, overMicro = '0', bt = 1700000000, label = 'flat white') => ({
  v: 1, kind: 'basetill-receipt', merchant: { name: 'Café Demo', address: M.toLowerCase() },
  label, amountUsd: usd, amountMicro: T.usdToMicro(usd), paidMicro: T.usdToMicro(usd),
  overpaidMicro: overMicro, token: 'USDC', chainId: 8453, txHash: tx,
  payer: '0x' + 'ee'.repeat(20), tier: 'confirmed', blockTime: bt, explorer: 'https://basescan.org/tx/' + tx,
});

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII ledger — a human reads it, and anyone can audit it:');

t('renderReceipt: a paper-ticket a non-crypto human understands (amount, PAID, tip, verify link)', () => {
  const r = L.renderReceipt(mkReceipt('0x' + 'cd'.repeat(32), '4.50', '500000'), { number: 42, lang: 'en' });
  assert.match(r, /Café Demo/);
  assert.match(r, /B3-0042/);
  assert.match(r, /Amount:\s+4\.50 USDC/);
  assert.match(r, /Tip:\s+0\.5 USDC/);
  assert.match(r, /✓ PAID · USDC on Base/);
  assert.match(r, /basescan\.org\/tx\//);
  const fr = L.renderReceipt(mkReceipt('0x' + 'cd'.repeat(32), '4.50'), { lang: 'fr' });
  assert.match(fr, /PAYÉ/); assert.match(fr, /Merci/);
});

t('appendReceipt: append-only, sequential numbers, one txHash at most once (honest books)', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50')));
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '22'.repeat(32), '3.00')));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].no, 'B3-0001'); assert.equal(rows[1].no, 'B3-0002');
  const dup = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50'));   // same tx again
  assert.equal(dup.duplicate, true); assert.equal(dup.rows.length, 2);
  assert.throws(() => L.appendReceipt(rows, { kind: 'x' }), /verified receipt/);
});

t('summary: provable day books — exact micro totals + tips + every txHash re-checkable', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50', '500000', 1700000000)));
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '22'.repeat(32), '3.00', '0', 1700003600)));
  const s = L.summary(rows);
  assert.equal(s.count, 2);
  assert.equal(s.grossUsd, '7.5');
  assert.equal(s.tipsUsd, '0.5');
  assert.equal(s.txHashes.length, 2);
  // windowing by block time
  assert.equal(L.summary(rows, { fromBlockTime: 1700003000 }).count, 1);
});

t('reverify: a past receipt re-checks against the chain — an un-fakeable line', () => {
  const tx = '0x' + '11'.repeat(32);
  const { rows } = L.appendReceipt([], mkReceipt(tx, '4.50'));
  const goodFact = { txHash: tx, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), valueMicro: '4500000', confirmations: 20 };
  assert.equal(L.reverify(rows[0], goodFact).ok, true);
  // a fact for a DIFFERENT tx cannot ratify this receipt
  const wrongTx = { ...goodFact, txHash: '0x' + '99'.repeat(32) };
  assert.equal(L.reverify(rows[0], wrongTx).ok, false);
  // an underpaid fact fails
  assert.equal(L.reverify(rows[0], { ...goodFact, valueMicro: '1' }).ok, false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
