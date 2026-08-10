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

  await t('a registry contract → genuine (issuer + symbol + PROVENANCE surfaced), source labeled', async () => {
    const r = await req(server, '/asset?token=' + REAL);
    assert.equal(r.body.verdict.status, 'genuine');
    assert.equal(r.body.verdict.issuer, 'Ondo');
    assert.equal(r.body.verdict.provenance, 'issuer-official', 'the endpoint carries how authoritative the match is');
    assert.match(r.body.registrySource, /test · 1 contracts/);
    assert.match(r.body.note, /Non-custodial/, 'the DISCLAIMER rides the response');
  });

  await t('PROVENANCE rides the endpoint: an aggregator-sourced match is labeled weaker, not issuer-verified', async () => {
    const aggServer = build({ merchant: '0x' + 'ab'.repeat(20),
      assetRegistry: { entries: [{ issuer: 'Ondo', symbol: 'OUSG', address: REAL, source: 'coingecko:ondo' }], source: 'coingecko (free)' },
      findPayment: async () => null });
    await new Promise((r) => aggServer.listen(0, r));
    const r = await req(aggServer, '/asset?token=' + REAL);
    assert.equal(r.body.verdict.status, 'genuine');
    assert.equal(r.body.verdict.provenance, 'aggregator', 'a Coingecko match is aggregator-sourced, surfaced as such');
    await aggServer.close();
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

  /* ── `registryComplete` VOYAGE-T-IL JUSQU AU VERDICT ? ──────────────────────────────────────────────
   * Il etait CHARGE par `loadAssetRegistry()` puis JETE par les deux routes REST, alors que le jumeau
   * MCP le passait. Consequence: `lib/asset.js` fait `registryComplete === true`, donc un `null` ne
   * pouvait JAMAIS produire `confirmed: true` — la route PAYANTE rendait un verdict plus faible que la
   * route MCP gratuite. Les deux cas ci-dessous se tiennent l un l autre: sans le second, passer
   * `null` partout passerait le premier. */
  /* ⚠️ LA BRANCHE VISEE EST LA COLLISION DE SYMBOLE, et elle exige un symbole CONNU (`OUSG`) porte par
   * une AUTRE adresse. `claimedSymbol=WRONG` tombe sur une impersonation d un autre type, sans champ
   * `confirmed` — mon premier essai visait la mauvaise branche et les deux cas echouaient. */
  const IMPOSTEUR = '0x' + '2b'.repeat(20);   // absent du registre, mais revendique OUSG

  await t('★ registre NON etabli complet → impersonation NON confirmee, et la phrase le DIT', async () => {
    const r = await req(server, '/asset?token=' + IMPOSTEUR + '&claimedSymbol=OUSG');
    assert.equal(r.body.verdict.status, 'impersonation', 'la DECISION reste le refus');
    assert.equal(r.body.verdict.confirmed, false, 'mais rien n est AFFIRME sur un registre non prouve');
    assert.match(r.body.verdict.reason, /not proof of fraud/,
      'et le refus doit dire qu il n est pas une preuve de fraude');
  });

  await t('★ TEMOIN: registre PROUVE complet → le meme cas devient CONFIRME (impossible avant le correctif)', async () => {
    const complet = build({ merchant: '0x' + 'ab'.repeat(20), findPayment: async () => null,
      assetRegistry: { ...REGISTRY, complete: true } });
    await new Promise((r) => complet.listen(0, r));
    const r = await req(complet, '/asset?token=' + IMPOSTEUR + '&claimedSymbol=OUSG');
    assert.equal(r.body.verdict.status, 'impersonation');
    assert.equal(r.body.verdict.confirmed, true,
      'sur un registre explicitement complet, le verdict est MERITE — c est ce que le champ jete interdisait');
    assert.doesNotMatch(r.body.verdict.reason, /not proof of fraud/, 'et la phrase cesse de se couvrir');
    await complet.close();
  });

  await server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
