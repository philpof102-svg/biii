'use strict';
// BIII white-label — a partner ships receipts/rolls under THEIR brand. The load-bearing rule: branding
// changes only the attribution line; the FACTS (✓ PAID·USDC·on-Base, the txHash, and the non-custodial
// disclosure) can never be white-labeled away. Offline. Run: node test/whitelabel.test.js
const assert = require('node:assert');
const L = require('../lib/ledger');
const T = require('../lib/till');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const M = '0x' + 'ab'.repeat(20);
const mkReceipt = (tx, usd, over = '0', bt = 1700000000, label = 'flat white') => ({
  v: 1, kind: 'basetill-receipt', merchant: { name: 'Café Demo', address: M }, label,
  amountUsd: usd, amountMicro: T.usdToMicro(usd), paidMicro: T.usdToMicro(usd), overpaidMicro: over,
  token: 'USDC', chainId: 8453, txHash: tx, payer: '0x' + 'ee'.repeat(20), tier: 'confirmed',
  blockTime: bt, explorer: 'https://basescan.org/tx/' + tx,
});

console.log('BIII white-label — the partner brand, the facts stay:');

t('brandLine: default is "via BIII"; a partner name replaces it; poweredBy appends the tag', () => {
  assert.equal(L.brandLine(), 'via BIII');
  assert.equal(L.brandLine('Acme Pay'), 'via Acme Pay');
  assert.equal(L.brandLine({ name: 'Acme Pay' }), 'via Acme Pay');
  assert.equal(L.brandLine({ name: 'Acme Pay', poweredBy: true }), 'via Acme Pay · powered by BIII');
  assert.equal(L.brandLine(''), 'via BIII', 'empty brand falls back, never a blank line');
  assert.equal(L.brandLine({ name: '' }), 'via BIII');
});

t('renderReceipt white-labels the footer but KEEPS the PAID·USDC·on-Base fact + the basescan link', () => {
  const rec = mkReceipt('0x' + 'cd'.repeat(32), '4.50');
  const branded = L.renderReceipt(rec, { number: 1, brand: 'Acme Pay' });
  assert.match(branded, /via Acme Pay/);
  assert.ok(!/via BIII/.test(branded), 'the BIII attribution is replaced, not doubled');
  assert.match(branded, /✓ PAID · USDC on Base/, 'the rail fact is NOT white-labeled away');
  assert.match(branded, /basescan\.org\/tx\//, 'the re-verify link stays');
  // default (no brand) still says via BIII
  assert.match(L.renderReceipt(rec, {}), /via BIII/);
});

t('renderRoll white-labels the header but KEEPS the non-custodial disclosure (a fact, not branding)', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50')));
  const branded = L.renderRoll(rows, { merchantName: 'Café Demo', brand: { name: 'Acme Pay', poweredBy: true } });
  assert.match(branded, /via Acme Pay · powered by BIII/);
  assert.match(branded, /Non-custodial: BIII holds no funds/, 'the honesty disclosure survives white-labeling');
  assert.match(branded, /trust no one/i, 'and the re-verify ethos stays');
  // FR non-custodial disclosure also survives
  const fr = L.renderRoll(rows, { merchantName: 'Café Demo', lang: 'fr', brand: 'Acme Pay' });
  assert.match(fr, /via Acme Pay/);
  assert.match(fr, /Non-custodial : BIII ne détient aucun fonds/);
});

t('HONESTY INVARIANT: no brand can remove the PAID fact or the disclosure (the whole point)', () => {
  const rec = mkReceipt('0x' + 'aa'.repeat(32), '9.99');
  // even a hostile brand string cannot smuggle out the fact line
  const branded = L.renderReceipt(rec, { brand: { name: 'Totally Legit Bank' } });
  assert.match(branded, /✓ PAID · USDC on Base/);
  assert.ok(!/bank holds your funds|custodial/i.test(branded), 'no branding can imply custody');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
