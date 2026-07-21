'use strict';
// BIII hardening — regression tests for the bugs the adversarial workflow found (2026-07-21).
// Run: node test/harden.test.js
const assert = require('node:assert');
const T = require('../lib/till');
const { repVertex, assessTriangle } = require('../lib/trust');
const { assessAsset } = require('../lib/asset');
const { findPayment } = require('../lib/chain');
const L = require('../lib/ledger');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const M = '0x' + 'ab'.repeat(20);
const okFact = (v) => ({ txHash: '0x' + 'cd'.repeat(32), chainId: 8453, token: T.USDC_BASE, to: M, from: '0x' + 'ee'.repeat(20), valueMicro: String(v), confirmations: 3, blockTime: 1 });

console.log('BIII hardening — the adversarial-workflow fixes, locked:');

t('verifyPayment FAILS CLOSED on a non-positive/malformed charge amount (no dust reads as paid)', () => {
  for (const amt of ['', '0', '-5', '  ', '4.50', '0x1', null]) {
    const v = T.verifyPayment({ to: M, amountMicro: amt, token: T.USDC_BASE, chainId: 8453 }, okFact(1000000));
    assert.equal(v.paid, false, `amount ${JSON.stringify(amt)} must not read as paid`);
  }
});

t('verifyPayment rejects a non-integer transfer value instead of throwing (crafted fact cannot crash)', () => {
  const charge = { to: M, amountMicro: '4500000', token: T.USDC_BASE, chainId: 8453 };
  for (const bad of ['4.50', '1e6', '-1', 'abc', {}]) {
    const f = okFact(0); f.valueMicro = bad;
    assert.doesNotThrow(() => T.verifyPayment(charge, f));
    assert.equal(T.verifyPayment(charge, f).paid, false);
  }
});

t('verifyPayment: confirmations:true is NOT 1 confirmation (Number(true) coercion closed)', () => {
  const charge = { to: M, amountMicro: '4500000', token: T.USDC_BASE, chainId: 8453 };
  const f = okFact('4500000'); f.confirmations = true;
  assert.equal(T.verifyPayment(charge, f).paid, false, 'boolean confirmations must not confirm');
});

t('microToUsd never renders a negative as "-4.-5"', () => {
  assert.equal(T.microToUsd('-4500000'), '-4.50');
});

t('repVertex: MainStreet CAUTION is NOT safe (the fail-open the oracle actually triggers)', () => {
  assert.equal(repVertex({ decision: 'CAUTION', score: 50 }).status, 'weak');
  assert.notEqual(repVertex({ decision: 'CAUTION', score: 90 }).status, 'safe');
  // and the whole triangle does not read a cautioned counterparty as payable
  assert.notEqual(assessTriangle({ reputation: { decision: 'CAUTION', score: 90 } }).trust, 'trusted');
});

t('repVertex: untrimmed " REFUSE " still flags; a non-finite score with no decision is unknown, not safe', () => {
  assert.equal(repVertex({ decision: ' REFUSE ', score: 90 }).status, 'unsafe');
  assert.equal(repVertex({ score: 'abc' }).status, 'unknown');
  assert.equal(repVertex({ decision: 'PROCEED', score: 70 }).status, 'safe');   // the happy path still works
});

t('assessAsset: a denylist passed as a Set of CHECKSUMMED addresses is honored (was silently bypassed)', () => {
  const FAKE = '0x' + 'ff'.repeat(20);
  const checksummed = '0x' + 'bA'.repeat(20);   // mixed-case, EIP-55-style
  const r = assessAsset({ token: checksummed }, { denylist: new Set([checksummed]) });
  assert.equal(r.status, 'unsafe'); assert.equal(r.safeToAcquire, false);
});

tA('findPayment VERIFIES the log recipient (topic[2]) — a misfiltered log to another address is not matched', async () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const VICTIM = '0x' + 'cc'.repeat(20);
  const fakeRpc = (logs) => async (_u, opt) => {
    const m = JSON.parse(opt.body).method;
    return { ok: true, json: async () => ({ result: m === 'eth_blockNumber' ? '0x100' : logs }) };
  };
  // a log whose ACTUAL recipient (topic[2]) is VICTIM, not the merchant M we asked about
  const wrong = [{ transactionHash: '0x' + '33'.repeat(32), blockNumber: '0xf0', data: '0x' + (5000000).toString(16), topics: [TRANSFER, pad('0x' + 'ee'.repeat(20)), pad(VICTIM)] }];
  assert.equal(await findPayment({ to: M, minMicro: '4500000', fetchImpl: fakeRpc(wrong) }), null, 'a transfer to VICTIM must not count as paid to the merchant');
  // and a malformed topics-short log neither crashes nor matches
  const short = [{ transactionHash: '0x1', blockNumber: '0xf0', data: '0x10', topics: [TRANSFER] }];
  assert.equal(await findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc(short) }), null);
});

t('ledger.appendReceipt dedups a txHash case-insensitively (books cannot be padded by re-casing)', () => {
  const rec = (tx) => ({ kind: 'basetill-receipt', merchant: { address: M }, amountUsd: '4.50', amountMicro: '4500000', paidMicro: '4500000', overpaidMicro: '0', txHash: tx, blockTime: 1 });
  const TX = '0x' + 'ab'.repeat(32);
  let rows = []; ({ rows } = L.appendReceipt(rows, rec(TX)));
  const dup = L.appendReceipt(rows, rec(TX.toUpperCase()));
  assert.equal(dup.duplicate, true, 'same tx in different casing is a duplicate');
  assert.equal(dup.rows.length, 1);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
