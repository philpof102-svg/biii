#!/usr/bin/env node
'use strict';
/**
 * A RUG WHOSE LIFETIME WE CANNOT READ IS NOT A RUG THAT DID NOT HAPPEN.
 *
 * `maturityWindow()` derived the window from a chain of `.filter()`s. A `rugged` row whose
 * `ruggedAt`/`firstSeen` would not parse — or whose gap came out negative, which is corruption and not a
 * duration — left the pipeline exactly like a row that was never a rug. Measured 2026-08-07 on the SAME
 * rows with only the dates made unreadable:
 *
 *     dates readable   -> maturityWindowHours 3    strongCallsWrong 3   strongCallsOpen 0
 *     dates unreadable -> maturityWindowHours null strongCallsWrong 0   strongCallsOpen 3
 *
 * The same three false alarms leave the count of our own errors. That is the self-flattery the p95
 * comment in the source says the design refuses, arriving through the back door: not by choosing a
 * flattering statistic, but by silently shrinking the sample.
 *
 * TWO BOUNDS, both pinned here. Over-warning would be its own defect: a card built from fully readable
 * rows must carry NO unreadable-data caveat, and a card with no rugs at all must still say "no rug
 * observed yet" and not "the data is broken". A guard that always warns measures nothing.
 */
const assert = require('node:assert');
const { scoreCalls, maturityWindow } = require('../lib/scorecard');

const H = 3600000;
const T0 = Date.parse('2026-07-26T12:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();
const NOW = at(T0);

const live = (verdict, ageH) => ({ firstVerdict: verdict, outcome: 'live', firstSeen: at(T0 - ageH * H) });
const rug = (verdict, ageH, afterH) => ({
  firstVerdict: verdict, outcome: 'rugged',
  firstSeen: at(T0 - ageH * H), ruggedAt: at(T0 - ageH * H + afterH * H),
});
// the same rug, with one date made unreadable in a specific way
const rugBroken = (verdict, ageH, how) => {
  const r = rug(verdict, ageH, 1);
  if (how === 'nullRuggedAt') r.ruggedAt = null;
  else if (how === 'garbageRuggedAt') r.ruggedAt = 'pas-une-date';
  else if (how === 'missingFirstSeen') delete r.firstSeen;
  else if (how === 'negative') r.ruggedAt = at(T0 - ageH * H - 5 * H);   // rugged BEFORE first sight
  else throw new Error('unknown breakage: ' + how);
  return r;
};

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('an unreadable lifetime is COUNTED, not dropped:');
for (const how of ['nullRuggedAt', 'garbageRuggedAt', 'missingFirstSeen', 'negative']) {
  t('a rugged row broken by ' + how + ' still counts as an observed rug, and as an unreadable one', () => {
    const rows = [rug('rug_ready', 30, 1), rug('rug_ready', 30, 3), rugBroken('rug_ready', 30, how)];
    const c = scoreCalls(rows, NOW);
    assert.strictEqual(c.rugsObserved, 3, 'the broken row is still a rug that happened');
    assert.strictEqual(c.rugsWithReadableLifetime, 2);
    assert.strictEqual(c.rugsWithUnreadableLifetime, 1);
    const m = maturityWindow(rows);
    assert.strictEqual(m.ruggedRows, 3);
    assert.strictEqual(m.unreadable, 1);
    assert.strictEqual(m.lifetimes.length, 2, 'an unreadable lifetime must not enter the quantile');
  });
}

t('the three counts always reconcile: readable + unreadable = rugsObserved', () => {
  const rows = [rug('rug_ready', 30, 1), rugBroken('caution', 30, 'nullRuggedAt'),
    rugBroken('unknown', 30, 'negative'), live('rug_ready', 30), { outcome: 'live' }];
  const c = scoreCalls(rows, NOW);
  assert.strictEqual(c.rugsWithReadableLifetime + c.rugsWithUnreadableLifetime, c.rugsObserved);
  assert.strictEqual(c.rugsObserved, 3);
});

console.log('\nthe published sentence names the denominator it actually used:');
t('the basis says "rugs WITH A READABLE LIFETIME", never plain "observed rugs"', () => {
  const c = scoreCalls([rug('rug_ready', 30, 1), rug('rug_ready', 30, 2)], NOW);
  assert.match(c.maturityWindowBasis, /rugs WITH A READABLE LIFETIME/);
  // the exact wording that carried two different denominators under one word
  assert.doesNotMatch(c.maturityWindowBasis, /of \d+ observed rugs landed/);
});
t('BIAS: with unreadable rows present the basis discloses how many took no part', () => {
  const rows = [rug('rug_ready', 30, 1), rug('rug_ready', 30, 2),
    rugBroken('rug_ready', 30, 'nullRuggedAt'), rugBroken('rug_ready', 30, 'garbageRuggedAt')];
  const c = scoreCalls(rows, NOW);
  assert.match(c.maturityWindowBasis, /2 of the 4 observed rugs carry NO readable lifetime/);
});

console.log('\nno rug observed and no rug READABLE are different states:');
t('BIAS: rugs observed but none readable must NOT read as "no rug observed yet"', () => {
  const rows = [rugBroken('rug_ready', 30, 'nullRuggedAt'), rugBroken('rug_ready', 30, 'negative')];
  const c = scoreCalls(rows, NOW);
  assert.strictEqual(c.maturityWindowHours, null);
  assert.strictEqual(c.rugsObserved, 2);
  assert.doesNotMatch(c.maturityWindowBasis, /no rug observed yet/,
    'two rugs WERE observed — the reassuring sentence is false here');
  assert.match(c.maturityWindowBasis, /NOT ONE has a readable lifetime/);
  assert.match(c.maturityWindowBasis, /GAP IN THE DATA, not a clean record/);
});
t('the same wrong number is still published, but no longer silently: strongCallsWrong reads 0 and says so', () => {
  // The policy is UNCHANGED on purpose — an underivable window resolves nothing, and both precision
  // bounds are still published. What changed is that the card now says the 0 is unmeasured.
  const rows = [rugBroken('rug_ready', 30, 'nullRuggedAt'), live('rug_ready', 30)];
  const c = scoreCalls(rows, NOW);
  assert.strictEqual(c.strongCallsWrong, 0);
  assert.strictEqual(c.strongCallsOpen, 1);
  assert.match(c.maturityWindowBasis, /Read strongCallsWrong as unmeasured here, not as zero/);
});

console.log('\nthe other bound — a clean dataset must carry NO caveat:');
t('every rug readable: zero unreadable, and not one word of unreadable-data warning', () => {
  const c = scoreCalls([rug('rug_ready', 30, 1), rug('caution', 30, 2), live('high_risk', 30)], NOW);
  assert.strictEqual(c.rugsWithUnreadableLifetime, 0);
  assert.doesNotMatch(c.maturityWindowBasis, /NO readable lifetime/);
  assert.doesNotMatch(c.maturityWindowBasis, /GAP IN THE DATA/);
  assert.strictEqual(c.strongCallsWrong, 1, 'the surviving high_risk still resolves as a false alarm');
});
t('no rug at all still says "no rug observed yet" — an empty ledger is not broken data', () => {
  const c = scoreCalls([live('rug_ready', 30), live('clean', 2)], NOW);
  assert.strictEqual(c.rugsObserved, 0);
  assert.strictEqual(c.rugsWithUnreadableLifetime, 0);
  assert.match(c.maturityWindowBasis, /no rug observed yet/);
  assert.doesNotMatch(c.maturityWindowBasis, /GAP IN THE DATA/);
});

console.log('\nthe three basis sentences are genuinely distinct (a constant would prove nothing):');
t('readable / partly unreadable / none readable / no rug give FOUR different sentences', () => {
  const cards = [
    [rug('rug_ready', 30, 1)],
    [rug('rug_ready', 30, 1), rugBroken('rug_ready', 30, 'negative')],
    [rugBroken('rug_ready', 30, 'negative')],
    [live('rug_ready', 30)],
  ].map((rows) => scoreCalls(rows, NOW).maturityWindowBasis);
  assert.strictEqual(new Set(cards).size, 4, 'a basis that never varies is an assertion, not a measurement');
});

console.log('\nthe second consumer republishes the gap instead of dropping it:');
t('fenetreAveu carries rugsNonDates, and its empty branch tells a hole from a blank ledger', () => {
  const { fenetreAveu } = require('../lib/prequential');
  const avecTrou = fenetreAveu(maturityWindow([rug('rug_ready', 30, 1), rugBroken('rug_ready', 30, 'negative')]));
  assert.strictEqual(avecTrou.rugsDates, 1);
  assert.strictEqual(avecTrou.rugsNonDates, 1);
  assert.match(avecTrou.note, /n ont AUCUNE duree de vie lisible/);

  const toutIllisible = fenetreAveu(maturityWindow([rugBroken('rug_ready', 30, 'nullRuggedAt')]));
  assert.strictEqual(toutIllisible.rugsDates, 0);
  assert.strictEqual(toutIllisible.rugsNonDates, 1);
  assert.match(toutIllisible.note, /trou de donnees, pas un registre vierge/);

  // the reassuring bound: a genuinely empty ledger keeps the old, correct sentence and no warning
  const vide = fenetreAveu(maturityWindow([live('rug_ready', 30)]));
  assert.strictEqual(vide.rugsNonDates, 0);
  assert.match(vide.note, /aucun rug date/);
  assert.doesNotMatch(vide.note, /trou de donnees/);

  // and a fully dated ledger carries no caveat either
  const propre = fenetreAveu(maturityWindow([rug('rug_ready', 30, 1), rug('rug_ready', 30, 2)]));
  assert.strictEqual(propre.rugsNonDates, 0);
  assert.doesNotMatch(propre.note, /AUCUNE duree de vie lisible/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
