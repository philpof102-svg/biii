'use strict';
// chain watcher + MCP bridge — offline (fake RPC / fake fetch). Run: node test/chain.test.js
const assert = require('node:assert');
const { findPayment, verifyTxHash, TRANSFER_TOPIC } = require('../lib/chain');
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

  /* THE THIRD DIMENSION OF THE SAME FILTER. The test above covers `address`, and the recipient topic is
   * covered elsewhere — but topic[0], the event SIGNATURE, was re-verified by verifyTxHash and never by
   * findPayment. This file's own banner says "the till believes only Transfer logs"; until 2026-07-28 it
   * believed any log the RPC handed back.
   *
   * The collision is not hypothetical. USDC's Approval(owner, spender, value) has the same topic arity
   * and a uint256 `data`, so an approval naming the merchant produced a payment FACT worth its allowance
   * — money "received" off an event that moves nothing. An approval costs an attacker nothing and is not
   * even a transfer to reverse.
   *
   * Three signatures, one legitimate: the passing case has to be here too, or a fail-closed pushed one
   * notch too far would read exactly like a fix. */
  await t('findPayment re-verifies the event SIGNATURE, not just the token and the recipient', async () => {
    const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
    const log = (topic0) => [{ address: USDC, transactionHash: '0x' + '66'.repeat(32), blockNumber: '0xf0',
      data: '0x' + (7_000_000).toString(16), topics: [topic0, pad('0x' + 'ee'.repeat(20)), pad(M)] }];
    const trouve = (topic0) => findPayment({ to: M, minMicro: '1', fetchImpl: fakeRpc(log(topic0)) });

    assert.equal(await trouve(APPROVAL), null, 'an Approval moves nothing and must not be stamped a payment');
    assert.equal(await trouve('0x' + 'de'.repeat(32)), null, 'an arbitrary signature is not a Transfer either');
    /* Sanity: the fixture differs from the passing one ONLY by topic[0]. Without this, the two rejections
     * above could be passing for some unrelated reason in the fixture and prove nothing. */
    const ok = await trouve(TRANSFER_TOPIC);
    assert.ok(ok, 'a real Transfer, same fixture otherwise, is still found');
    assert.equal(ok.valueMicro, '7000000');
  });

  await t('verifyTxHash: retrieve a tx by hash → real USDC payment facts (the accounting proof), fail-closed', async () => {
    const TX = '0x' + '99'.repeat(32);
    // a fake RPC: eth_getTransactionReceipt returns a receipt with a USDC Transfer log; eth_blockNumber = head
    const receiptRpc = (receipt, head = '0x100') => async (url, init) => {
      const q = JSON.parse(init.body);
      const result = q.method === 'eth_blockNumber' ? head : q.method === 'eth_getTransactionReceipt' ? receipt : null;
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const good = { status: '0x1', blockNumber: '0xfa', logs: [{ address: USDC, topics: [TRANSFER_TOPIC, pad('0x' + 'ee'.repeat(20)), pad(M)], data: '0x' + (2_500_000).toString(16) }] };
    const p = await verifyTxHash({ txHash: TX, fetchImpl: receiptRpc(good) });
    assert.equal(p.paid, true); assert.equal(p.to, M.toLowerCase()); assert.equal(p.valueMicro, '2500000');
    assert.equal(p.confirmations, 0x100 - 0xfa + 1); assert.ok(p.explorer.includes(TX));
    // reverted tx → not paid
    assert.equal((await verifyTxHash({ txHash: TX, fetchImpl: receiptRpc({ status: '0x0', blockNumber: '0xfa', logs: [] }) })).paid, false);
    // a receipt whose only log is a NON-USDC contract → not a USDC payment
    const scamLog = { status: '0x1', blockNumber: '0xfa', logs: [{ address: '0x' + 'ba'.repeat(20), topics: [TRANSFER_TOPIC, pad(M), pad(M)], data: '0x' + (9).toString(16) }] };
    assert.equal((await verifyTxHash({ txHash: TX, fetchImpl: receiptRpc(scamLog) })).paid, false, 'a non-USDC transfer is not a USDC payment');
    // not found / malformed
    assert.equal((await verifyTxHash({ txHash: TX, fetchImpl: receiptRpc(null) })).found, false);
    assert.equal((await verifyTxHash({ txHash: '0xdead' })).reason, 'not a 32-byte txHash');
  });

  console.log('\nthe MCP bridge (phase 3: agents pay real-world humans):');

  // This asserted an exact list of fifteen tool names and an exact ORDER, and had been failing for a while
  // because the server grew past it — the count in its own title said 15 while twenty-seven were exposed. A
  // permanently red test teaches everyone to stop reading the suite, which is the same mechanism as a warning
  // too quiet to act on: present, and therefore worse than absent.
  //
  // The count was never what this test was for. Its purpose is the descriptor-only POSTURE: that the tools which
  // touch money say, in their own descriptions, that this server holds no key and moves no funds. So it now
  // looks each tool up BY NAME and asserts the posture, and adding a tool cannot break it while removing one
  // still does.
  await t('the original fifteen are all present, with the descriptor-only posture in their descriptions', () => {
    const byName = new Map(TOOLS.map((x) => [x.name, x]));
    const ORIGINAL = ['till_vet_merchant', 'till_create_charge', 'till_check_payment', 'till_trust',
      'till_create_invoice', 'till_check_invoice', 'till_vet_asset', 'till_receipt', 'till_roll', 'till_export',
      'till_meter', 'till_floor', 'till_resolve', 'till_kya', 'till_authorize'];
    const missing = ORIGINAL.filter((n) => !byName.has(n));
    assert.deepStrictEqual(missing, [], 'tools disappeared: ' + missing.join(', '));

    const posture = (name, re) => assert.match(byName.get(name).description, re, name + ' lost its posture line');
    posture('till_create_charge', /holds no key|moves no funds/i);
    posture('till_export', /non-custodial|re-verif/i);
    posture('till_meter', /self-reported|provable/i);
    posture('till_floor', /fingerprint|same floor|decentrali/i);
    posture('till_resolve', /identity|npub|trustless/i);
    posture('till_kya', /kya|know your agent|identity/i);
    posture('till_authorize', /spend|cumulative|drain-safe/i);
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
