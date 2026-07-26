'use strict';
/**
 * verdict-precision.js — is each verdict better than guessing? The only question that matters.
 *
 * A scanner can warn on 98% of rugs and still be worthless, because warning on everything achieves that
 * trivially. The measure that counts is per-verdict PRECISION against the base rate: of the tokens we called
 * X, how many actually rugged, and is that better than the rate across all tokens?
 *
 * Written after a mistake made in the space of three minutes. Two tokens flagged rug_ready rugged, and that
 * was reported as the impostor check working. Counting the whole bucket instead of the wins showed rug_ready
 * at 2/5 — eighteen points BELOW the base rate. Seeing hits and forgetting to count the misses is the same
 * error as overfitting, arriving faster.
 *
 * Read the lift column, not the percentage. And read N before either: a bucket of two is noise no matter how
 * clean it looks.
 */
const path = require('node:path');
const db = require(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));

const all = Object.values(db);
const settled = all.filter((t) => t.outcome === 'rugged' || t.outcome === 'live');
const base = settled.length ? settled.filter((t) => t.outcome === 'rugged').length / settled.length : 0;
const pc = (x) => Math.round(x * 100) + '%';

console.log('== per-verdict precision, ' + settled.length + ' tokens with a settled outcome ==\n');
console.log('  base rate: ' + pc(base) + ' of all tracked tokens rugged\n');
console.log('  verdict      rugs/total     rate    lift     read');
console.log('  ' + '-'.repeat(62));

for (const v of ['rug_ready', 'high_risk', 'caution', 'unknown', 'clean']) {
  const g = settled.filter((t) => t.firstVerdict === v);
  if (!g.length) continue;
  const r = g.filter((t) => t.outcome === 'rugged').length;
  const p = r / g.length;
  const lift = Math.round((p - base) * 100);
  // A verdict meant to warn is useful when it rugs MORE than the base rate. `unknown` and `clean` are the
  // reverse: they are useful when they rug LESS. Judging them all in one direction would mislabel the most
  // interesting result in the table.
  const wantsHigh = v === 'rug_ready' || v === 'high_risk' || v === 'caution';
  const good = wantsHigh ? lift > 0 : lift < 0;
  const small = g.length < 10 ? '  (N too small to trust)' : '';
  console.log('  ' + v.padEnd(12) + (r + '/' + g.length).padEnd(14) + pc(p).padEnd(8) +
    ((lift > 0 ? '+' : '') + lift + 'pt').padEnd(9) + (good ? 'as intended' : 'NOT better than guessing') + small);
}

console.log('\n== what this says today ==');
const unk = settled.filter((t) => t.firstVerdict === 'unknown');
if (unk.length) {
  const ur = unk.filter((t) => t.outcome === 'rugged').length / unk.length;
  console.log('  The strongest separator in the whole dataset is `unknown`, at ' + pc(ur) + ' against a ' +
    pc(base) + ' base — and it predicts SURVIVAL, the opposite of what fail-closed intuition expects.');
  console.log('  Plausible mechanism: no security record often means a plain contract from a standard factory,');
  console.log('  which nobody bothered to booby-trap. Reported, deliberately NOT encoded: telling a buyer that');
  console.log('  missing data means safe, on ' + unk.length + ' samples, would be reckless and is exactly the');
  console.log('  overfitting that killed three rules already.');
}
console.log('\n  Warning on 98% of rugs is trivial — warn on everything and you get it. Precision is the test.');
