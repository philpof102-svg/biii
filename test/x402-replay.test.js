'use strict';
// x402 anti-replay: one confirmed USDC payment redeems EXACTLY ONE verdict. Offline (injected verifyTxHash).
// Run: node test/x402-replay.test.js
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
process.env.BIII_X402_CONSUMED = path.join(os.tmpdir(), 'biii-x402-replay-' + process.pid + '.json');
process.env.BIII_MERCHANT = '0x' + 'ab'.repeat(20);        // must be set BEFORE requiring the server
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const settle = require('../lib/x402-settle');

const M = '0x' + 'ab'.repeat(20);
const tx = (n) => '0x' + String(n).padStart(64, '0');       // distinct valid 64-hex txHashes (digits are hex)
const proof = (o = {}) => ({ paid: true, txHash: tx(1), to: M.toLowerCase(), valueMicro: '10000', confirmations: 3, blockNumber: 5000, ...o });

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, p, body, headers) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(headers || {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { j = null; } resolve({ status: res.statusCode, body: j }); }); });
    if (data) r.write(data); r.end();
  });
}

(async () => {
  // ── unit: settleOnce ──────────────────────────────────────────────────────
  await t('first use of a fresh valid payment settles', () => {
    settle._reset();
    const r = settle.settleOnce({ proof: proof({ txHash: tx(1) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, true);
  });
  await t('SAME txHash a second time is REJECTED (replay) with 409', () => {
    // (state carries from the previous case — tx(1) is now consumed)
    const r = settle.settleOnce({ proof: proof({ txHash: tx(1) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 409);
  });
  await t('underpayment is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(2), valueMicro: '1000' }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('payment to a different recipient is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(3), to: '0x' + 'cc'.repeat(20) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('a stale payment (too many confirmations) is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(4), confirmations: 5000 }), merchant: M, needMicro: '2000', maxAgeBlocks: 900 });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('a not-paid proof is rejected (402)', () => {
    const r = settle.settleOnce({ proof: { paid: false, txHash: tx(5) }, merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });

  // ── integration: the paid endpoint, same payment twice ────────────────────
  settle._reset();
  const PTX = tx(42);
  const server = build({ verifyTxHash: async ({ txHash }) => ({ paid: true, txHash, to: M.toLowerCase(), valueMicro: '10000', confirmations: 3, blockNumber: 6000 }) })
    .listen(0);
  await new Promise((r) => server.once('listening', r));
  const asset = { address: '0x' + '12'.repeat(20), claimedIssuer: 'BlackRock', claimedSymbol: 'BUIDL' };

  await t('POST /x402/vet-asset with a fresh payment → 200 verdict', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': PTX });
    assert.equal(r.status, 200); assert.ok(r.body && r.body.verdict);
  });
  await t('SAME payment reused → 409 (one payment = one verdict)', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': PTX });
    assert.equal(r.status, 409);
  });
  await t('a brand-new payment → 200 again (distinct tx settles)', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': tx(43) });
    assert.equal(r.status, 200);
  });

  server.close();
  try { fs.unlinkSync(process.env.BIII_X402_CONSUMED); } catch {}
  console.log(`\nx402-replay: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
