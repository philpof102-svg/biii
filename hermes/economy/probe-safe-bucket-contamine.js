#!/usr/bin/env node
// probe-safe-bucket-contamine.js — le seau SUR du pari le plus fort tient-il sur un artefact ?
// ================================================================================================
// `simulation-et-financeur-lu` est le signal le plus large mesure le 2026-08-05: 1 rug sur 103,
// 88 points d'ecart. Son cote SUR est defini par DEUX lectures positives — `unreadable === 3` (la
// simulation de vente a repondu) ET `siblingCount < 20` (le financeur a ete trace sous le seuil
// industriel).
//
// ⛔ LA SECONDE LECTURE VIENT D'ETRE INVALIDEE PAR LA MESURE D'UN AUTRE. `siblingCount` ne lisait
// qu'UNE page de l'historique du financeur. Une page tient 50 transactions mais le compte porte sur
// les destinataires DISTINCTS: un financeur qui repete ses envois remplissait la page en paraissant
// minuscule. Re-marche sur 42 financeurs reels: 4 -> 56, 11 -> 52, 12 -> 64, 15 -> 41, 6 -> 18.
// Quatre des sept enregistres sous 20 franchissent le seuil une fois lus.
//
// Consequence a verifier ici, et pas a supposer: un token dont le VRAI compte depasse 20 appartient
// au groupe industriel, qui rugge a 93,4 %. S'il en reste dans le seau SUR, le « 1 rug sur 103 » est
// mesure sur une population qui n'est pas celle que la regle croit decrire.
//
// ⛔ LA REGLE ANNONCEE N'EST PAS TOUCHEE. Elle est gelee et notee vers l'avant; on ne corrige pas un
// pari en cours, on mesure ce qu'il vaut vraiment et on le DIT.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

const resolus = rows.filter((t) => issue(t) !== null);
const BASE = resolus.filter((t) => issue(t) === 'rugged').length / resolus.length;

const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const unreadable = (t) => { const b = basis(t); return b ? b.unreadable : undefined; };

/* Le seau SUR tel que la regle gelee le definit. */
const seauSur = rows.filter((t) => unreadable(t) === 3 && typeof t.siblingCount === 'number' && t.siblingCount < 20);

/* ⚠️ TROIS ETATS SUR LA QUALITE DE LA LECTURE, et le troisieme est celui qui compte:
 *   · complete           — traceFeeder a atteint la fin de l'historique
 *   · censuree/plafonnee — la lecture s'est arretee sur une borne, le compte est un PLANCHER
 *   · inconnue           — le drapeau n'existe pas (lignes anterieures a la fonctionnalite) */
function qualite(t) {
  if (t.siblingScanStoppedBy === 'end') return 'complete';
  if (t.siblingScanStoppedBy) return 'plafonnee:' + t.siblingScanStoppedBy;
  if (t.siblingCountCensored === true) return 'censuree';
  if (t.siblingCountCensored === false) return 'complete';
  return 'inconnue';
}

const parQualite = new Map();
for (const t of seauSur) parQualite.set(qualite(t), (parQualite.get(qualite(t)) || 0) + 1);

console.log(`\n  taux de base : ${(BASE * 100).toFixed(1)} %  ·  ${resolus.length} resolus sur ${rows.length}`);
console.log(`  seau SUR de la regle gelee (unreadable=3 ET siblingCount<20) : ${seauSur.length} token(s)\n`);
console.log('  qualite de la lecture du financeur DANS ce seau :');
for (const [q, n] of [...parQualite.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${q.padEnd(22)} ${String(n).padStart(4)}   ${(100 * n / seauSur.length).toFixed(1)} %`);
}

/* Le taux du seau, decoupe par qualite de lecture. Si le « 1 rug sur 103 » se concentre dans les
 * lectures COMPLETES, la regle tient sur les tokens ou sa condition etait vraiment vraie. */
function ligne(nom, g) {
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const s = g.filter((t) => issue(t) === 'survived').length;
  const res = r + s;
  console.log(`    ${nom.padEnd(24)} ${String(g.length).padStart(4)} · ${String(r).padStart(3)} rug · ${String(s).padStart(3)} surv · `
    + `${res ? ((r / res) * 100).toFixed(1).padStart(5) : '  n/a'} %`);
  return { n: g.length, r, res };
}

console.log('\n  issue du seau SUR, par qualite de lecture :');
const completes = seauSur.filter((t) => qualite(t) === 'complete');
const douteuses = seauSur.filter((t) => qualite(t) !== 'complete');
const a = ligne('lecture COMPLETE', completes);
const b = ligne('lecture NON complete', douteuses);

console.log(`\n  ⚠️ ${douteuses.length} token(s) du seau SUR (${(100 * douteuses.length / seauSur.length).toFixed(1)} %) portent un compte qui`);
console.log('     est un PLANCHER, pas une mesure. Leur `< 20` ne prouve rien: le vrai compte peut');
console.log('     depasser le seuil, ce qui les placerait dans le groupe industriel (93,4 % de rugs).');
if (a.res && b.res) {
  const d = ((b.r / b.res) - (a.r / a.res)) * 100;
  console.log(`\n  ecart de taux entre les deux qualites : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  console.log('  ⛔ BORNE: un ecart faible ne LAVE pas le seau — il dit seulement que la contamination');
  console.log('     ne s est pas encore exprimee sur ces effectifs. Seul un re-comptage pagine trancherait.');
}
console.log('');

/* ── LE TEST QUI TRANCHE: la qualite de lecture est-elle SYMETRIQUE de part et d'autre du seuil ? ──
 * Si les lectures censurees atterrissent presque toutes du cote « < 20 » et les completes du cote
 * « >= 20 », alors la regle ne separe pas des financeurs — elle separe des LECTURES REUSSIES de
 * lectures INTERROMPUES. Un compte censure est borne bas PAR CONSTRUCTION, donc il tombe
 * mecaniquement sous le seuil. Ce serait un artefact du processus de mesure, pas un trait du token. */
const seauDanger = rows.filter((t) => unreadable(t) === 3 && typeof t.siblingCount === 'number' && t.siblingCount >= 20);
const q2 = new Map();
for (const t of seauDanger) q2.set(qualite(t), (q2.get(qualite(t)) || 0) + 1);
console.log('  ── de l AUTRE cote du seuil (unreadable=3 ET siblingCount>=20) ──\n');
console.log(`  ${seauDanger.length} token(s), qualite de lecture :`);
for (const [q, n] of [...q2.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${q.padEnd(22)} ${String(n).padStart(4)}   ${(100 * n / seauDanger.length).toFixed(1)} %`);
}
ligne('  issue >= 20', seauDanger);

const censSous = seauSur.filter((t) => qualite(t) !== 'complete').length;
const censSur = seauDanger.filter((t) => qualite(t) !== 'complete').length;
console.log(`\n  censure sous le seuil : ${(100 * censSous / (seauSur.length || 1)).toFixed(1)} %`);
console.log(`  censure au-dessus     : ${(100 * censSur / (seauDanger.length || 1)).toFixed(1)} %`);
console.log('\n  ⛔ Si ces deux taux divergent fortement, la regle trie des LECTURES et non des financeurs.');
console.log('     Un compte censure est borne bas par construction: il ne PEUT pas depasser le seuil.\n');
