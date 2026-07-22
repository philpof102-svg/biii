'use strict';
// chain watcher + MCP bridge — offline (fake RPC / fake fetch). Run: node test/chain.test.js
const assert = require('node:assert');
const { findPayment, TRANSFER_TOPIC } = require('../lib/chain');
const { callTool, TOOLS } = require('../bin/biii-mcp');
const T = require('../lib/till');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const M = '0x' + 'ab'.repeat(20);
const USDC = T.USDC_BASE;                 // real eth_getLogs always carries the emitting contract in log.address
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const fakeRpc = (logs, head = '0x100') => async (url, init) => {
  const q = JSON.parse(init.body);
  const result = q.method === 'eth_blockNumber' ? head
    : q.method === 'eth_getLogs' ? logs
    : null;
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

(async () => {
  console.log('biii chain — the till believes only Transfer logs:');

  await t('findPayment: newest big-enough Transfer wins; confirmations = head - block + 1', async () => {
    const logs = [
      { address: USDC, transactionHash: '0x' + '11'.repeat(32), blockNumber: '0xf0', data: '0x' + (4_500_000).toString(16), topics: [TRANSFER_TOPIC, pad('0x' + 'ee'.repeat(20)), pad(M)] },
      { address: USDC, transactionHash: '0x' + '22'.repeat(32), blockNumber: '0xfa', data: '0x' + (9_000_000).toString(16), topics: [TRANSFER_TOPIC, pad('0x' + 'ff'.repeat(20)), pad(M)] },
    ];
    const f = await findPayment({ to: M, minMicro: '4500000', fetchImpl: fakeRpc(logs) });
    assert.equal(f.txHash, '0x' + '22'.repeat(32), 'newest wins');
    assert.equal(f.valueMicro, '9000000');
    assert.equal(f.confirmations, 0x100 - 0xfa + 1);
    assert.equal(f.chainId, 8453);
  });

  await t('too-small transfers are ignored; empty chain ⇒ null (never invented)', async () => {
    const small = [{ address: USDC, transactionHash: '0x' + '33'.repeat(32), blockNumber: '0xf0', data: '0x' + (100).toString(16), topics: [TRANSFER_TOPIC, pad(M), pad(M)] }];
    assert.equal(await findPayment({ to: M, minMicro: '4500000', fetchImpl: fakeRpc(small) }), null);
    assert.equal(await findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc([]) }), null);
  });

  await t('a hostile/misfiltering RPC is fail-closed: a non-USDC contract log + a consumed tx are both skipped', async () => {
    // #2: a Transfer from a SCAM token (not USDC) to the merchant must NOT be read as a USDC payment
    const scam = [{ address: '0x' + '5ca3'.repeat(10), transactionHash: '0x' + '44'.repeat(32), blockNumber: '0xf0', data: '0x' + (5_000_000).toString(16), topics: [TRANSFER_TOPIC, pad('0x' + 'ee'.repeat(20)), pad(M)] }];
    assert.equal(await findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc(scam) }), null, 'non-USDC contract → rejected');
    // #1 guard: a tx already applied to another charge is excluded
    const real = [{ address: USDC, transactionHash: '0x' + '55'.repeat(32), blockNumber: '0xf0', data: '0x' + (5_000_000).toString(16), topics: [TRANSFER_TOPIC, pad('0x' + 'ee'.repeat(20)), pad(M)] }];
    assert.equal(await findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc(real), excludeTxHashes: new Set(['0x' + '55'.repeat(32)]) }), null, 'consumed tx → excluded');
    assert.ok(await findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc(real) }), 'the same tx, not excluded → found');
  });

  console.log('\nthe MCP bridge (phase 3: agents pay real-world humans):');

  await t('15 tools exposed, descriptor-only posture in the descriptions', () => {
    assert.deepEqual(TOOLS.map((x) => x.name), ['till_vet_merchant', 'till_create_charge', 'till_check_payment', 'till_trust', 'till_create_invoice', 'till_check_invoice', 'till_vet_asset', 'till_receipt', 'till_roll', 'till_export', 'till_meter', 'till_floor', 'till_resolve', 'till_kya', 'till_authorize']);
    assert.match(TOOLS[1].description, /holds no key|moves no funds/i);
    assert.match(TOOLS[9].description, /non-custodial|re-verif/i);    // till_export keeps the discipline
    assert.match(TOOLS[10].description, /self-reported|provable/i);   // till_meter splits usage by trust
    assert.match(TOOLS[11].description, /fingerprint|same floor|decentrali/i);   // till_floor = decentralization proof
    assert.match(TOOLS[12].description, /identity|npub|trustless/i);  // till_resolve = the buzz identity bridge
    assert.match(TOOLS[13].description, /kya|know your agent|identity/i);   // till_kya = the identity standard
    assert.match(TOOLS[14].description, /spend|cumulative|drain-safe/i);   // till_authorize = programmable payment
  });

  await t('till_create_charge returns the charge + the EIP-681 intent the agent wallet executes', async () => {
    const r = await callTool('till_create_charge', { to: M, amountUsd: '4.50', label: 'flat white' });
    assert.equal(r.charge.amountMicro, '4500000');
    assert.equal(r.paymentURI, `ethereum:${T.USDC_BASE}@8453/transfer?address=${M.toLowerCase()}&uint256=4500000`);
    assert.match(r.note, /YOUR OWN wallet/);
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
