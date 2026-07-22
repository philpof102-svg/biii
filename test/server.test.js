'use strict';
// BIII server — offline (injected findPayment, no network). Run: node test/server.test.js
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const T = require('../lib/till');

const M = '0x' + 'ab'.repeat(20);
const TX = '0x' + 'cd'.repeat(32);
let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, path, body) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let body; try { body = JSON.parse(b || '{}'); } catch { body = null; } resolve({ status: res.statusCode, body, raw: b }); }); });
    if (data) r.write(data); r.end();
  });
}

(async () => {
  console.log('BIII server — non-custodial charge + chain-truthful status:');
  // a stub chain: pays exactly one merchant, once
  const paid = { txHash: TX, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), from: '0x' + 'ee'.repeat(20), valueMicro: '4500000', confirmations: 3, blockTime: 1 };
  const server = build({ merchant: M, findPayment: async ({ minMicro }) => (BigInt(minMicro) <= 4500000n ? paid : null) });
  await new Promise((r) => server.listen(0, r));

  await t('GET /health reports non-custodial + merchant configured', async () => {
    const r = await req(server, 'GET', '/health');
    assert.equal(r.body.merchantConfigured, true);
    assert.match(r.body.note, /holds no key/);
  });

  await t('GET / serves the merchant PWA same-origin (so the phone app and its API share one URL)', async () => {
    const r = await req(server, 'GET', '/');
    assert.match(String(r.raw || ''), /BIII|Caisse|screen-keypad/, 'the / route serves web/index.html');
  });

  await t('GET /embed.js + /embed-demo.html are served (the drop-in trust badge, not just referenced)', async () => {
    const js = await req(server, 'GET', '/embed.js');
    assert.match(String(js.raw || ''), /BIII trust badge|data-biii-address/, 'the embeddable badge script is served');
    const demo = await req(server, 'GET', '/embed-demo.html');
    assert.match(String(demo.raw || ''), /embed\.js|data-biii-address/, 'the badge demo page is served');
  });

  await t('POST /charge → charge + EIP-681 URI (uses configured merchant)', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', label: 'flat white' });
    assert.equal(r.body.charge.amountMicro, '4500000');
    assert.equal(r.body.paymentURI, `ethereum:${T.USDC_BASE}@8453/transfer?address=${M.toLowerCase()}&uint256=4500000`);
    const bad = await req(server, 'POST', '/charge', { amountUsd: 'xyz' });
    assert.equal(bad.status, 400);
  });

  await t('GET /status → chain verdict (paid when the transfer exists, not before)', async () => {
    const r = await req(server, 'GET', `/status?amountMicro=4500000`);
    assert.equal(r.body.verdict.paid, true);
    assert.equal(r.body.verdict.tier, 'confirmed');
    const over = await req(server, 'GET', `/status?amountMicro=9000000`);   // stub returns null → unpaid
    assert.equal(over.body.verdict.paid, false);
  });

  await t('GET /receipt → verified receipt with txHash; 404 when unpaid', async () => {
    const r = await req(server, 'GET', `/receipt?amountUsd=4.50&name=Cafe`);
    assert.equal(r.body.receipt.txHash, TX);
    assert.ok(r.body.receipt.explorer.includes('basescan.org'));
    const no = await req(server, 'GET', `/receipt?amountUsd=9.00`);
    assert.equal(no.status, 404);
  });

  await t('the configured merchant is FIXED — a caller cannot redirect the charge to another address', async () => {
    const other = '0x' + '99'.repeat(20);
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', to: other });
    assert.equal(r.body.charge.to, M.toLowerCase(), 'caller-supplied `to` is ignored when a merchant is configured');
  });

  await t('/status rejects a non-positive amountMicro (400) — no dust reads as paid', async () => {
    assert.equal((await req(server, 'GET', '/status?amountMicro=0')).status, 400);
    assert.equal((await req(server, 'GET', '/status?amountMicro=')).status, 400);
    assert.equal((await req(server, 'GET', '/status?amountMicro=-5')).status, 400);
  });

  await t('false-PAID binding: a fresh charge NARROWS the lookback so a prior payment cannot satisfy it', async () => {
    let seen = null;
    const s2 = build({ merchant: M, findPayment: async ({ lookbackBlocks }) => { seen = lookbackBlocks; return null; } });
    await new Promise((r) => s2.listen(0, r));
    await req(s2, 'GET', `/status?amountMicro=4500000&createdAtMs=${Date.now()}`);
    assert.ok(seen < 900 && seen >= 1, `a just-created charge must narrow the window (got ${seen}), not scan 900 blocks of history`);
    s2.close();
  });

  server.close();
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
