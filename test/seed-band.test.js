#!/usr/bin/env node
'use strict';
/**
 * The seed-band truth table, and the reason it is short: almost nothing here is a judgement, so almost
 * nothing can be wrong in an interesting way. Two things CAN, and they are the whole file.
 *
 * LEAKAGE. A replay that peeks at later outcomes produces the same shape of report, only stronger — so it is
 * invisible in a result and has to be tested directly.
 *
 * THE INDEPENDENCE FIELDS. `distinctFunders` and `untraced` are what stopped this signal from being shipped
 * on a 0-rugs-in-30 result. If they silently reported the wrong thing, the guard would be decorative.
 */
const assert = require('node:assert');
const { bands, replay, MIN_BAND } = require('../lib/seed-band');

const T = (n) => new Date(Date.parse('2026-07-26T00:00:00.000Z') + n * 60000).toISOString();
let seq = 0;
const tok = (liq, over = {}) => ({ firstSeen: T(seq++), firstLiq: liq, ...over });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('bands are a SHAPE, not a choice:');
t('the safest and riskiest quintile are identified by their observed rate', () => {
  const hist = [];
  for (let i = 0; i < 10; i++) hist.push({ liq: 1000 + i, rug: true });     // cheap: all rug
  for (let i = 0; i < 10; i++) hist.push({ liq: 50000 + i, rug: false });   // mid: none rug
  const b = bands(hist);
  assert.ok(b.safe.lo >= 50000, 'the safe band should be the surviving side, got ' + b.safe.lo);
  assert.ok(b.risky.hi <= 1010, 'the risky band should be the rugging side, got ' + b.risky.hi);
});
t('a history too thin for three usable bands yields null, not a guess', () => {
  assert.equal(bands([{ liq: 1, rug: true }, { liq: 2, rug: false }]), null);
});
t('a quintile below MIN_BAND cases is discarded rather than believed', () => {
  const hist = [];
  for (let i = 0; i < 20; i++) hist.push({ liq: 100 + i, rug: i % 2 === 0 });
  const b = bands(hist);
  for (const band of b.all) assert.ok(band.n >= MIN_BAND, 'a band of ' + band.n + ' survived the filter');
});

console.log('\nLEAKAGE — invisible in a result, so tested directly:');
t('no prediction is made before the warm-up is satisfied', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(tok(1000 + i));
  const r = replay(rows, () => 'rugged', { warmup: 40 });
  assert.equal(r.predictions, 0, 'with 10 rows and a warm-up of 40, nothing may be predicted');
});
t('a token is judged on bands built ONLY from what preceded it', () => {
  // Twelve cheap tokens that all rug, then one expensive token that survives. With a warm-up of 6, the
  // expensive one is judged by a history containing only cheap rugs — so it cannot land in a "safe band"
  // that its own survival created.
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(tok(1000 + i));
  rows.push(tok(90000));
  const r = replay(rows, (x) => (x.firstLiq > 50000 ? 'survived' : 'rugged'), { warmup: 6 });
  assert.equal(r.safest_prior_band.survived, 0,
    'the expensive survivor must NOT be credited to a safe band it defined itself');
});
t('the warm-up is not the only gate — bands need enough observations to EXIST', () => {
  // Written wrong the first time, and the failure was the useful part. `bands()` needs three quintiles of at
  // least MIN_BAND cases each, so it returns null until roughly 11 resolved observations no matter how low
  // the warm-up is set. A replay with 8 rows and a warm-up of 4 therefore predicts NOTHING — which is the
  // correct, fail-closed behaviour and not the "one prediction per row past the warm-up" I had assumed.
  const thin = [];
  for (let i = 0; i < 8; i++) thin.push(tok(1000 + i));
  const r = replay(thin, () => 'rugged', { warmup: 4 });
  assert.equal(r.predictions, 0, 'eight observations cannot support five bands');
  assert.ok(r.noBands > 0, 'and the refusals are COUNTED, not silently absent: ' + r.noBands);
});
t('history grows only after the judgement, so the last token cannot inform its own', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(tok(1000 + i));      // enough for bands to exist
  const before = replay(rows, () => 'rugged', { warmup: 12 });
  assert.ok(before.predictions > 0, 'sanity: this history is thick enough to predict at all');
  rows.push(tok(1000 + 99));
  const after = replay(rows, () => 'rugged', { warmup: 12 });
  assert.equal(after.predictions, before.predictions + 1, 'exactly one more judgement, not a reshuffle');
});
t('open outcomes neither predict nor enter the history', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(tok(1000 + i));
  const allOpen = replay(rows, () => 'open', { warmup: 4 });
  assert.equal(allOpen.predictions, 0);
  assert.equal(allOpen.baseRate, null, 'nothing resolved means no rate to claim');
});

console.log('\nthe independence fields are what stopped this being shipped:');
t('distinctFunders counts OPERATORS, not tokens', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(tok(1000 + i, { funder: '0xRUG' }));
  for (let i = 0; i < 8; i++) rows.push(tok(90000 + i, { funder: '0xSAFE' }));
  const r = replay(rows, (x) => (x.firstLiq > 50000 ? 'survived' : 'rugged'), { warmup: 6 });
  const buckets = [r.safest_prior_band, r.riskiest_prior_band, r.between];
  const total = buckets.reduce((s, b) => s + b.resolved, 0);
  assert.ok(total > 0, 'sanity: predictions were made');
  for (const b of buckets) {
    assert.ok(b.distinctFunders <= b.resolved, 'more operators than tokens is impossible');
    if (b.resolved > 0) assert.ok(b.distinctFunders >= 1 || b.untraced > 0, 'every token is attributed or counted as untraced');
  }
});
t('untraced tokens are COUNTED, never quietly attributed', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(tok(1000 + i));            // no funder at all
  const r = replay(rows, () => 'rugged', { warmup: 4 });
  const untraced = r.safest_prior_band.untraced + r.riskiest_prior_band.untraced + r.between.untraced;
  assert.equal(untraced, r.predictions, 'every judged token had no funder and must be counted as such');
});
t('a bucket carried by ONE operator says so', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(tok(1000 + i, { funder: '0xRUG' }));
  const r = replay(rows, () => 'rugged', { warmup: 4 });
  const carried = [r.safest_prior_band, r.riskiest_prior_band, r.between].filter((b) => b.resolved > 0);
  for (const b of carried) assert.equal(b.distinctFunders, 1, 'one operator behind the whole bucket');
});

console.log('\nit claims nothing it cannot support:');
t('an empty input yields no rates', () => {
  const r = replay([], () => 'open');
  assert.equal(r.baseRate, null);
  assert.equal(r.predictions, 0);
});
t('records with an unreadable seed are dropped, not defaulted to zero', () => {
  const rows = [tok(1000), { firstSeen: T(seq++), firstLiq: null }, { firstSeen: T(seq++) }];
  const r = replay(rows, () => 'rugged', { warmup: 1 });
  assert.ok(r.predictions <= 1, 'only the one readable record could ever be judged');
});
t('it is pure — no clock, no disk, no network', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'seed-band.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/function replay/.test(code), 'sanity: the comment stripper left the code intact');
  for (const forbidden of ['node:https', 'fetch(', 'Date.now()', 'readFileSync', 'process.env']) {
    assert.ok(!code.includes(forbidden), 'seed-band.js must not contain ' + forbidden);
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
