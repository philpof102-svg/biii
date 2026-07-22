'use strict';
// BIII meter — usage → bill, split by trust (provable vs self-reported). Pure + offline.
// Run: node test/meter.test.js
const assert = require('node:assert');
const { meterUsage, mergePlan, DEFAULT_PLAN } = require('../lib/meter');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const rcpt = (tx, paid, bt = 1_752_000_000) => ({
  merchant: { name: 'M', address: '0x' + 'a'.repeat(40) }, amountMicro: String(paid), paidMicro: String(paid),
  overpaidMicro: '0', token: 'USDC', chainId: 8453, txHash: tx, blockTime: bt,
  explorer: 'https://basescan.org/tx/' + tx,
});
const N = (n) => rcpt('0x' + String(n).padStart(64, '0'), 5_000000);

console.log('BIII meter (usage → bill, split by trust):');

t('base-only month: no overage → just the plan base', () => {
  const m = meterUsage([N(1), N(2)], { verdictCount: 10 });
  assert.equal(m.provable.settledReceipts, 2);
  assert.equal(m.provable.settledVolumeUsd, '10.00');
  assert.equal(m.totalUsd, 750, 'included quota not exceeded → base only');
  assert.equal(m.charges.length, 1);
});

t('the settled-receipt count is PROVABLE (dedup by txHash, on-chain) — a repeated tx bills once', () => {
  const r = N(7);
  const m = meterUsage([r, r, N(8)], {});
  assert.equal(m.provable.settledReceipts, 2, 'the repeated txHash is not double-billed');
  assert.equal(m.provable.txHashes.length, 2, 'the txHashes are surfaced for re-verification');
});

t('verdict overage is SELF-REPORTED and labeled as such (verdicts are not on-chain)', () => {
  const m = meterUsage([N(1)], { verdictCount: 5200, plan: { includedVerdicts: 5000, verdictOverageUsd: 0.25 } });
  const over = m.charges.find((c) => c.item === 'verdicts over quota');
  assert.ok(over, 'verdict overage charged');
  assert.equal(over.qty, 200);
  assert.equal(over.amountUsd, 50, '200 × $0.25');
  assert.match(over.basis, /SELF-REPORTED/, 'the basis is honestly labeled non-provable');
  assert.equal(m.totalUsd, 800, '750 base + 50 verdict overage');
});

t('receipt overage IS provable (on-chain settled receipts over quota)', () => {
  const plan = { includedReceipts: 2, receiptOverageUsd: 0.03 };
  const m = meterUsage([N(1), N(2), N(3), N(4)], { plan });
  const over = m.charges.find((c) => c.item === 'receipts over quota');
  assert.equal(over.qty, 2, '4 settled − 2 included');
  assert.equal(over.amountUsd, 0.06);
  assert.match(over.basis, /provable|on-chain/i);
});

t('the plan is INJECTED (partner brings pricing); defaults are the pilot template', () => {
  assert.equal(DEFAULT_PLAN.monthlyBaseUsd, 750);
  assert.equal(DEFAULT_PLAN.includedVerdicts, 5000);
  assert.equal(mergePlan({ monthlyBaseUsd: 3000 }).monthlyBaseUsd, 3000, 'override base');
  assert.equal(mergePlan({ monthlyBaseUsd: 3000 }).verdictOverageUsd, 0.25, 'unset fields fall back to default');
  assert.equal(mergePlan().includedReceipts, Infinity, 'receipts unlimited by default');
});

t('window filters by on-chain blockTime, same as the books/export', () => {
  const m = meterUsage([rcpt('0x' + '1'.repeat(64), 5_000000, 1000), rcpt('0x' + '2'.repeat(64), 5_000000, 9_000000)], { window: { fromBlockTime: 5000 } });
  assert.equal(m.provable.settledReceipts, 1, 'only the in-window receipt counts');
});

t('the disclosure splits provable vs self-reported and keeps the non-custodial fact', () => {
  const m = meterUsage([N(1)], { verdictCount: 3 });
  assert.match(m.disclosure, /on-chain|re-verify/i);
  assert.match(m.disclosure, /self-reported/i);
  assert.match(m.disclosure, /non-custodial/i);
});

t('empty month is honest: 0 provable receipts, base only, nothing invented', () => {
  const m = meterUsage([], {});
  assert.equal(m.provable.settledReceipts, 0);
  assert.equal(m.provable.settledVolumeUsd, '0.00');
  assert.equal(m.totalUsd, 750);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
