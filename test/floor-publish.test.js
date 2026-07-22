'use strict';
// BIII floor publish + trustless adoption — the shared truth-data lives on a substrate you don't control;
// a puller adopts it ONLY after verifying the hash. Closes the "nobody depends on me" loop. Pure + offline.
// Run: node test/floor-publish.test.js
const assert = require('node:assert');
const { floorFingerprint, verifyFloor } = require('../lib/screen');
const { build } = require('../scripts/biii-floor-publish');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
const artifact = (addrs, asOf, sources) => {
  const fp = floorFingerprint({ addresses: addrs, asOf, sources });
  return { kind: 'biii-known-bad-floor', v: 1, fingerprint: fp, count: addrs.length, asOf, sources, addresses: addrs };
};

console.log('BIII floor publish + trustless adoption (verify the hash, never trust the source):');

t('a well-formed artifact self-verifies → safe to adopt', () => {
  const r = verifyFloor(artifact([A, B, C], '2026-07-21', ['OFAC (MIT)']));
  assert.equal(r.valid, true);
  assert.equal(r.count, 3);
  assert.match(r.reason, /verified the hash/i);
});

t('a TAMPERED artifact (an address added after hashing) is REJECTED — fail-closed', () => {
  const good = artifact([A, B], '2026-07-21', ['OFAC']);
  const tampered = { ...good, addresses: [A, B, C] };   // a hostile mirror slipped in an extra address
  const r = verifyFloor(tampered);
  assert.equal(r.valid, false);
  assert.match(r.reason, /does not hash|tampered|corrupted/i);
});

t('a tampered artifact that DROPS a known-bad address is also rejected (can\'t weaken the floor)', () => {
  const good = artifact([A, B, C], '2026-07-21', ['OFAC']);
  const weakened = { ...good, addresses: [A, B] };      // hostile mirror removed a known-bad address
  assert.equal(verifyFloor(weakened).valid, false, 'dropping C changes the content but not the claimed hash → reject');
});

t('an artifact with NO fingerprint cannot be verified → refused (no blind trust)', () => {
  const r = verifyFloor({ addresses: [A], asOf: '2026-07-21', sources: ['OFAC'] });
  assert.equal(r.valid, false);
  assert.match(r.reason, /no fingerprint|cannot verify/i);
});

t('a PINNED expected fingerprint adds a source-independent check', () => {
  const art = artifact([A, B], '2026-07-21', ['OFAC']);
  assert.equal(verifyFloor(art, { expectedFingerprint: art.fingerprint }).valid, true, 'matches the pin');
  assert.equal(verifyFloor(art, { expectedFingerprint: 'sha256:deadbeef' }).valid, false, 'a wrong pin → reject');
});

t('build() packages the REAL floor into a self-verifying artifact (or errors honestly if no floor)', () => {
  let a;
  try { a = build(); } catch (e) {
    assert.match(e.message, /known-bad\.json/, 'if no floor is present, it says so honestly');
    console.log('      (no data/known-bad.json in this checkout — skipped the live-build assertion)');
    return;
  }
  assert.equal(a.kind, 'biii-known-bad-floor');
  assert.match(a.fingerprint, /^sha256:/);
  assert.ok(a.count > 0 && a.addresses.length === a.count);
  assert.equal(verifyFloor(a).valid, true, 'the packaged real floor self-verifies');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
