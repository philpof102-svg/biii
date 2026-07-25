'use strict';
/**
 * what-survives.js — the inverted question: of everything we watched, what did the survivors have?
 *
 * Predicting which launch will rug has been a failure so far: warnings on 88% of them, strong warnings on
 * none. But the database is now roughly balanced between tokens that died and tokens that did not, which
 * makes the opposite question answerable — and it is a better question commercially, because a buyer does
 * not want a list of things to avoid, they want the one thing that is safe to touch.
 *
 * Compares the two groups on every feature captured AT FIRST SIGHT, so nothing here uses information that
 * only existed after the outcome was known.
 *
 * Read the output as a hypothesis generator, not a finding. With a sample this size a feature can separate
 * the groups perfectly by chance, and any rule taken from here must still be replayed by
 * backtest-weighting.js before it goes anywhere near a verdict — that is exactly how the last confident
 * rule died.
 *
 * FIRST RESULT, AND IT KILLED ITS OWN BEST CANDIDATE. The medians looked decisive: $11.6k of initial
 * liquidity among the rugs against $43.2k among the survivors, with a mechanism to match — seeded liquidity
 * is what a rug must spend to run, so a large seed is a poor return on a disposable launch. Sweeping a
 * threshold across both groups gave at best 5/8 rugs against 3/8 survivors, barely distinguishable from
 * chance. The raw values show why:
 *
 *   rugged    8124, 9341, 10533, 11592, 11605, 56804, 58231, 479678
 *   survived  7709, 9346, 9945, 18443, 43162, 45190, 56940, 61794
 *
 * They overlap almost entirely. The rugs are BIMODAL — five small launches and three large ones — and the
 * median, whose whole virtue is resisting extreme values, hid exactly the structure that mattered. On eight
 * points the summary statistic was the mistake; reading the list took seconds and settled it.
 *
 * So the honest state of this analysis: nothing in the captured features separates the two groups yet. That
 * is a real finding, and a more useful one than a fabricated signal — it says the radar is currently a
 * RECORDER rather than a predictor, and that its value is the accumulating evidence base, not its verdicts.
 * Anything printed below is a candidate for the next replay, nothing more.
 */
const path = require('node:path');
const db = require(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));

const all = Object.entries(db).map(([addr, t]) => ({ addr, ...t }));
const dead = all.filter((t) => t.outcome === 'rugged');
const alive = all.filter((t) => t.outcome === 'live');

const liveFlags = (t) => (t.flagsAtFirstSight || []).filter((f) => !/^\(defused/i.test(f));
const holdersOf = (t) => {
  const m = liveFlags(t).map((f) => f.match(/only (\d+) holders/)).find(Boolean);
  return m ? Number(m[1]) : null;
};
const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';
const med = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

function compare(label, fn, fmt = (v) => String(v)) {
  const d = dead.map(fn), a = alive.map(fn);
  const both = [d, a].map((xs) => typeof xs[0] === 'boolean'
    ? pct(xs.filter(Boolean).length, xs.length)
    : fmt(med(xs)));
  const mark = both[0] !== both[1] ? ' ←' : '';
  console.log('  ' + label.padEnd(34) + String(both[0]).padStart(10) + '   ' + String(both[1]).padStart(10) + mark);
}

console.log('== what separates the ' + alive.length + ' survivors from the ' + dead.length + ' that died ==\n');
console.log('  ' + 'feature'.padEnd(34) + '     RUGGED' + '      ALIVE');
console.log('  ' + '-'.repeat(58));

compare('initial liquidity (median)', (t) => Math.round(t.firstLiq || 0), (v) => v == null ? '—' : '$' + v.toLocaleString('en-US'));
compare('live flags at first sight', (t) => liveFlags(t).length);
compare('pool withdrawable', (t) => liveFlags(t).some((f) => /liquidity is locked or burned/i.test(f)));
compare('too few holders flagged', (t) => liveFlags(t).some((f) => /only \d+ holders/i.test(f)));
compare('holder count when known', (t) => holdersOf(t));
compare('had NO security data at all', (t) => t.firstVerdict === 'unknown');
compare('deployer identifiable', (t) => !!t.deployer);
compare('funded by a launch factory', (t) => (t.siblingCount || 0) >= 5);
compare('deployer wallet was single-use', (t) => t.freshDeployer === true);
compare('found via paid promotion', (t) => t.source === 'boosted');

console.log('\n== the survivors, one by one ==');
for (const t of alive.sort((x, y) => (y.lastLiq || 0) - (x.lastLiq || 0))) {
  const growth = t.firstLiq > 0 ? Math.round(((t.lastLiq - t.firstLiq) / t.firstLiq) * 100) : 0;
  console.log('  ' + String(t.sym || '?').padEnd(22) +
    ('$' + Math.round(t.firstLiq).toLocaleString('en-US')).padStart(10) + ' → ' +
    ('$' + Math.round(t.lastLiq).toLocaleString('en-US')).padStart(10) +
    (growth > 0 ? '  +' + growth + '%' : '  ' + growth + '%').padStart(9) +
    '  | ' + (t.rejudgedVerdict || t.firstVerdict) +
    (t.siblingCount >= 5 ? ' | factory-funded' : '') +
    (t.deployer ? '' : ' | deployer unknown'));
}

console.log('\n  Hypotheses only. A feature can separate ' + dead.length + ' from ' + alive.length + ' by pure chance.');
console.log('  Anything promising goes through backtest-weighting.js before it touches a verdict.');
