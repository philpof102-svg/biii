#!/usr/bin/env node
'use strict';
/**
 * The scorecard's truth table.
 *
 * Every row named BIAS is a way this file has actually lied about our own performance, in one direction or
 * the other. They are the point: a self-grading metric with no adversarial test is a press release.
 *
 * The hardest row is the last one — the naive repair that measures 1.00. It is not a bug anyone would catch
 * in review, because the code is correct and the number is simply an artifact of a young dataset.
 */
const assert = require('node:assert');
const { scoreCalls, isStrongCall } = require('../lib/scorecard');

const H = 3600000;
const T0 = Date.parse('2026-07-26T12:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();
const NOW = at(T0);

// a token seen `ageH` hours ago, still alive
const live = (verdict, ageH) => ({ firstVerdict: verdict, outcome: 'live', firstSeen: at(T0 - ageH * H) });
// a token seen `ageH` hours ago that rugged `afterH` hours after first sight
const rug = (verdict, ageH, afterH) => ({
  firstVerdict: verdict, outcome: 'rugged',
  firstSeen: at(T0 - ageH * H), ruggedAt: at(T0 - ageH * H + afterH * H),
});

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('one definition of a strong call, used on both sides:');
t('rug_ready and high_risk are both strong; caution and unknown are not', () => {
  assert.ok(isStrongCall({ firstVerdict: 'rug_ready' }));
  assert.ok(isStrongCall({ firstVerdict: 'high_risk' }));
  assert.ok(!isStrongCall({ firstVerdict: 'caution' }));
  assert.ok(!isStrongCall({ firstVerdict: 'unknown' }));
});
t('BIAS: a high_risk that survives costs exactly what a high_risk that rugs earns', () => {
  // The original asymmetry: high_risk counted as a win but not as a false alarm.
  const c = scoreCalls([rug('high_risk', 30, 1), live('high_risk', 30)], NOW);
  assert.equal(c.strongCallsRight, 1);
  assert.equal(c.strongCallsWrong, 1, 'the surviving high_risk must land on the ledger, not vanish from it');
  assert.equal(c.strongPrecisionResolved, 0.5);
});

console.log('\nthe maturity window is DERIVED from the data, never chosen:');
t('it comes from the rug-lifetime distribution, rounded up', () => {
  const c = scoreCalls([rug('rug_ready', 40, 1), rug('rug_ready', 40, 6.2), rug('caution', 40, 3)], NOW);
  assert.equal(c.maturityWindowHours, 7);
  assert.match(c.maturityWindowBasis, /percentile/i);
});
t('BIAS: ONE slow rug must not widen the window enough to erase a false alarm', () => {
  // The defect this replaced, reproduced exactly. A flagged token survives 18h and is a resolved false
  // alarm. Then a single token rugs at 26h. Under a max-based window that outlier pushed the window past
  // 18h, the false alarm became "still open", and precision rose from 0.93 to 1.00 with no call improving.
  const many = [];
  for (let i = 0; i < 20; i++) many.push(rug('high_risk', 40, 1));   // a normal population: rugs land in ~1h
  const survivor = live('rug_ready', 18);
  const before = scoreCalls(many.concat([survivor]), NOW);
  assert.equal(before.strongCallsWrong, 1, 'the 18h survivor is a resolved false alarm');

  const after = scoreCalls(many.concat([survivor, rug('caution', 40, 26)]), NOW);
  assert.equal(after.strongCallsWrong, 1, 'one 26h outlier must NOT reclassify it as open');
  assert.ok(after.maturityWindowHours <= 3,
    'window moved to ' + after.maturityWindowHours + 'h — a quantile should barely notice one outlier');
  assert.ok(after.strongPrecisionResolved <= before.strongPrecisionResolved,
    'precision must not RISE because a slow rug appeared elsewhere');
});
t('the cost of the window is published, not hidden', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(rug('high_risk', 40, 1));
  rows.push(rug('caution', 40, 26));
  const c = scoreCalls(rows, NOW);
  assert.ok(c.beyondWindowRugs >= 1, 'a rug landing past the window has to be counted');
  assert.equal(c.slowestRugHours, 26, 'the maximum is still reported — it just no longer sets the window');
  assert.match(c.maturityWindowBasis, /slow catches/i);
});
t('with no rug observed there is no window, and nothing may be called a false alarm', () => {
  const c = scoreCalls([live('rug_ready', 500)], NOW);
  assert.equal(c.maturityWindowHours, null);
  assert.equal(c.strongCallsWrong, 0);
  assert.equal(c.strongCallsOpen, 1, 'a 500h-old flag stays OPEN when nothing has ever resolved');
  assert.equal(c.strongPrecisionResolved, null, 'no resolved call means no precision to claim');
  assert.match(c.maturityWindowBasis, /no rug observed yet/i);
});

console.log('\nOPEN calls — the bias that punished us:');
t('BIAS: a flag younger than the window is OPEN, not wrong', () => {
  // One rug resolved in 2h (window = 2h). A token flagged 40 minutes ago has not answered yet.
  const c = scoreCalls([rug('rug_ready', 10, 2), live('rug_ready', 0.67)], NOW);
  assert.equal(c.strongCallsOpen, 1);
  assert.equal(c.strongCallsWrong, 0, 'forty minutes is not a verdict');
  assert.equal(c.strongPrecisionResolved, 1, 'over RESOLVED calls it is 1/1…');
  assert.equal(c.strongPrecisionWorstCase, 0.5, '…and 1/2 once the open one is assumed wrong');
});
t('a flag OLDER than the window has outlived every rug and is a false alarm', () => {
  const c = scoreCalls([rug('rug_ready', 10, 2), live('rug_ready', 9)], NOW);
  assert.equal(c.strongCallsWrong, 1);
  assert.equal(c.strongCallsOpen, 0);
  assert.equal(c.strongPrecisionResolved, 0.5);
});
t('BIAS: an unreadable firstSeen resolves AGAINST us, never as open', () => {
  const broken = { firstVerdict: 'rug_ready', outcome: 'live', firstSeen: 'not-a-date' };
  const c = scoreCalls([rug('rug_ready', 10, 2), broken], NOW);
  assert.equal(c.strongCallsWrong, 1, '"I do not know how old it is" must not lift an error out of the denominator');
  assert.equal(c.strongCallsOpen, 0);
});

console.log('\nBOTH bounds are published, because either alone is a lie:');
t('the resolved figure and the worst case are different numbers and both appear', () => {
  const rows = [rug('rug_ready', 10, 1), rug('high_risk', 9, 1), live('rug_ready', 0.5), live('high_risk', 0.5)];
  const c = scoreCalls(rows, NOW);
  assert.equal(c.strongPrecisionResolved, 1);
  assert.equal(c.strongPrecisionWorstCase, 0.5);
  assert.notEqual(c.strongPrecisionResolved, c.strongPrecisionWorstCase);
});
t('BIAS: the naive repair reads 1.00 on a young dataset — and the worst case is what exposes it', () => {
  // Six wins that resolved in an hour, six fresh flags that cannot have answered yet. Grading only what is
  // closed reports a perfect scanner. This is the trap, and it is why the pair is published, not the best of.
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(rug('rug_ready', 5, 1));
  for (let i = 0; i < 6; i++) rows.push(live('rug_ready', 0.25));
  const c = scoreCalls(rows, NOW);
  assert.equal(c.strongPrecisionResolved, 1, 'the closed-only figure really is 1.00 — which is exactly the problem');
  assert.equal(c.strongCallsOpen, 6);
  assert.equal(c.strongPrecisionWorstCase, 0.5, 'the honest floor while half the sample has not answered');
  assert.match(c.note, /neither may be quoted alone/i);
});

console.log('\nthe zero that had no denominator:');
t('missedOutright travels with the count of clean verdicts ever emitted', () => {
  const c = scoreCalls([rug('caution', 5, 1)], NOW);
  assert.equal(c.missedOutright, 0);
  assert.equal(c.cleanVerdictsEmitted, 0, 'you cannot miss with a verdict you never give');
});
t('a clean verdict that rugs is counted as an outright miss', () => {
  const c = scoreCalls([{ firstVerdict: 'clean', outcome: 'rugged', firstSeen: at(T0 - 5 * H), ruggedAt: at(T0 - 4 * H) }], NOW);
  assert.equal(c.missedOutright, 1);
  assert.equal(c.cleanVerdictsEmitted, 1);
});

console.log('\nthe top tier discloses whether anything can still reach it:');
t('rugReadyVerdictsEmitted counts them, so an unreachable tier cannot hide', () => {
  const c = scoreCalls([rug('rug_ready', 5, 1), rug('high_risk', 5, 1), rug('caution', 5, 1)], NOW);
  assert.equal(c.rugReadyVerdictsEmitted, 1);
});
t('a ledger whose top tier is empty reports 0 rather than omitting the field', () => {
  // After the impersonation rule moved to the identity axis, nothing new reaches rug_ready. A hierarchy
  // whose top level is silently unreachable misleads by its shape alone — same reason cleanVerdictsEmitted
  // travels with missedOutright.
  const c = scoreCalls([rug('high_risk', 5, 1), live('high_risk', 0.2)], NOW);
  assert.equal(c.rugReadyVerdictsEmitted, 0);
  assert.ok('rugReadyVerdictsEmitted' in c, 'the field must be present at zero, not absent');
});
t('historical rug_ready calls still count as strong calls — the ledger is not rewritten', () => {
  const c = scoreCalls([rug('rug_ready', 5, 1)], NOW);
  assert.equal(c.strongCallsRight, 1, 'a call that was made is graded, however the rule was later changed');
  assert.equal(c.ofWhichStrong, 1);
});

console.log('\nthe founding signal reports whether it has ever fired:');
t('armedPowersObserved counts the tokens where a power was actually fireable', () => {
  const armed = { ...rug('rug_ready', 5, 1), armedAtFirstSight: ['HONEYPOT — buys succeed, sells do not'] };
  const c = scoreCalls([armed, rug('caution', 5, 1)], NOW);
  assert.equal(c.armedPowersObserved, 1);
});
t('a database where it NEVER fired reports 0 — it must not read as "no danger"', () => {
  const rows = [rug('caution', 5, 1), live('high_risk', 0.2)].map((r) => ({ ...r, armedAtFirstSight: [] }));
  const c = scoreCalls(rows, NOW);
  assert.equal(c.armedPowersObserved, 0);
  assert.ok('armedPowersObserved' in c, 'present at zero, never omitted');
});
t('the basis denominator separates "we looked and saw nothing" from "we never wrote it down"', () => {
  // Rows older than the basis change carry no inputs at all and simply cannot be audited. Counting them as
  // "owner unreadable" would invent an observation we never made.
  const withBasis = { ...rug('caution', 5, 1), basisAtFirstSight: { ownerState: 'live', holders: 12 } };
  const unknownOwner = { ...rug('caution', 5, 1), basisAtFirstSight: { ownerState: 'unknown', holders: 3 } };
  const legacy = rug('caution', 5, 1);
  const c = scoreCalls([withBasis, unknownOwner, legacy], NOW);
  assert.equal(c.basisRecorded, 2, 'the legacy row has no basis and is not counted as one');
  assert.equal(c.ownerStateReadable, 1, 'only the row where the owner was actually visible');
});

console.log('\nthe rest of the ledger still adds up:');
t('a caution that rugs is a warning, at the strength it was given', () => {
  const c = scoreCalls([rug('caution', 5, 1), rug('rug_ready', 5, 1)], NOW);
  assert.equal(c.warnedBeforeTheRug, 2);
  assert.equal(c.ofWhichStrong, 1);
  assert.equal(c.ofWhichCautionOnly, 1);
  assert.equal(c.warnRate, 1);
  assert.equal(c.strongRate, 0.5);
});
t('an unknown that rugs is an abstention, not a warning', () => {
  const c = scoreCalls([rug('unknown', 5, 1)], NOW);
  assert.equal(c.abstained, 1);
  assert.equal(c.warnedBeforeTheRug, 0);
  assert.equal(c.warnRate, 0);
});
t('an empty database claims nothing at all', () => {
  const c = scoreCalls([], NOW);
  assert.equal(c.warnRate, null);
  assert.equal(c.strongPrecisionResolved, null);
  assert.equal(c.strongPrecisionWorstCase, null);
});
t('it accepts the on-disk shape (an object keyed by address) as well as an array', () => {
  const byAddr = { '0xaa': rug('rug_ready', 5, 1), '0xbb': live('high_risk', 0.1) };
  const c = scoreCalls(byAddr, NOW);
  assert.equal(c.tokensTracked, 2);
  assert.equal(c.strongCallsRight, 1);
});

console.log('\nit is pure — no clock, no disk, no network:');
t('the same rows and the same `now` give the same card twice', () => {
  const rows = [rug('rug_ready', 5, 1), live('high_risk', 0.5)];
  assert.deepEqual(scoreCalls(rows, NOW), scoreCalls(rows, NOW));
});
t('moving `now` forward turns an open call into a resolved false alarm, with no other input changing', () => {
  const rows = [rug('rug_ready', 10, 2), live('rug_ready', 1)];
  assert.equal(scoreCalls(rows, NOW).strongCallsOpen, 1);
  const later = at(T0 + 3 * H);   // the live one is now 4h old, past the 2h window
  assert.equal(scoreCalls(rows, later).strongCallsWrong, 1);
});
t('the source reaches no network and reads no clock', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'scorecard.js'), 'utf8');
  for (const forbidden of ['node:https', 'require(\'https\')', 'fetch(', 'Date.now()', 'new Date()', 'readFileSync']) {
    assert.ok(!src.includes(forbidden), 'scorecard.js must not contain ' + forbidden);
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
