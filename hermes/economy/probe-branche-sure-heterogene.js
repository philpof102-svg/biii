#!/usr/bin/env node
// probe-branche-sure-heterogene.js — la branche « sur » de `funder-20` melange deux populations.
// ================================================================================================
// La courbe mesuree le 2026-08-09 n'est pas monotone: sous le seuil de vingt, la bande 5-19 rugge a
// 15,6 % par token pendant que la bande 1-4 rugge a 63,5 %. Quarante-huit points d'ecart A L'INTERIEUR
// de ce que la regle vivante appelle « sur », et rien dans le depot ne les distingue.
//
// « Moins de freres » n'est donc PAS « plus sur »: c'est la bande INTERMEDIAIRE qui est la plus sure,
// et la plus basse qui est dangereuse. Un acheteur qui lit « financeur sous le seuil » lit une moyenne
// entre deux choses opposees.
//
// ⛔ ET LE SENS DE LA CENSURE JOUE CONTRE L'OBSERVATION, ce qui la renforce. `siblingCount` est un
// PLANCHER quand la lecture s'est arretee sur une borne: un financeur a 300 freres lu a 15 atterrit
// dans 5-19 et y APPORTE son taux eleve. La bande 5-19 paraitrait donc PIRE qu'elle n'est — et elle est
// deja la meilleure. Cette sonde le verifie en refaisant la courbe sur les seules lectures COMPLETES.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: l'ecart entre les deux sous-bandes, avec bornes, et s'il survit au
// filtrage des lectures censurees, a la liquidite, et au comptage par operateur.
// ⛔ CE QU'ELLE NE PEUT PAS: proposer un seuil. Ce depot ecrit que balayer des seuils et garder le
// meilleur a tue deux regles; une bande qui separe aujourd'hui doit etre ANNONCEE puis notee vers
// l'avant pour valoir quelque chose.
// ⛔ ELLE NE PROMEUT RIEN et n'imprime aucune adresse.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, quantile, MIN_RESOLUS } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU(' + p.effectif + ')' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* La branche « sur » de la regle vivante: `siblingCount` LU et strictement sous le seuil. */
const sousSeuil = rows.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL
  && issue(t) !== null);
const bas = (t) => t.siblingCount <= 4;
const haut = (t) => t.siblingCount >= 5;

function mesure(g) {
  const rug = g.filter((t) => issue(t) === 'rugged').length;
  const parF = new Map();
  for (const t of g) {
    const f = fnd(t); if (!f) continue;
    if (!parF.has(f)) parF.set(f, { n: 0, r: 0 });
    const e = parF.get(f); e.n++; if (issue(t) === 'rugged') e.r++;
  }
  const moyenne = parF.size ? [...parF.values()].reduce((s, e) => s + e.r / e.n, 0) / parF.size : null;
  return { res: g.length, rug, fN: parF.size, moyenne,
    brut: proportionAvecBornes(rug, g.length),
    tirage: proportionAvecBornes(rug, g.length, { effectif: parF.size, plancher: MIN_RESOLUS }) };
}

console.log('\n  ── CE QUE LA REGLE VIVANTE APPELLE « SUR » ──\n');
const tout = mesure(sousSeuil);
console.log('    branche « sur » entiere (siblingCount < ' + SEUIL + ')   ' + tout.rug + '/' + tout.res
  + '   ' + ic(tout.brut) + '   ' + tout.fN + ' financeur(s)');
const A = mesure(sousSeuil.filter(bas)), B = mesure(sousSeuil.filter(haut));
if (!A.res || !B.res) {
  console.log('\n  ⛔ Une des deux sous-bandes est vide: rien a comparer.');
  process.exit(0);
}
console.log('\n    sous-bande        res    rug   taux par token           fin.  par tirage');
console.log('    ' + '-'.repeat(92));
console.log('    1-4 freres  ' + String(A.res).padStart(9) + String(A.rug).padStart(7) + '   '
  + ic(A.brut).padEnd(24) + String(A.fN).padStart(5) + '  ' + ic(A.tirage));
console.log('    5-19 freres ' + String(B.res).padStart(9) + String(B.rug).padStart(7) + '   '
  + ic(B.brut).padEnd(24) + String(B.fN).padStart(5) + '  ' + ic(B.tirage));
const d = 100 * (A.brut.taux - B.brut.taux);
console.log('\n    ecart 1-4 contre 5-19 : ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
  + (disjoints(A.brut, B.brut) ? '💎 DISJOINTS — la branche « sur » n est PAS homogene'
    : '⚠️ chevauchants — l heterogeneite n est pas etablie'));

/* ── LE CONTROLE QUI COMPTE: LA CENSURE JOUE-T-ELLE CONTRE OU POUR ? ─────────────────────────────── */
console.log('\n  ── SUR LES SEULES LECTURES COMPLETES (censure retiree) ──\n');
const complets = sousSeuil.filter((t) => t.siblingCountCensored === false);
const dispo = rows.filter((t) => t.siblingCountCensored !== undefined).length;
if (!dispo) {
  console.log('    ⛔ `siblingCountCensored` absent partout: ce controle ne se fait pas, et son absence');
  console.log('       est dite plutot que comblee par le chiffre precedent.');
} else if (!complets.length) {
  console.log('    ⛔ aucune lecture complete sous le seuil: rien a verifier.');
} else {
  const Ac = mesure(complets.filter(bas)), Bc = mesure(complets.filter(haut));
  for (const [nom, m] of [['1-4 freres ', Ac], ['5-19 freres', Bc]]) {
    console.log('    ' + nom + String(m.res).padStart(9) + String(m.rug).padStart(7) + '   '
      + ic(m.brut).padEnd(24) + String(m.fN).padStart(5) + '  ' + ic(m.tirage));
  }
  if (Ac.res && Bc.res) {
    const dc = 100 * (Ac.brut.taux - Bc.brut.taux);
    console.log('\n    ecart : ' + (dc >= 0 ? '+' : '') + dc.toFixed(1) + ' pts   '
      + (disjoints(Ac.brut, Bc.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants'));
    console.log('\n  ⚠️ LE SENS DE LA CENSURE EST CONNU ET IL JOUE CONTRE L OBSERVATION: un financeur a 300');
    console.log('     freres lu a 15 atterrit dans 5-19 et y APPORTE son taux eleve. La bande 5-19 paraissait');
    console.log('     donc PIRE qu elle n est. Si l ecart GRANDIT ici, c est la contamination qui partait.');
  }
}

/* ── ET A LIQUIDITE COMPARABLE, PARCE QUE C EST LE CONFONDANT DE TOUJOURS ────────────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
console.log('\n  ── A LIQUIDITE COMPARABLE ──\n');
console.log('    strate            1-4 freres               5-19 freres              ecart');
console.log('    ' + '-'.repeat(92));
let tient = 0, testees = 0;
for (const [nom, pred] of [['basse  ', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2],
  ['haute  ', (l) => l >= q2]]) {
  const dans = (t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq);
  const a = mesure(sousSeuil.filter((t) => dans(t) && bas(t)));
  const b = mesure(sousSeuil.filter((t) => dans(t) && haut(t)));
  if (!a.res || !b.res) { console.log('    ' + nom + '           ⛔ une sous-bande vide'); continue; }
  testees++;
  const dd = 100 * (a.brut.taux - b.brut.taux);
  if (disjoints(a.brut, b.brut)) tient++;
  console.log('    ' + nom + '   ' + (a.rug + '/' + a.res + ' ' + ic(a.brut)).padEnd(25)
    + (b.rug + '/' + b.res + ' ' + ic(b.brut)).padEnd(25)
    + (dd >= 0 ? '+' : '') + dd.toFixed(1) + ' pts ' + (disjoints(a.brut, b.brut) ? '💎' : '⚠️'));
}
console.log('\n    strates ou l ecart est ETABLI: ' + tient + ' sur ' + testees);

/* ── ET PAR OPERATEUR, PARCE QUE C EST L UNITE QUI A DEJA RETOURNE UN CHIFFRE AUJOURD HUI ────────── */
console.log('\n  ── UN OPERATEUR, UNE VOIX ──\n');
console.log('    1-4 freres   moyenne non ponderee ' + pct(A.moyenne) + '  sur ' + A.fN + ' financeur(s)');
console.log('    5-19 freres  moyenne non ponderee ' + pct(B.moyenne) + '  sur ' + B.fN + ' financeur(s)');
if (A.moyenne !== null && B.moyenne !== null) {
  const dOp = 100 * (A.moyenne - B.moyenne);
  console.log('    ecart non pondere ' + (dOp >= 0 ? '+' : '') + dOp.toFixed(1) + ' pts   contre '
    + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts par token');
}
console.log('  ⚠️ Et le piege du matin: si un cote est fait de financeurs a UN SEUL token, sa « moyenne par');
console.log('     financeur » n est que l issue de ce token. Compter les financeurs ne suffit pas — il faut');
console.log('     que les deux cotes portent des operateurs de taille comparable.');

console.log('\n  ⛔ CE QUE CETTE SONDE NE FAIT PAS: proposer un seuil. Ce depot ecrit que balayer des seuils');
console.log('     et garder le meilleur a tue deux regles. Une bande qui separe aujourd hui doit etre');
console.log('     ANNONCEE avec sa date puis notee VERS L AVANT pour valoir comme preuve.');
console.log('  ⛔ ET LA CONSEQUENCE EST UNE QUESTION, PAS UNE RECOMMANDATION: la branche « sur » de la regle');
console.log('     vivante melange peut-etre deux populations opposees. La couper est une decision produit.\n');
