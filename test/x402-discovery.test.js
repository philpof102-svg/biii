'use strict';
// x402 / AgentCash discovery + paid verdicts — offline (injected verifyTxHash, no network).
// Run: node test/x402-discovery.test.js
const assert = require('node:assert');
const http = require('node:http');
/* Isolate the anti-replay consumed-store so paid tests don't pollute data/ — MUST be set before requiring
 * the server (STORE is bound at module load).
 *
 * ⚠️ « fresh per run » ETAIT FAUX: le chemin etait `biii-x402-disc-<process.pid>.json`, et un PID se
 * RECYCLE. Rien ne supprimait le fichier — 219 exemplaires trainaient dans le tmpdir au moment de la
 * mesure. Quand un run heritait du PID d'un run precedent, il rouvrait un store contenant deja GOODTX, la
 * garde anti-rejeu repondait 409, et DEUX cas payes tombaient.
 *
 * Mesure: 1 echec sur 15 lancements a froid, puis reproduit a l'identique en forcant un nom FIXE —
 * run 1 « 5 passed · 0 failed », run 2 « 3 passed · 2 failed », les memes deux cas. Ce n'etait donc pas
 * un alea de port ni de timing.
 *
 * Ca comptait au-dela de ce fichier: `npm test` chaine en `&&`, donc ce rouge intermittent coupait la
 * suite au 38e fichier sur 73 et rendait un total PARTIEL (295 au lieu de 839). Une porte qui rougit pour
 * une raison qui n'est pas le code entraine a relancer jusqu'au vert, ce qui est exactement la facon dont
 * un vrai rouge finit par passer inapercu — la raison meme pour laquelle suite-coverage.test.js exclut
 * deja e2e-real-chain et schema-drift de la suite.
 *
 * `mkdtempSync` rend un dossier dont l'unicite est garantie par l'OS, pas par un compteur reutilisable, et
 * il est supprime a la sortie: plus de collision ET plus de fuite. */
const fs = require('node:fs');
const CONSUMED_DIR = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'biii-x402-disc-'));
process.env.BIII_X402_CONSUMED = require('node:path').join(CONSUMED_DIR, 'consumed.json');
process.on('exit', () => { try { fs.rmSync(CONSUMED_DIR, { recursive: true, force: true }); } catch {} });
const { build } = require('../lib/server');
const T = require('../lib/till');

const M = '0x' + 'ab'.repeat(20);
const GOODTX = '0x' + 'cd'.repeat(32);
const GOODTX2 = '0x' + 'ef'.repeat(32);   // a SECOND distinct payment — one payment = one verdict (anti-replay)
let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, path, body, headers) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(headers || {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { j = null; } resolve({ status: res.statusCode, body: j, headers: res.headers }); }); });
    if (data) r.write(data); r.end();
  });
}
// stub verifyTxHash: GOODTX = a confirmed USDC payment to M for 0.30 USDC (≥ the 0.25 verdict price); else unpaid.
const stubVerify = async ({ txHash }) => (txHash === GOODTX || txHash === GOODTX2)
  ? { paid: true, txHash, from: '0x' + 'ee'.repeat(20), to: M.toLowerCase(), valueMicro: '300000', confirmations: 3, blockNumber: 5000, explorer: 'https://basescan.org/tx/' + txHash }
  : { paid: false, txHash, reason: 'not found' };
async function mkServer() { const s = build({ merchant: M, verifyTxHash: stubVerify }); await new Promise((r) => s.listen(0, r)); return s; }

(async () => {
  console.log('BIII x402 / AgentCash — discoverable + paid, non-custodial (merchant receives, signs nothing):');
  const s = await mkServer();

  await t('GET /openapi.json is an AgentCash-compliant discovery doc (x-payment-info + 402 on paid ops)', async () => {
    const d = (await req(s, 'GET', '/openapi.json')).body;
    assert.equal(d.openapi, '3.1.0');
    assert.ok(d.info.title && d.info.version && d.info['x-guidance'] && d.info.contact.email, 'required info.* fields present');
    assert.ok(Array.isArray(d['x-discovery'].ownershipProofs), 'x-discovery.ownershipProofs is an array');
    const op = d.paths['/x402/vet-asset'].post;
    assert.equal(op['x-payment-info'].price.currency, 'USD');
    assert.ok(op['x-payment-info'].protocols.some((p) => p.x402), 'x402 protocol declared');
    assert.ok(op.responses['402'] && op.responses['200'], 'paid op has 402 + 200');
    assert.ok(d.paths['/x402/vet-address'].post['x-payment-info'], 'both vet ops are paid');
  });

  await t('POST /x402/vet-asset UNPAID → 402 challenge (x402 accepts: payTo=merchant, USDC on Base, price atomic)', async () => {
    const r = await req(s, 'POST', '/x402/vet-asset', { address: '0x' + '11'.repeat(20) });
    assert.equal(r.status, 402);
    assert.equal(r.body.x402Version, 1);
    const a = r.body.accepts[0];
    assert.equal(a.network, 'base');
    assert.equal(a.asset.toLowerCase(), T.USDC_BASE.toLowerCase());
    assert.equal(a.payTo, M.toLowerCase());
    assert.equal(a.amount, '250000');                       // 0.25 USDC in atomic units (the verdict corridor; see PRICING.md)
    assert.match(String(r.headers['www-authenticate'] || ''), /MPP/);
  });

  await t('POST /x402/vet-asset PAID (verified on-chain to the merchant) → the genuine/impersonation verdict', async () => {
    const dinari = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';   // Dinari dAAPL (issuer-verified)
    const r = await req(s, 'POST', '/x402/vet-asset', { address: dinari, claimedIssuer: 'Dinari' }, { 'x-payment': GOODTX });
    assert.equal(r.status, 200);
    assert.equal(r.body.verdict.status, 'genuine');
    assert.equal(r.body.paid.txHash, GOODTX);
  });

  await t('POST /x402/vet-address PAID → the safe-to-pay verdict (fail-closed local screen)', async () => {
    const r = await req(s, 'POST', '/x402/vet-address', { address: '0x' + 'a1'.repeat(20) }, { 'x-payment': GOODTX2 });
    assert.equal(r.status, 200);
    assert.ok(r.body.vet && r.body.vet.screen, 'returns the vet verdict');
  });

  await t('an UNVERIFIED payment (unknown tx) → still 402, never a free verdict (fail-closed settlement)', async () => {
    const r = await req(s, 'POST', '/x402/vet-asset', { address: '0x' + '11'.repeat(20) }, { 'x-payment': '0x' + '99'.repeat(32) });
    assert.equal(r.status, 402, 'a tx that does not settle to the merchant gets no verdict');
  });

  s.close();
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
