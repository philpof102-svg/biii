'use strict';
// GET /radar — the trust-radar brief: issuer-verified coverage + the rolling history of /asset + /trust
// checks this node served (flags first). Offline (injected stores). Run: node test/rest-radar.test.js
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const { loadScreen } = require('../lib/screen');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const REAL = '0x' + '1a'.repeat(20);   // a genuine Dinari token in the injected registry
const BAD = '0x' + 'de'.repeat(20);    // a known-bad wallet in the injected floor
const FLOOR = loadScreen({ asOf: '2026-07-22', sources: ['test'], addresses: [BAD] });
const REGISTRY = { entries: [{ issuer: 'Dinari', symbol: 'AAPL', name: 'Apple - Dinari', chainId: 8453, address: REAL, source: 'issuer: factory (on-chain verified)' }], source: 'issuer-official' };
const ISSUER_VERIFIED = [{ issuer: 'Dinari', symbol: 'AAPL', chainId: 8453, address: REAL }, { issuer: 'Ondo', symbol: 'USDY', chainId: 1, address: '0x' + '2b'.repeat(20) }];
const TC = { verdict: (s) => ({ decision: s && s.deny && s.deny.entry ? 'BLOCK' : 'PROCEED_LOW_VALUE', allowed: !(s && s.deny && s.deny.entry), shield: { color: 'x', reasonShort: 'x', flags: [], explainer: 'x' } }) };

function get(server, path) {
  return new Promise((resolve) => { http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { j = null; } resolve({ status: res.statusCode, body: j }); }); }); });
}

(async () => {
  console.log('GET /radar — trust-radar brief + rolling history:');
  const server = build({ merchant: '0x' + 'ab'.repeat(20), assetRegistry: REGISTRY, knownBad: FLOOR, trustCore: TC, issuerVerified: ISSUER_VERIFIED, radarStore: [], findPayment: async () => null });
  await new Promise((r) => server.listen(0, r));

  await t('an empty radar still reports COVERAGE (what this node can authenticate)', async () => {
    const r = await get(server, '/radar');
    assert.equal(r.body.radar.coverage.issuerVerified, 2);
    assert.deepStrictEqual(r.body.radar.coverage.byIssuer, { Dinari: 1, Ondo: 1 });
    assert.equal(r.body.radar.coverage.chains, 2, 'Base + Ethereum');
    assert.equal(r.body.radar.coverage.floor.addresses, 1);
    assert.equal(r.body.radar.served, 0);
  });

  await t('checks accumulate into the history, and FLAGS (impersonation + known-bad) surface first', async () => {
    await get(server, '/asset?token=' + REAL + '&claimedIssuer=BlackRock');   // real contract, wrong claim → impersonation
    await get(server, '/asset?token=' + REAL + '&claimedSymbol=AAPL');        // genuine → not a flag
    await get(server, '/trust?address=' + BAD);                               // known-bad → blocked flag
    await get(server, '/trust?address=0x' + 'c1'.repeat(20));                 // clean → not a flag
    const r = await get(server, '/radar');
    assert.equal(r.body.radar.served, 4, 'all four checks logged');
    assert.equal(r.body.radar.recentFlags.length, 2, 'only the impersonation + the known-bad block are flags');
    const kinds = r.body.radar.recentFlags.map((f) => f.kind + ':' + f.verdict).sort();
    assert.deepStrictEqual(kinds, ['asset:impersonation', 'trust:blocked']);
    assert.ok(r.body.radar.recentChecks.length >= 4);
    assert.match(r.body.note, /trust radar/i);
  });

  await t('the history is capped + newest-first (a genuine check is NOT a flag)', async () => {
    const r = await get(server, '/radar');
    assert.ok(r.body.radar.recentChecks[0].t >= r.body.radar.recentChecks[1].t, 'newest first');
    assert.ok(!r.body.radar.recentFlags.some((f) => f.verdict === 'genuine' || f.verdict === 'not-known-bad'), 'clean results never flagged');
  });

  await server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
