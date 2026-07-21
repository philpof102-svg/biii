'use strict';
// BIII decoupling invariant — the load-bearing fact of the "safe to pay the excluded" expansion.
// A PSP EXCLUDES you because it fuses risk-check with settlement: passing its underwriting is a
// PRECONDITION to its rail. BIII splits them — the settlement path (create charge -> EIP-681 URI ->
// verify on-chain) NEVER consults the trust verdict, so the chain permits the transfer regardless and
// the verdict only INFORMS the payer. That decoupling is why "declined by Stripe" has no BIII analog:
// there is no account to open and nothing to gate. This test pins it so a future edit can't fuse them
// back (which would recreate the PSP gate AND turn BIII into a chokepoint). Run: node test/decoupling.test.js
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const till = require('../lib/till');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const MERCHANT = '0x' + '11'.repeat(20);
const PAYER = '0x' + '22'.repeat(20);
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

console.log('BIII decoupling — settlement never depends on the trust verdict (the expansion\'s load-bearing fact):');

t('INVARIANT: lib/till.js does not import lib/trust — settlement code cannot depend on the verdict', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'till.js'), 'utf8');
  assert.ok(!/require\(['"][^'"]*trust['"]\)/.test(src), 'till.js must not require the trust module');
  assert.ok(!/assessTriangle|repVertex|standingVertex/.test(src), 'till.js must not reference the verdict fns');
});

t('the settlement PATH needs no reputation input at any step: charge -> URI -> verify', () => {
  // 1. create a charge from address + amount ALONE — no trust, no KYB, no account
  const charge = till.createCharge({ to: MERCHANT, amountUsd: 5, nowMs: 1 });
  assert.equal(charge.to, MERCHANT);
  assert.ok(/^\d+$/.test(String(charge.amountMicro)) && BigInt(charge.amountMicro) > 0n);
  // 2. the payment URI is a plain address->address ERC-20 transfer on Base — address + amount only
  const uri = till.paymentURI(charge);
  assert.ok(uri.includes(USDC_BASE) && uri.includes('@8453'), 'EIP-681 USDC on Base');
  assert.ok(uri.includes('address=' + MERCHANT) && /uint256=\d+/.test(uri), 'carries only recipient + amount');
  assert.ok(!/trust|score|verdict|reputation/i.test(uri), 'the URI encodes no trust signal — it cannot');
  // 3. verification reads the CHAIN alone (field-for-field), never a verdict
  const fact = { chainId: 8453, token: USDC_BASE, from: PAYER, to: MERCHANT, valueMicro: String(charge.amountMicro), confirmations: 3 };
  const v = till.verifyPayment(charge, fact);
  assert.equal(v.paid, true, 'a matching chain fact settles — with zero trust input');
});

t('an EXCLUDED payee (no entity/bank/KYB, any fresh keypair) can still be charged and paid', () => {
  // the whole point: createCharge accepts ANY 0x address — it never asks who they are
  const freshAgent = '0x' + 'ab'.repeat(20);   // an AI agent that by law cannot pass KYC
  const charge = till.createCharge({ to: freshAgent, amountUsd: 1, nowMs: 1 });
  const uri = till.paymentURI(charge);
  assert.ok(uri.includes('address=' + freshAgent), 'a keypair with no identity is a valid payee');
  const fact = { chainId: 8453, token: USDC_BASE, from: PAYER, to: freshAgent, valueMicro: String(charge.amountMicro), confirmations: 6 };
  assert.equal(till.verifyPayment(charge, fact).paid, true);
});

t('verification stays FAIL-CLOSED and chain-only — a wrong-recipient/amount/chain fact does NOT settle', () => {
  const charge = till.createCharge({ to: MERCHANT, amountUsd: 5, nowMs: 1 });
  const base = { chainId: 8453, token: USDC_BASE, from: PAYER, to: MERCHANT, valueMicro: String(charge.amountMicro), confirmations: 3 };
  assert.equal(till.verifyPayment(charge, { ...base, to: PAYER }).paid, false, 'wrong recipient');
  assert.equal(till.verifyPayment(charge, { ...base, valueMicro: '1' }).paid, false, 'wrong amount');
  assert.equal(till.verifyPayment(charge, { ...base, chainId: 1 }).paid, false, 'wrong chain');
  assert.equal(till.verifyPayment(charge, null).paid, false, 'no fact = not paid (never optimistic)');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
