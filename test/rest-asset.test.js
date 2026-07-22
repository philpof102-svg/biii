'use strict';
// GET /asset — is a TOKENIZED-ASSET contract the genuine issuer's or an impersonator? One fetch, any web
// page (a pre-trade authenticity check). Offline: registry injected. Fail-closed: malformed → 400,
// non-registry → 'unknown' (NEVER a false 'genuine'), wrong claim → 'impersonation'.
// Run: node test/rest-asset.test.js
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const REAL = '0x' + '1a'.repeat(20);   // a "verified issuer" contract in our injected registry
const REGISTRY = { entries: [{ issuer: 'Ondo', symbol: 'OUSG', name: 'Ondo Short-Term US Gov', chainId: 8453, address: REAL, source: 'issuer official' }], source: 'test' };

function req(server, path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let body; try { body = JSON.parse(b || '{}'); } catch { body = null; } resolve({ status: res.statusCode, body }); });
    });
  });
}

(async () => {
  console.log('GET /asset — tokenized-asset authenticity, fail-closed:');
  const server = build({ merchant: '0x' + 'ab'.repeat(20), assetRegistry: REGISTRY, findPayment: async () => null });
  await new Promise((r) => server.listen(0, r));

  await t('a malformed contract → 400, NO verdict', async () => {
    for (const x of ['nope', '0x123', '']) {
      const r = await req(server, '/asset?token=' + encodeURIComponent(x));
      assert.equal(r.status, 400, x + ' must 400');
      assert.ok(!r.body.verdict, 'no verdict for a malformed contract');
    }
  });

  await t('a registry contract → genuine (issuer + symbol surfaced), source labeled', async () => {
    const r = await req(server, '/asset?token=' + REAL);
    assert.equal(r.body.verdict.status, 'genuine');
    assert.equal(r.body.verdict.issuer, 'Ondo');
    assert.match(r.body.registrySource, /test · 1 contracts/);
    assert.match(r.body.note, /Non-custodial/, 'the DISCLAIMER rides the response');
  });

  await t('IMPERSONATION: the real contract but a WRONG claimed issuer → impersonation (the dangerous case)', async () => {
    const r = await req(server, '/asset?token=' + REAL + '&claimedIssuer=BlackRock');
    assert.equal(r.body.verdict.status, 'impersonation');
    assert.equal(r.body.verdict.safeToAcquire, false);
    assert.match(r.body.disclosure, /never read as safe|fail-closed/i);
  });

  await t('an UNLISTED contract → unknown, NEVER genuine (fail-closed cold start)', async () => {
    const r = await req(server, '/asset?token=0x' + 'c'.repeat(40));
    assert.equal(r.body.verdict.status, 'unknown');
    assert.notEqual(r.body.verdict.status, 'genuine');
    assert.equal(r.body.verdict.safeToAcquire, false);
  });

  await t('the triangle reputation vertex rides along (genuine→PROCEED, impersonation→REFUSE)', async () => {
    const g = await req(server, '/asset?token=' + REAL);
    assert.equal(g.body.triangleReputation.decision, 'PROCEED');
    const i = await req(server, '/asset?token=' + REAL + '&claimedSymbol=WRONG');
    assert.equal(i.body.triangleReputation.decision, 'REFUSE');
  });

  await server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
