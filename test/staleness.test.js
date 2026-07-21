'use strict';
// BIII staleness disclosure — a "not-known-bad" verdict is only as current as the list; every verdict
// must carry the list's age and SAY when it's stale. Offline. Run: node test/staleness.test.js
const assert = require('node:assert');
const { loadScreen, screenMeta, STALE_DAYS } = require('../lib/screen');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const day = (iso) => Date.parse(iso);
const LIST = (asOf) => ({ asOf, sources: ['OFAC SDN (0xB10C)'], addresses: ['0x' + 'a1'.repeat(20)] });

(async () => {
  console.log('BIII staleness disclosure — the floor says how old it is:');

  await t('a FRESH list (today) → not stale, ageDays 0, discloses "current"', () => {
    const m = screenMeta(LIST('2026-07-21'), { now: day('2026-07-21T12:00:00Z') });
    assert.equal(m.ageDays, 0);
    assert.equal(m.stale, false);
    assert.match(m.disclosure, /current as of 2026-07-21/);
  });

  await t('a list older than the threshold → stale, with the age and a re-run hint', () => {
    const m = screenMeta(LIST('2026-06-01'), { now: day('2026-07-21T00:00:00Z') });   // 50 days
    assert.equal(m.ageDays, 50);
    assert.equal(m.stale, true);
    assert.ok(m.ageDays > STALE_DAYS);
    assert.match(m.disclosure, /50 days old/);
    assert.match(m.disclosure, /recently-sanctioned address may not be covered/);
    assert.match(m.disclosure, /biii-known-bad-ingest/);
  });

  await t('exactly at the threshold is not yet stale; one day past is', () => {
    const base = day('2026-07-21T00:00:00Z');
    const atLimit = screenMeta(LIST('2026-06-21'), { now: base });   // 30 days
    assert.equal(atLimit.stale, false, STALE_DAYS + ' days is the boundary, not-yet-stale');
    const past = screenMeta(LIST('2026-06-20'), { now: base });      // 31 days
    assert.equal(past.stale, true);
  });

  await t('NO list loaded → available:false and a disclosure that a "not-known-bad" is NOT clean', () => {
    const m = screenMeta(null);
    assert.equal(m.available, false);
    assert.equal(m.count, 0);
    assert.match(m.disclosure, /UNAVAILABLE/);
    assert.match(m.disclosure, /NOT a clean verdict/);
  });

  await t('a list with no asOf → ageDays null, still discloses honestly (age unknown)', () => {
    const m = screenMeta({ sources: [], addresses: ['0x' + 'b1'.repeat(20)] });
    assert.equal(m.ageDays, null);
    assert.equal(m.stale, false);   // unknown age is not asserted stale, but the string says "age unknown"
    assert.match(m.disclosure, /age unknown/);
  });

  await t('the SHIPPED floor exposes its real freshness (loads, dated, N addresses)', () => {
    const fs = require('node:fs'), path = require('node:path');
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'known-bad.json'), 'utf8'));
    const m = screenMeta(loadScreen(data), { now: day('2026-07-21T00:00:00Z') });
    assert.equal(m.available, true);
    assert.ok(m.count >= 4, 'the shipped floor has addresses');
    assert.ok(typeof m.asOf === 'string', 'and a date');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
