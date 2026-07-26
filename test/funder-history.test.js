#!/usr/bin/env node
'use strict';
/**
 * The freshness truth table.
 *
 * The logic of the registry is tested next door and offline. What is tested HERE is the one thing that can
 * only go wrong once the data touches a disk: a snapshot that keeps answering with full confidence while it
 * ages. The radar filling this database runs on a local machine, so a hosted node serves whatever was
 * committed — and a stale "this payer has never killed" is exactly the sentence that gets someone hurt,
 * because a payer's FIRST kill is the observation the old file is missing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { lookup, STALE_HOURS, _clearCache } = require('../lib/funder-history');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-funder-'));
const H = 3600000;
const T0 = Date.parse('2026-07-26T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** Write a throwaway database whose newest observation is `agedH` hours before T0. */
function db(rows, name) {
  const p = path.join(TMP, name + '.json');
  const obj = {};
  rows.forEach((r, i) => { obj['0xtoken' + i] = r; });
  fs.writeFileSync(p, JSON.stringify(obj));
  _clearCache();
  return p;
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('a fresh database answers normally:');
t('a payer with a prior kill is named, with the age of the evidence', () => {
  const p = db([{ funder: '0xAAA', outcome: 'rugged', firstSeen: iso(T0 - 2 * H), lastSeen: iso(T0 - 1 * H) }], 'fresh');
  const r = lookup('0xAAA', { now: T0, dbPath: p });
  assert.equal(r.verdict, 'funder_has_killed');
  assert.equal(r.stale, false);
  assert.equal(r.ageHours, 1);
  assert.equal(r.observedTokens, 1);
});
t('a payer with no kill reads "clean so far" while the file is fresh', () => {
  const p = db([{ funder: '0xBBB', outcome: 'live', firstSeen: iso(T0 - 2 * H), lastSeen: iso(T0 - 1 * H) }], 'fresh2');
  assert.equal(lookup('0xBBB', { now: T0, dbPath: p }).verdict, 'funder_clean_so_far');
});

console.log('\nSTALE — the reassuring verdicts are withdrawn, the alarming one is not:');
t('"clean so far" becomes unknown_stale on an old file', () => {
  const p = db([{ funder: '0xBBB', outcome: 'live', firstSeen: iso(T0 - 40 * H), lastSeen: iso(T0 - 30 * H) }], 'old1');
  const r = lookup('0xBBB', { now: T0, dbPath: p });
  assert.equal(r.verdict, 'unknown_stale');
  assert.match(r.reason, /describes this file rather than this payer/i);
  assert.ok(r.ageHours > STALE_HOURS);
});
t('"never seen" also becomes unknown_stale — absence in an old file is not absence', () => {
  const p = db([{ funder: '0xBBB', outcome: 'live', firstSeen: iso(T0 - 40 * H), lastSeen: iso(T0 - 30 * H) }], 'old2');
  assert.equal(lookup('0xZZZ', { now: T0, dbPath: p }).verdict, 'unknown_stale');
});
t('a KILL still stands when stale — suppressing it would fail OPEN', () => {
  // The asymmetry is deliberate: an observed kill does not un-happen, so the alarming verdict survives age
  // while the reassuring ones do not. Withdrawing both would be "safer" in appearance and worse in effect.
  const p = db([{ funder: '0xAAA', outcome: 'rugged', firstSeen: iso(T0 - 40 * H), lastSeen: iso(T0 - 30 * H) }], 'old3');
  const r = lookup('0xAAA', { now: T0, dbPath: p });
  assert.equal(r.verdict, 'funder_has_killed');
  assert.equal(r.stale, true, 'still flagged as stale, just not downgraded');
});

console.log('\nthe absent file is stated, never silently treated as "nothing known":');
t('a missing database returns no_database and refuses to reassure', () => {
  const r = lookup('0xAAA', { now: T0, dbPath: path.join(TMP, 'does-not-exist.json') });
  assert.equal(r.verdict, 'no_database');
  assert.equal(r.stale, true);
  assert.match(r.reason, /never a clearance/i);
});
t('an unparseable database is treated as absent, not as empty', () => {
  const p = path.join(TMP, 'broken.json');
  fs.writeFileSync(p, '{ this is not json');
  _clearCache();
  assert.equal(lookup('0xAAA', { now: T0, dbPath: p }).verdict, 'no_database');
});

console.log('\nan untraceable payer is never upgraded by a fresh file:');
t('no funder means no judgement, however new the data is', () => {
  const p = db([{ funder: '0xAAA', outcome: 'rugged', firstSeen: iso(T0 - 1 * H), lastSeen: iso(T0 - 0.5 * H) }], 'fresh3');
  const r = lookup(null, { now: T0, dbPath: p });
  assert.equal(r.verdict, 'funder_untraceable');
  assert.match(r.reason, /not a clearance/i);
});

console.log('\nthe freshness bar is derived, and the numbers travel with every answer:');
t('every verdict carries asOf, ageHours and stale', () => {
  const p = db([{ funder: '0xAAA', outcome: 'rugged', firstSeen: iso(T0 - 2 * H), lastSeen: iso(T0 - 1 * H) }], 'fresh4');
  for (const who of ['0xAAA', '0xUNSEEN', null]) {
    const r = lookup(who, { now: T0, dbPath: p });
    for (const k of ['asOf', 'ageHours', 'stale']) assert.ok(k in r, k + ' missing for ' + who);
  }
});
t('exactly at the bar it is not yet stale; past it, it is', () => {
  const at = db([{ funder: '0xB', outcome: 'live', firstSeen: iso(T0 - 20 * H), lastSeen: iso(T0 - STALE_HOURS * H) }], 'bar1');
  assert.equal(lookup('0xB', { now: T0, dbPath: at }).verdict, 'funder_clean_so_far');
  const past = db([{ funder: '0xB', outcome: 'live', firstSeen: iso(T0 - 30 * H), lastSeen: iso(T0 - (STALE_HOURS + 1) * H) }], 'bar2');
  assert.equal(lookup('0xB', { now: T0, dbPath: past }).verdict, 'unknown_stale');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
