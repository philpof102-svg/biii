'use strict';
// BIII server — offline (injected findPayment, no network). Run: node test/server.test.js
// The payment flow is chargeId-bound: POST /charge mints a server-owned chargeId; /status & /receipt take
// that chargeId so a prior/unrelated transfer can never satisfy an unbound query (the cross-charge false-PAID).
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

// a stub chain: pays exactly one merchant with one transfer (TX), unless that TX is already consumed by
// another charge (respects excludeTxHashes — the one-transfer-one-charge guard).
const PAID = { txHash: TX, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), from: '0x' + 'ee'.repeat(20), valueMicro: '4500000', confirmations: 3, blockTime: 1 };
const stubChain = async ({ minMicro, excludeTxHashes }) => {
  if (BigInt(minMicro) > 4500000n) return null;
  const ex = excludeTxHashes instanceof Set ? excludeTxHashes : new Set((excludeTxHashes || []).map((h) => String(h).toLowerCase()));
  return ex.has(TX.toLowerCase()) ? null : PAID;
};
// a fresh server per test — the in-memory charge/consumed store is per-instance, so isolation is deliberate.
async function mkServer(deps = {}) { const s = build({ merchant: M, findPayment: stubChain, ...deps }); await new Promise((r) => s.listen(0, r)); return s; }
const mkCharge = async (s, amountUsd) => (await req(s, 'POST', '/charge', { amountUsd })).body.chargeId;

(async () => {
  console.log('BIII server — non-custodial, chargeId-bound, chain-truthful:');
  const server = await mkServer();

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
    const radar = await req(server, 'GET', '/radar.html');
    assert.match(String(radar.raw || ''), /Trust Radar/, 'the radar dashboard page is served');
  });

  await t('POST /charge → charge + chargeId + EIP-681 URI (uses configured merchant)', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', label: 'flat white' });
    assert.equal(r.body.charge.amountMicro, '4500000');
    assert.match(String(r.body.chargeId), /^[0-9a-f]{24}$/, 'the server mints a chargeId that binds this charge');
    assert.equal(r.body.paymentURI, `ethereum:${T.USDC_BASE}@8453/transfer?address=${M.toLowerCase()}&uint256=4500000`);
    assert.equal((await req(server, 'POST', '/charge', { amountUsd: 'xyz' })).status, 400);
  });

  await t('GET /status?chargeId → paid once the transfer exists (bound to THIS charge)', async () => {
    const s = await mkServer();
    const id = await mkCharge(s, '4.50');
    const r = await req(s, 'GET', `/status?chargeId=${id}`);
    assert.equal(r.body.verdict.paid, true);
    assert.equal(r.body.verdict.tier, 'confirmed');
    const bigId = await mkCharge(s, '9.00');      // stub returns null for > 4.5 → unpaid
    assert.equal((await req(s, 'GET', `/status?chargeId=${bigId}`)).body.verdict.paid, false);
    s.close();
  });

  await t('GET /receipt?chargeId → verified receipt with txHash; 404 when unpaid', async () => {
    const s = await mkServer();
    const id = await mkCharge(s, '4.50');
    const r = await req(s, 'GET', `/receipt?chargeId=${id}&name=Cafe`);
    assert.equal(r.body.receipt.txHash, TX);
    assert.ok(r.body.receipt.explorer.includes('basescan.org'));
    const bigId = await mkCharge(s, '9.00');
    assert.equal((await req(s, 'GET', `/receipt?chargeId=${bigId}`)).status, 404);
    s.close();
  });

  await t('the configured merchant is FIXED — a caller cannot redirect the charge to another address', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', to: '0x' + '99'.repeat(20) });
    assert.equal(r.body.charge.to, M.toLowerCase(), 'caller-supplied `to` is ignored when a merchant is configured');
  });

  // ── the CRITICAL false-PAID fixes ──
  await t('NO chargeId → never paid: an unbound /status can\'t be satisfied by a prior/unrelated transfer', async () => {
    const s = await mkServer();
    const r = await req(s, 'GET', '/status');           // no chargeId at all — the cross-charge replay vector
    assert.equal(r.body.verdict.paid, false);
    assert.match(r.body.verdict.reason, /chargeId/);
    // a bogus/expired chargeId is likewise never paid
    assert.equal((await req(s, 'GET', '/status?chargeId=deadbeefdeadbeefdeadbeef')).body.verdict.paid, false);
    assert.equal((await req(s, 'GET', '/receipt?chargeId=deadbeefdeadbeefdeadbeef')).status, 404);
    s.close();
  });

  await t('ONE transfer, ONE charge: a second same-amount charge can\'t re-claim a consumed transfer (two-register)', async () => {
    const s = await mkServer();
    const a = await mkCharge(s, '4.50');
    assert.equal((await req(s, 'GET', `/status?chargeId=${a}`)).body.verdict.paid, true, 'charge A claims the transfer');
    const b = await mkCharge(s, '4.50');                 // second register, same amount, same merchant
    const rb = await req(s, 'GET', `/status?chargeId=${b}`);
    // B is NOT paid — whether via the exclude path (findPayment never returns A's consumed tx → "no chain
    // fact") or the race backstop ("another charge already applied it"). The security property is paid:false.
    assert.equal(rb.body.verdict.paid, false, 'charge B must NOT re-use the transfer already applied to A');
    // A stays paid on re-poll (the guard rejects only OTHER charges, never the owner)
    assert.equal((await req(s, 'GET', `/status?chargeId=${a}`)).body.verdict.paid, true);
    s.close();
  });

  await t('the freshness window is SERVER-authoritative + narrow for a fresh charge (no client timestamp to spoof)', async () => {
    let seen = null;
    const s = await mkServer({ findPayment: async ({ lookbackBlocks }) => { seen = lookbackBlocks; return null; } });
    const id = await mkCharge(s, '4.50');
    await req(s, 'GET', `/status?chargeId=${id}`);
    assert.ok(seen < 900 && seen >= 1, `a just-created charge narrows the window server-side (got ${seen}), not 900 blocks of history`);
    s.close();
  });

  server.close();
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
