'use strict';
// GET /trust — the LOCAL safe-to-pay verdict as ONE fetch (the "any web app embeds it" surface).
// Offline: floor + trust-core injected. Fail-closed everywhere: malformed → 400 (no verdict), floor
// absent → UNAVAILABLE never clean, trust-core absent → classifier null but the screen BLOCK still fires.
// Run: node test/rest-trust.test.js
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const { loadScreen } = require('../lib/screen');
const { vetLocal, localClassify } = require('../lib/vet');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const BAD = '0x' + 'de'.repeat(20);
const CLEAN = '0x' + 'c1'.repeat(20);
const FLOOR = loadScreen({ asOf: new Date().toISOString(), sources: ['test'], addresses: [BAD] });
// a stub trust-core: deny-entry ⇒ BLOCK, else PROCEED_LOW_VALUE (mirrors the real fail-closed shape)
const TC_STUB = { verdict: (signals) => {
  const hit = signals && signals.deny && signals.deny.entry;
  const avail = signals && signals.deny && signals.deny.available === true;
  const d = hit ? 'BLOCK' : (avail ? 'PROCEED_LOW_VALUE' : 'CAUTION');
  return { decision: d, allowed: !hit && avail, shield: { color: hit ? 'red' : 'yellow', reasonShort: hit ? 'known-bad' : 'no local score', flags: hit ? ['deny'] : [], explainer: 'stub' } };
} };

function req(server, path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let body; try { body = JSON.parse(b || '{}'); } catch { body = null; } resolve({ status: res.statusCode, body }); });
    });
  });
}

(async () => {
  console.log('GET /trust — the local verdict any web app can embed (fail-closed):');
  const server = build({ merchant: '0x' + 'ab'.repeat(20), knownBad: FLOOR, trustCore: TC_STUB,
    findPayment: async () => null });
  await new Promise((r) => server.listen(0, r));

  await t('a malformed address → 400, NO verdict (garbage never gets a verdict object)', async () => {
    for (const a of ['zzz', '0x123', '', '0x' + 'g'.repeat(40)]) {
      const r = await req(server, '/trust?address=' + encodeURIComponent(a));
      assert.equal(r.status, 400, a + ' must 400');
      assert.ok(!r.body.vet, 'no vet payload on a malformed address');
    }
  });

  await t('a known-bad address → screen.blocked + classifier BLOCK (decisive, no oracle)', async () => {
    const r = await req(server, '/trust?address=' + BAD);
    assert.equal(r.status, 200);
    assert.equal(r.body.vet.screen.blocked, true);
    assert.equal(r.body.vet.classifier.decision, 'BLOCK');
    assert.match(r.body.vet.disclosure, /BLOCKED.*local known-bad floor/i);
  });

  await t('a clean address → NOT blocked, classifier capped (never a confident PROCEED), honest disclosure', async () => {
    const r = await req(server, '/trust?address=' + CLEAN);
    assert.equal(r.body.vet.screen.blocked, false);
    assert.equal(r.body.vet.classifier.decision, 'PROCEED_LOW_VALUE');
    assert.match(r.body.vet.disclosure, /NOT a clean bill/i, 'a not-on-floor read is not a clean bill');
    assert.match(r.body.note, /Non-custodial/, 'the DISCLAIMER rides every response');
  });

  await t('the floor provenance rides the verdict (count + fingerprint + staleness)', async () => {
    const r = await req(server, '/trust?address=' + CLEAN);
    assert.equal(r.body.vet.floor.available, true);
    assert.equal(r.body.vet.floor.count, 1);
    assert.match(String(r.body.vet.floor.fingerprint), /^sha256:/, 'which floor judged is provable');
    assert.equal(r.body.vet.floor.stale, false);
  });

  await server.close();

  // ── vetLocal direct (the lib both surfaces share) ──
  await t('FLOOR ABSENT → screening UNAVAILABLE, never a silent clean (server without a floor)', async () => {
    const empty = build({ merchant: '0x' + 'ab'.repeat(20), knownBad: loadScreen(null), trustCore: TC_STUB, findPayment: async () => null });
    await new Promise((r) => empty.listen(0, r));
    const r = await req(empty, '/trust?address=' + CLEAN);
    assert.equal(r.body.vet.floor.available, false);
    assert.match(r.body.vet.disclosure, /SCREENING UNAVAILABLE|NOT a clean verdict/i);
    await empty.close();
  });

  await t('TRUST-CORE ABSENT → classifier null (disclosed) but the screen BLOCK still fires', async () => {
    const v = vetLocal(BAD, { knownBad: FLOOR, tc: null });
    assert.equal(v.classifier, null, 'no classifier without trust-core');
    assert.equal(v.screen.blocked, true, 'safety never depends on trust-core being installed');
  });

  await t('vetLocal + localClassify agree with the MCP path (one judgment, many mouths)', async () => {
    const viaVet = vetLocal(BAD, { knownBad: FLOOR, tc: TC_STUB }).classifier;
    const direct = localClassify(BAD, { knownBad: FLOOR, tc: TC_STUB });
    assert.deepEqual(viaVet, direct, 'the REST surface and the lib return the SAME classifier verdict');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
