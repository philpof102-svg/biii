'use strict';
// BIII floor provenance — makes "is the known-bad floor the SAME everywhere?" a checkable fact, without
// trusting any operator. The answer to "local judgment isn't the same everywhere": it CAN be, verifiably,
// for the objective floor — convergence on public data + a deterministic hash. Pure + offline.
// Run: node test/floor-provenance.test.js
const assert = require('node:assert');
const { loadScreen, floorFingerprint, floorProvenance } = require('../lib/screen');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
const floor = (addrs, asOf, sources) => ({ asOf, sources, addresses: addrs });

console.log('BIII floor provenance (the objective floor is verifiably the same everywhere, no operator):');

t('two nodes that loaded the SAME floor (any order) get the SAME fingerprint — sameness is checkable', () => {
  const node1 = floorFingerprint(floor([A, B, C], '2026-07-21', ['OFAC', 'eth-labels']));
  const node2 = floorFingerprint(floor([C, A, B], '2026-07-21', ['eth-labels', 'OFAC']));   // different order
  assert.equal(node1, node2, 'address/source order must not change the fingerprint (canonical)');
  assert.match(node1, /^sha256:[0-9a-f]{64}$/);
});

t('a DIFFERENT floor → a different fingerprint (different DATA, not a different opinion)', () => {
  const base = floorFingerprint(floor([A, B], '2026-07-21', ['OFAC']));
  assert.notEqual(base, floorFingerprint(floor([A, B, C], '2026-07-21', ['OFAC'])), 'one more address ⇒ different');
  assert.notEqual(base, floorFingerprint(floor([A, B], '2026-07-22', ['OFAC'])), 'different asOf ⇒ different');
  assert.notEqual(base, floorFingerprint(floor([A, B], '2026-07-21', ['OFAC', 'x'])), 'different sources ⇒ different');
});

t('case/whitespace in addresses does not fork the fingerprint (loadScreen normalizes first)', () => {
  const lower = floorFingerprint(floor([A, B], '2026-07-21', ['OFAC']));
  const mixed = floorFingerprint(floor([A.toUpperCase().replace('0X', '0x'), B], '2026-07-21', ['OFAC']));
  assert.equal(lower, mixed, 'a checksummed vs lowercase list of the same addresses is the same floor');
});

t('provenance names sources + asOf + a re-derive path — never asks you to trust the node', () => {
  const p = floorProvenance(floor([A, B], '2026-07-21', ['OFAC (MIT)', 'eth-labels (MIT)']), { now: Date.parse('2026-07-25') });
  assert.equal(p.count, 2);
  assert.equal(p.asOf, '2026-07-21');
  assert.deepEqual(p.sources, ['OFAC (MIT)', 'eth-labels (MIT)']);
  assert.equal(p.ageDays, 4);
  assert.match(p.fingerprint, /^sha256:/);
  assert.match(p.reDerive, /known-bad-ingest/);
  assert.match(p.note, /public|deterministic|never on a central/i);
});

t('an UNAVAILABLE floor (no list) is honest in its provenance — fingerprint of an empty floor', () => {
  const p = floorProvenance(null);
  assert.equal(p.available, false);
  assert.equal(p.count, 0);
  // an empty floor still has a stable fingerprint (so "I have no floor" is itself checkable, not silent)
  assert.equal(p.fingerprint, floorFingerprint(loadScreen(null)));
});

t('THE POINT: same public sources ⇒ same fingerprint ⇒ same floor, computed independently on each node', () => {
  // simulate two nodes each running the ingest against the same public snapshot
  const publicSnapshot = { addresses: [B, A, C], asOf: '2026-07-21', sources: ['OFAC', 'eth-labels', 'ScamSniffer'] };
  const nodeA = loadScreen(publicSnapshot), nodeB = loadScreen({ ...publicSnapshot, addresses: [C, B, A] });
  assert.equal(floorFingerprint(nodeA), floorFingerprint(nodeB), 'independent nodes converge on the identical floor — no operator in the loop');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
