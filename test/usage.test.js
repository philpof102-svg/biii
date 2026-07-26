#!/usr/bin/env node
'use strict';
/**
 * The usage counter's truth table.
 *
 * A metrics module is where a project lies to itself most cheaply, so the rows that matter are not "does it
 * count" but: does it count OUR OWN probes as evidence of demand, does it keep anything it should not, and
 * does it present a floor as a total. Each of those has already happened somewhere in this codebase.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-usage-'));
process.env.BIII_USAGE = path.join(TMP, 'usage.json');
const U = require('../lib/usage');

const DAY = 86400000;
const T0 = Date.parse('2026-07-27T10:00:00.000Z');

let pass = 0, fail = 0;
/* `_reset()` alone does NOT isolate a test, and two rows failed until that was understood: it clears memory
 * and sets `loaded = false`, so the next record() reloads whatever an earlier test flushed to disk. The store
 * file has to go too. Worth keeping as a note rather than a silent fix — a reset that leaves persistence
 * behind is a trap for the next person, and the counts it produces look plausible. */
const isolate = () => { U._reset(); try { fs.unlinkSync(process.env.BIII_USAGE); } catch { /* absent is fine */ } };
const t = (name, fn) => { try { isolate(); fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('it counts what it is for:');
t('a call lands against its tool name', () => {
  U.record('till_trust', { now: T0 });
  U.record('till_trust', { now: T0 });
  U.record('till_vet_meme', { now: T0 });
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 3);
  assert.equal(r.byTool.till_trust, 2);
  assert.equal(r.toolsEverCalled, 2);
});
t('a database with no calls reports zero rather than nothing', () => {
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 0);
  assert.equal(r.toolsEverCalled, 0);
  assert.equal(r.since, null);
});

console.log('\nOUR OWN probes must never become the evidence that people use it:');
t('an internal call is counted apart and never in externalCalls', () => {
  U.record('till_trust', { now: T0, internal: true });
  U.record('till_trust', { now: T0, internal: true });
  U.record('till_trust', { now: T0 });
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 1, 'only the stranger counts as demand');
  assert.equal(r.internalCalls, 2);
  assert.match(r.internalExcluded, /must not become the evidence/i);
});
t('an internal call does not even reach byTool', () => {
  U.record('till_roll', { now: T0, internal: true });
  assert.equal(U.report({ now: T0 }).byTool.till_roll, undefined);
});

console.log('\nnothing identifying is kept:');
t('no caller hint survives in the stored file', () => {
  U.record('till_trust', { now: T0, callerHint: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  U.flush();
  const raw = fs.readFileSync(process.env.BIII_USAGE, 'utf8');
  assert.ok(!raw.includes('0xdeadbeef'), 'the caller address must not appear anywhere in the store');
  assert.ok(!raw.toLowerCase().includes('deadbeef'), 'not even a fragment of it');
});
t('the same caller is UNLINKABLE across days', () => {
  const hint = 'caller-A';
  U.record('till_trust', { now: T0, callerHint: hint });
  U.record('till_trust', { now: T0 + DAY, callerHint: hint });
  U.flush();
  const raw = JSON.parse(fs.readFileSync(process.env.BIII_USAGE, 'utf8'));
  const days = Object.keys(raw.days).sort();
  assert.equal(days.length, 2);
  const a = raw.days[days[0]].callers[0], b = raw.days[days[1]].callers[0];
  assert.ok(a && b, 'both days recorded a caller');
  assert.notEqual(a, b, 'the same caller on two days must hash differently, or the salt is not doing its job');
});
t('the same caller twice in ONE day is one distinct caller', () => {
  U.record('till_trust', { now: T0, callerHint: 'caller-A' });
  U.record('till_trust', { now: T0 + 1000, callerHint: 'caller-A' });
  U.record('till_trust', { now: T0 + 2000, callerHint: 'caller-B' });
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 3);
  assert.equal(r.distinctCallersToday, 2);
});
t('a call with no hint still counts as a call, just not as a caller', () => {
  U.record('till_trust', { now: T0 });
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 1);
  assert.equal(r.distinctCallersToday, 0, 'unattributable is not invented');
});

console.log('\nit presents a FLOOR, never a total:');
t('every report carries the stdio blind spot', () => {
  U.record('till_trust', { now: T0 });
  const r = U.report({ now: T0 });
  assert.match(r.floorNotTotal, /FLOOR on real usage, never a total/i);
  assert.match(r.neverRecorded, /never stored/i);
});

console.log('\nbounded, because this service once filled its volume:');
t('only RETAIN_DAYS days are kept', () => {
  for (let i = 0; i < U.RETAIN_DAYS + 10; i++) U.record('till_trust', { now: T0 + i * DAY });
  const r = U.report({ now: T0 + (U.RETAIN_DAYS + 9) * DAY });
  assert.equal(r.daysCovered, U.RETAIN_DAYS, 'got ' + r.daysCovered + ' days');
});
t('the caller ceiling is enforced AND disclosed rather than silently capping', () => {
  for (let i = 0; i < U.MAX_CALLERS_PER_DAY + 5; i++) U.record('till_trust', { now: T0, callerHint: 'c' + i });
  const r = U.report({ now: T0 });
  assert.equal(r.distinctCallersToday, U.MAX_CALLERS_PER_DAY);
  assert.equal(r.callerCeilingHit, true, 'a capped number reported as a total is the failure this flag prevents');
});

console.log('\nit survives a restart, because "has anyone EVER called" is the question:');
t('counts reload from disk', () => {
  U.record('till_vet_agent', { now: T0 });
  U.record('till_vet_agent', { now: T0 });
  U.flush();
  U._reset();                                    // simulate a fresh process
  const r = U.report({ now: T0 });
  assert.equal(r.byTool.till_vet_agent, 2, 'an in-memory-only counter answers "no" after every redeploy');
});
t('a corrupt store is treated as absent, not as a crash', () => {
  fs.writeFileSync(process.env.BIII_USAGE, '{ not json');
  U._reset();
  const r = U.report({ now: T0 });
  assert.equal(r.externalCalls, 0, 'a broken metrics file must never take the payment server down with it');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
