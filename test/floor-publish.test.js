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

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * ASKING FOR THE STRONGEST CHECK AND SILENTLY GETTING THE WEAKEST ONE.
 *
 * The old guard was `if (expectedFingerprint && expectedFingerprint !== claimed)`. A FALSY pin — an empty
 * string, or the `undefined` of a misspelled environment variable — skipped the comparison entirely and
 * returned `valid: true`, with nothing in the result saying the pin had not been used.
 *
 * No caller in this repo passes a pin, so it was not reachable here. But `verifyFloor` is EXPORTED and
 * documented as THE trustless adoption check for a third-party node. An operator writing
 * `{ expectedFingerprint: process.env.PINNED_FLOOR }` with the variable unset would adopt any
 * well-formed floor from a hostile mirror while believing it was pinned. That is the only place in the
 * codebase where this pattern costs the adoption of hostile data.
 *
 * `null` stays an EXPLICIT opt-out (it was the documented default). A present key with `undefined` is a
 * pin that was requested and did not arrive — it refuses. I wrote `!== undefined` on the first pass,
 * which reopened the exact hole this block exists to close; caught by running the archetypal case. */

t('★ an EMPTY pin refuses instead of downgrading to the weaker check', () => {
  const a = artifact([A, B], '2026-07-28', ['OFAC (MIT)']);
  const r = verifyFloor(a, { expectedFingerprint: '' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /empty or not a string/i);
  assert.match(r.reason, /rather than silently downgrading/i);
});

t('★ THE ARCHETYPAL CASE: an unset env var is a requested pin that did not arrive', () => {
  const a = artifact([A, B], '2026-07-28', ['OFAC (MIT)']);
  const r = verifyFloor(a, { expectedFingerprint: process.env.BIII_PIN_THAT_DOES_NOT_EXIST });
  assert.equal(r.valid, false, 'this is the shape a misspelled variable produces, and it must not adopt');
});

t('BOTH BOUNDS: omitting the pin, or opting out with null, still verifies the content hash', () => {
  /* The in-repo publisher calls verifyFloor(artifact) with no options at all — that path must be
   * untouched, or a hardening breaks the one consumer it was meant to protect. */
  const a = artifact([A, B], '2026-07-28', ['OFAC (MIT)']);
  assert.equal(verifyFloor(a).valid, true);
  assert.equal(verifyFloor(a, {}).valid, true);
  assert.equal(verifyFloor(a, { expectedFingerprint: null }).valid, true, 'null = explicit opt-out');
});

t('★ `checksRun` says which checks ACTUALLY ran — a valid:true is not one claim but two', () => {
  /* Without it, a valid:true obtained WITHOUT a pin is indistinguishable from one obtained WITH — and
   * that is the whole difference between "these bytes are self-consistent" and "these bytes are the
   * ones I meant to adopt". */
  const a = artifact([A, B], '2026-07-28', ['OFAC (MIT)']);
  const sans = verifyFloor(a);
  const avec = verifyFloor(a, { expectedFingerprint: a.fingerprint });
  assert.deepStrictEqual(sans.checksRun, ['content-hash']);
  assert.deepStrictEqual(avec.checksRun, ['content-hash', 'pinned-fingerprint']);
  assert.match(sans.reason, /NOT that they are the floor you meant to adopt/i);
  assert.doesNotMatch(avec.reason, /NOT that they are the floor/i, 'pas de reserve quand elle est fausse');
});

t('a WRONG pin still refuses, and says the pin is what refused it', () => {
  const a = artifact([A, B], '2026-07-28', ['OFAC (MIT)']);
  const r = verifyFloor(a, { expectedFingerprint: 'sha256:' + '0'.repeat(64) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /expected\/pinned value/i);
  assert.deepStrictEqual(r.checksRun, ['content-hash', 'pinned-fingerprint']);
});

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
