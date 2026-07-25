'use strict';
/**
 * backtest-weighting.js — would the new escalation rule have fired on the rugs we already watched die?
 *
 * The radar reported warnings on 88% of observed rugs but STRONG warnings on none, so an escalation was
 * added: a withdrawable pool plus any second flag now reads high_risk. The honest objection to shipping that
 * is obvious — it was written after looking at the failures it is meant to fix, which is how overfitting
 * starts. Waiting hours for fresh tokens would answer it eventually; replaying the rule against the flags
 * captured AT FIRST SIGHT answers it now, and against the same evidence the live verdict actually had.
 *
 * It is scored on both sides on purpose. A rule that catches every rug by escalating everything has not
 * improved anything, so the still-alive tokens are run through it too: catching more rugs only counts if the
 * survivors do not light up as well.
 *
 * Small-sample caveat, stated because the number will look better than it is: this is a handful of tokens
 * from a single evening on one chain. It can show a rule is broken. It cannot show a rule is good.
 */
const path = require('node:path');
const db = require(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));

const isPoolFlag = (f) => /liquidity is locked or burned/i.test(f);

/** Replay the current verdict logic over stored evidence, without re-querying anything. */
function replay(t) {
  const armed = t.armedAtFirstSight || [];
  // Flags recorded before the split are a mix of live and defused ones; the defused carry their own prefix,
  // so they can be separated retrospectively exactly as the live code now separates them.
  const raw = t.flagsAtFirstSight || [];
  const flags = raw.filter((f) => !/^\(defused by renounced ownership\)/i.test(f));
  const pullable = flags.some(isPoolFlag);

  if (armed.length) return 'rug_ready';
  if (flags.length >= 3) return 'high_risk';
  if (pullable && flags.length >= 2) return 'high_risk';
  if (flags.length) return 'caution';
  return t.firstVerdict === 'unknown' ? 'unknown' : 'clean';
}

const all = Object.entries(db).map(([addr, t]) => ({ addr, ...t }));
const rugged = all.filter((t) => t.outcome === 'rugged');
const alive = all.filter((t) => t.outcome === 'live');

const strong = (v) => v === 'rug_ready' || v === 'high_risk';

console.log('== replaying the new weighting against tokens whose outcome is already known ==\n');

console.log('RUGS (' + rugged.length + ') — did the rule turn a quiet warning into an actionable one?');
let gained = 0;
for (const t of rugged) {
  const now = replay(t);
  const changed = now !== t.firstVerdict;
  if (strong(now) && !strong(t.firstVerdict)) gained++;
  const flags = (t.flagsAtFirstSight || []).filter((f) => !/^\(defused/i.test(f));
  console.log('  ' + (strong(now) ? '✅' : '  ') + ' ' + String(t.sym || '?').padEnd(14) +
    t.firstVerdict.padEnd(10) + (changed ? '→ ' + now : '(unchanged)').padEnd(14) +
    '| ' + flags.length + ' live flag(s)' + (flags.some(isPoolFlag) ? ', pool withdrawable' : ''));
}

console.log('\nSTILL ALIVE (' + alive.length + ') — does it light them up too? (that would make it useless)');
let falseAlarms = 0;
for (const t of alive) {
  const now = replay(t);
  if (strong(now)) falseAlarms++;
  const flags = (t.flagsAtFirstSight || []).filter((f) => !/^\(defused/i.test(f));
  console.log('  ' + (strong(now) ? '⚠️' : '  ') + ' ' + String(t.sym || '?').padEnd(14) +
    t.firstVerdict.padEnd(10) + (now !== t.firstVerdict ? '→ ' + now : '(unchanged)').padEnd(14) +
    '| ' + flags.length + ' live flag(s)');
}

const before = rugged.filter((t) => strong(t.firstVerdict)).length;
const after = rugged.filter((t) => strong(replay(t))).length;
console.log('\n== verdict on the rule ==');
console.log('  strong warnings on rugs : ' + before + '/' + rugged.length + '  ->  ' + after + '/' + rugged.length + (gained ? '  (+' + gained + ')' : ''));
console.log('  survivors escalated     : ' + falseAlarms + '/' + alive.length + (falseAlarms ? '  <- each one is a cost' : '  (none)'));
console.log('\n  Small sample, one chain, one evening. This can show a rule is broken; it cannot show it is good.');
