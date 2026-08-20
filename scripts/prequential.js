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
// ⛔ LA REGLE D'ISSUE VIENT DU CANONIQUE, elle ne se reecrit pas ici. Voir `resolve` plus bas :
// ce fichier en portait une COPIE, restee sur la version d'avant le correctif du 2026-08-05.
const { outcomeKnownAt } = require('../lib/prequential');

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

/* Resolved, open, or rugged — la MEME regle que le scorecard, et cette fois c'est vrai.
 * =====================================================================================
 * ⛔ CE COMMENTAIRE MENTAIT. Il disait deja « the same rule the scorecard uses, so the two never
 * disagree », au-dessus d'une COPIE de la regle restee a la version d'avant le correctif du
 * 2026-08-05. La copie testait l'age depuis la PREMIERE vue :
 *
 *     (now - firstSeen) / 3600000 >= W ? 'survived' : 'open'
 *
 * Le canonique (`lib/prequential.js:outcomeKnownAt`) exige `min(lastSeen, t) - firstSeen >= W` :
 * il ne suffit pas que le token ait VIEILLI, il faut l'avoir VU VIVANT a cet age. La difference
 * n'est pas theorique — `token-radar.js` fait `if (liq == null) continue;` sans regrader, donc un
 * pool entierement retire (le rug le plus complet qui soit) GELE sa ligne, `lastSeen` cesse
 * d'avancer, et le token vieillit tranquillement en « survivant ».
 *
 * MESURE sur la base reelle (3 212 tokens, W = 14 h, releve du 2026-08-20) :
 *
 *                        copie locale      canonique
 *     survived                    857            530
 *     open                         63            390
 *     baseRate                  0.728          0.812
 *
 *   · 327 lignes sur 3 212 en desaccord ;
 *   · 675 des 920 tokens 'live' n'avaient pas ete relus depuis plus de 24 h, 550 depuis plus de
 *     7 jours — et la copie les comptait tous comme survivants.
 *
 * Le LIFT survit (c'est ce qui compte pour le signal), mais chaque taux ABSOLU bougeait de ~8
 * points. ⚠️ Les taux figes dans `lib/announced-rules.js` (baseRate 0.753) ont ete produits par
 * l'ancienne regle : ils ne sont PAS corriges ici — ce fichier est gele par convention, et
 * requalifier un pari annonce apres coup est une decision humaine, pas un correctif.
 */
const resolve = (r) => outcomeKnownAt(r, now, W) || 'open';

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
