#!/usr/bin/env node
'use strict';
/**
 * The gap detector's truth table.
 *
 * Every row here decides whether a blackout gets WRITTEN DOWN, and a gap that is not written down is
 * indistinguishable from a quiet market — which is the entire failure this module exists to end. So the rows
 * that matter are the ones where a plausible implementation would stay silent: a first run, a clock that
 * moved backwards, a run that is merely late.
 */
const assert = require('node:assert');
const { detectGap, newestObservation, appendGap, DEFAULT_MAX_QUIET_H } = require('../lib/watch-gap');

const H = 3600000;
const T0 = Date.parse('2026-07-27T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('a real blackout is recorded:');
t('the 9.3h gap that started this — from/to/hours', () => {
  const g = detectGap(T0 - 9.3 * H, T0);
  assert.ok(g, 'a 9.3h silence must be reported');
  assert.equal(g.hours, 9.3);
  assert.equal(g.to, iso(T0));
  assert.equal(g.from, iso(T0 - 9.3 * H));
});
t('the threshold is a strict >, so exactly the bar is not a gap', () => {
  assert.equal(detectGap(T0 - DEFAULT_MAX_QUIET_H * H, T0), null);
  assert.ok(detectGap(T0 - (DEFAULT_MAX_QUIET_H + 0.1) * H, T0));
});

console.log('\nsilence that is NOT a blackout, and would be a false alarm:');
t('a merely late run is not a gap — the schedule is hourly', () => {
  assert.equal(detectGap(T0 - 1.4 * H, T0), null);
});
t('a FIRST run invents nothing', () => {
  // No prior observation is not a nine-hour hole; it is the beginning. A false gap here would teach the
  // reader to discount the real ones.
  assert.equal(detectGap(0, T0), null);
  assert.equal(detectGap(null, T0), null);
  assert.equal(detectGap(undefined, T0), null);
});
t('a clock that moved BACKWARDS is not a negative gap', () => {
  // Sleep and NTP corrections do this. A negative gap would silently subtract from the unwatched total.
  assert.equal(detectGap(T0 + 3 * H, T0), null);
});
t('an unreadable timestamp yields no gap rather than a nonsense one', () => {
  assert.equal(detectGap('hier', T0), null);
  assert.equal(detectGap(T0 - 9 * H, 'maintenant'), null);
});

console.log('\nfinding the newest observation:');
t('it reads lastSeen, falling back to firstSeen', () => {
  const db = {
    '0xa': { firstSeen: iso(T0 - 5 * H), lastSeen: iso(T0 - 2 * H) },
    '0xb': { firstSeen: iso(T0 - 1 * H) },                       // no lastSeen yet
  };
  assert.equal(newestObservation(db), T0 - 1 * H, 'the firstSeen-only row is the newest and must count');
});
t('an empty or malformed database gives 0, which reads as "first run"', () => {
  assert.equal(newestObservation({}), 0);
  assert.equal(newestObservation(null), 0);
  assert.equal(newestObservation({ '0xa': { lastSeen: 'pas une date' } }), 0);
});
t('it accepts the array shape as well as the address-keyed one', () => {
  assert.equal(newestObservation([{ lastSeen: iso(T0 - 3 * H) }]), T0 - 3 * H);
});

console.log('\nthe log is bounded, because it is committed every hour:');
t('appending keeps the most recent entries and drops the oldest', () => {
  let log = [];
  for (let i = 0; i < 250; i++) log = appendGap(log, { hours: i }, 200);
  assert.equal(log.length, 200);
  assert.equal(log[log.length - 1].hours, 249, 'the newest gap survives');
  assert.equal(log[0].hours, 50, 'the oldest were dropped, not the newest');
});
t('appending nothing leaves the log untouched', () => {
  const log = appendGap([{ hours: 1 }], null);
  assert.equal(log.length, 1);
});
t('a malformed log is replaced rather than crashed on', () => {
  assert.deepStrictEqual(appendGap('pas un tableau', { hours: 2 }), [{ hours: 2 }]);
});

console.log('\nit is pure — no clock, no disk, no network:');
t('the source reads nothing outside its arguments', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'watch-gap.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/function detectGap/.test(code), 'sanity: the comment stripper left the code intact');
  for (const forbidden of ['node:https', 'fetch(', 'Date.now()', 'readFileSync', 'process.env']) {
    assert.ok(!code.includes(forbidden), 'watch-gap.js must not contain ' + forbidden);
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
