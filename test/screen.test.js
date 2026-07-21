'use strict';
// BIII screen — the decentralized known-bad floor. Offline, pure. Run: node test/screen.test.js
const assert = require('node:assert');
const { loadScreen, screenAddress } = require('../lib/screen');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const BAD = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';   // Lazarus/OFAC (from data/known-bad.json)
const CLEAN = '0x' + '11'.repeat(20);
const SRC = { asOf: '2026-07-21', sources: ['OFAC SDN (0xB10C)'], addresses: [BAD, '0x' + '22'.repeat(20)] };

console.log('BIII screen — decentralized known-bad floor (no oracle, fail-closed):');

t('a listed address is BLOCKed — with zero network', () => {
  const r = screenAddress(BAD, SRC);
  assert.equal(r.blocked, true);
  assert.equal(r.available, true);
  assert.match(r.reason, /known-bad list/);
  assert.match(r.reason, /OFAC SDN/);   // names its source (re-verifiable)
});

t('case-insensitive: a checksummed listed address still BLOCKs', () => {
  assert.equal(screenAddress(BAD.toUpperCase().replace('0X', '0x'), SRC).blocked, true);
});

t('an address NOT on the list is not blocked — but NOT reported "clean" (only "not known-bad")', () => {
  const r = screenAddress(CLEAN, SRC);
  assert.equal(r.blocked, false);
  assert.equal(r.available, true);
  assert.match(r.reason, /NOT a safety guarantee/);
});

t('FAIL-CLOSED: no list loaded ⇒ screening UNAVAILABLE, never a clean verdict', () => {
  const empty = screenAddress(CLEAN, null);
  assert.equal(empty.blocked, false);
  assert.equal(empty.available, false);
  assert.match(empty.reason, /UNAVAILABLE/);
  // an empty/garbage source is also unavailable, never silently clearing
  assert.equal(loadScreen({}).available, false);
  assert.equal(loadScreen({ addresses: 'not-an-array' }).available, false);
  assert.equal(screenAddress(BAD, { addresses: [] }).available, false);
});

t('malformed input is refused, not crashed', () => {
  assert.equal(screenAddress('not-an-address', SRC).blocked, false);
  assert.equal(screenAddress('not-an-address', SRC).available, false);
  assert.equal(screenAddress(undefined, SRC).blocked, false);
});

t('loadScreen drops non-address junk, keeps count honest', () => {
  const s = loadScreen({ asOf: '2026-07-21', addresses: [BAD, 'junk', '0xshort', BAD] });
  assert.equal(s.count, 1);         // dedup + drop malformed
  assert.equal(s.available, true);
  assert.equal(s.asOf, '2026-07-21');
});

t('the SHIPPED data/known-bad.json loads, names public sources, and blocks the Lazarus address', () => {
  const fs = require('node:fs'), path = require('node:path');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'known-bad.json'), 'utf8'));
  const s = loadScreen(data);
  assert.ok(s.available && s.count >= 1);
  assert.ok(s.sources.some((x) => /OFAC/i.test(x)), 'the shipped list names its public source');
  assert.equal(screenAddress(BAD, s).blocked, true, 'the bundled node blocks a known OFAC address with no network');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
