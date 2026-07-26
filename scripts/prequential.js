#!/usr/bin/env node
'use strict';
/**
 * prequential.js — re-run every forward-looking claim we make, against the live database.
 * =======================================================================================
 * A result nobody can recompute is not a result. Both signals this project still relies on were established
 * in a throwaway script during one session, and would have died with it — so they live here, run on demand,
 * and are expected to MOVE as data accumulates. A number that only ever goes up is a number nobody is
 * checking.
 *
 *   node scripts/prequential.js
 *
 * Two claims, one protocol. Each token is judged using only history strictly earlier than itself, so no
 * prediction can have seen its own outcome. The maturity window is the p95 of observed rug lifetimes, not the
 * maximum — a maximum lets one slow rug widen the window enough to reclassify our own false alarms as "still
 * open", which happened, and lifted precision from 0.93 to 1.00 without a single call improving.
 *
 * The independence columns are not decoration. They are what separated a real signal from noise twice: the
 * symbol-impersonation rule looked fine until five HBULL relaunches turned out to be one funder wearing a
 * costume, and the seed band still looks excellent while two thirds of its safe bucket has no attribution at
 * all. Read `funders` and `untraced` before believing `rate`.
 */

const path = require('node:path');
const fs = require('node:fs');
const FUNDER = require('../lib/funder-registry');
const SEED = require('../lib/seed-band');

const DB = process.argv[2] || path.join(__dirname, '..', 'data', 'token-radar', 'tokens.json');

let raw;
try { raw = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.error('cannot read ' + DB + ' — ' + e.message); process.exit(1); }

const rows = Object.entries(raw).map(([address, t]) => ({ address, ...t })).filter((r) => r.firstSeen);
if (!rows.length) { console.error('the database is empty; nothing to replay'); process.exit(1); }

const now = Math.max(...rows.map((r) => Date.parse(r.lastSeen) || 0));
const lifetimes = rows.filter((r) => r.outcome === 'rugged')
  .map((r) => (Date.parse(r.ruggedAt) - Date.parse(r.firstSeen)) / 3600000)
  .filter((h) => Number.isFinite(h) && h >= 0).sort((a, b) => a - b);
if (!lifetimes.length) { console.error('no dated rug yet — there is no maturity window to derive'); process.exit(1); }
const q = (s, p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
const W = Math.max(1, Math.ceil(q(lifetimes, 0.95)));
const slowest = lifetimes[lifetimes.length - 1];

/** Resolved, open, or rugged — the same rule the scorecard uses, so the two never disagree. */
const resolve = (r) => (r.outcome === 'rugged' ? 'rugged'
  : ((now - Date.parse(r.firstSeen)) / 3600000 >= W ? 'survived' : 'open'));

const span = (now - Math.min(...rows.map((r) => Date.parse(r.firstSeen)))) / 3600000;
console.log('database  ' + rows.length + ' tokens over ' + span.toFixed(1) + 'h · newest ' + new Date(now).toISOString());
console.log('window    ' + W + 'h (p95 of ' + lifetimes.length + ' dated rugs; slowest ever ' + slowest.toFixed(1) + 'h)');
console.log('           ' + lifetimes.filter((h) => h > W).length + ' rug(s) landed beyond it, so that share of'
  + ' our "false alarms" are slow catches.\n');

const pct = (x) => (x == null ? '  n/a' : (100 * x).toFixed(0) + '%');
function table(title, buckets, base, note) {
  console.log('=== ' + title + ' ===');
  console.log('  ' + 'judged on prior history only'.padEnd(30) + 'rug  surv   open   rate   vs base  operators  untraced');
  for (const [label, b] of buckets) {
    const lift = b.rate == null || base == null ? null : b.rate - base;
    console.log('  ' + label.padEnd(30) + String(b.rugged).padStart(3) + String(b.survived).padStart(6) +
      String(b.open == null ? '-' : b.open).padStart(7) + pct(b.rate).padStart(7) +
      (lift == null ? '      n/a' : ((lift >= 0 ? '+' : '') + (100 * lift).toFixed(0) + ' pts').padStart(9)) +
      String(b.distinctFunders == null ? '-' : b.distinctFunders).padStart(11) +
      String(b.untraced == null ? '-' : b.untraced).padStart(10));
  }
  console.log('  base rate ' + pct(base) + '\n  ' + note + '\n');
}

// ── claim 1: has this payer already killed? ───────────────────────────────────
const f = FUNDER.replay(rows, resolve);
table('FUNDER — has the wallet that paid already killed one?', [
  ['funder had already killed', f.funder_has_killed],
  ['funder known, no prior rug', f.funder_clean_so_far],
  ['funder never seen', f.funder_unseen],
  ['funder not traceable', f.funder_untraceable],
], f.baseRate,
'SHIPPED as till_funder_history. Evadable for the price of one fresh funding wallet — it makes REUSE\n  '
+ 'expensive, which is what a high-volume operation actually does. Expect the strong bucket to decay as\n  '
+ 'operators adapt; that decay is a result to record, not a failure.');

// ── claim 2: is there a seed size that survives? ──────────────────────────────
const s = SEED.replay(rows, resolve);
table('SEED BAND — does initial liquidity predict survival?', [
  ['safest prior band', s.safest_prior_band],
  ['riskiest prior band', s.riskiest_prior_band],
  ['between the two', s.between],
], s.baseRate,
'NOT SHIPPED. The forward result is strong, but read the operator and untraced columns: if most of the\n  '
+ 'safe bucket has no attribution, this may be the funder signal seen from another angle rather than a\n  '
+ 'second one. Answerable once the raised trace budget has attributed a day of launches.');
console.log('  ' + s.predictions + ' prediction(s) made, warm-up ' + s.warmup
  + (s.noBands ? ', ' + s.noBands + ' skipped for want of enough history to draw bands' : '') + '\n');

console.log('Both numbers are expected to move. If they never do, nobody is running this.');
