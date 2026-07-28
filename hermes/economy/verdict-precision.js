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

/* L'instant d'ou sortent ces chiffres, imprime meme quand personne ne le demande: `tokens.json` est
 * ecrit par le radar en continu (570 lignes a 14h25 le 2026-07-28, 579 a 14h28). Une precision d'ici
 * n'est comparable qu'a une autre du MEME instantane — et on ne pense a verifier le mtime que si on
 * l'a sous les yeux. */
const instantane = require('node:fs').statSync(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));
console.log('== per-verdict precision, ' + settled.length + ' tokens with a settled outcome ==');
console.log('   instantané ' + instantane.mtime.toISOString() + ' — comparable seulement à un chiffre du même instant\n');
console.log('  base rate: ' + pc(base) + ' of all tracked tokens rugged\n');
console.log('  verdict      rugs/total     rate    lift     read');
console.log('  ' + '-'.repeat(62));

/* La liste est EN DUR, et le taux de base compte tout le monde: un verdict qui n'y figure pas disparait
 * du tableau pendant qu'il pese sur la reference a laquelle le tableau se compare. Mesure du 2026-07-28:
 * 0 invisible sur 579 — le defaut est LATENT, pas actif, et il le restera tant que personne n'ajoutera
 * une valeur de verdict. C'est exactement le moment ou un garde coute deux lignes. */
const VERDICTS = ['rug_ready', 'high_risk', 'caution', 'unknown', 'clean'];
const invisibles = settled.filter((t) => !VERDICTS.includes(t.firstVerdict));
for (const v of VERDICTS) {
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

if (invisibles.length) {
  const vus = [...new Set(invisibles.map((t) => String(t.firstVerdict)))].join(', ');
  console.log('\n  ⚠️ ' + invisibles.length + ' token(s) ABSENTS du tableau ci-dessus (verdicts inconnus: ' + vus + ').');
  console.log('     Ils comptent dans le taux de base mais n\'ont aucune ligne: le tableau ne se somme plus.');
  console.log('     Ajoutez la valeur à VERDICTS, ou le lift se lit contre une référence qu\'il ne couvre pas.');
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
