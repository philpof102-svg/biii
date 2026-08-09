#!/usr/bin/env node
// probe-thin-est-il-un-proxy-de-liquidite.js — `thin` repond-il au RISQUE ou a la TAILLE ?
// ================================================================================================
// `thin` est le seul candidat qui passe tous les tests: il separe sur les deux terrains ET survit au
// retrait des trois plus gros financeurs (+66,2 -> +32,4 pts, disjoints). Avant d'en faire quoi que ce
// soit, la question qui a deja tue une lecture dans ce depot doit etre posee.
//
// `impersonation` A ETE RETIRE POUR AVOIR REPONDU A L'IDENTITE ET PAS AU RISQUE. `thin` se lit
// « aucun contrat a liquidite credible ne porte ce symbole » (lib/meme.js:171) — une phrase sur la
// LIQUIDITE. S'il ne fait que designer les PETITS, alors `firstLiq`, present sur les 2142 lignes et
// gratuit, fait deja le travail, et le symbol check ne se paie pas.
//
// LE SOUPCON EST DEJA MESURE: dans la branche « sur », la mediane de `firstLiq` est 19 565 chez les
// `thin` contre 33 201 chez les autres, et la part de `thin` tombe de 82,7 % dans le tercile bas a
// 24,7 % dans le haut. Les deux lectures se recouvrent fortement — ce qui rend la question ouverte,
// pas tranchee.
//
// LE TEST, le meme que celui applique aux drapeaux: chacune separe-t-elle ENCORE a l'interieur des
// strates de l'autre ? Si `thin` s'effondre dans toutes les strates, il est l'ombre de la taille.
//
// ⛔ LES TERCILES SE CALCULENT SUR LE TERRAIN, pas sur la population entiere: des bornes importees
// d'une autre distribution fabriqueraient des strates vides ou desequilibrees.
// ⛔ ON TRAVAILLE DANS LA BRANCHE « SUR », seul terrain non sature — ailleurs 87 a 92 % ruggent et il
// n'y a pas de marge pour qu'un ecart soit seulement visible.
// ⚠️ CE QU'ELLE PEUT PROUVER: si l'ecart de `thin` survit a liquidite comparable, avec bornes, marge
// disponible, effectifs et financeurs par cellule.
// ⛔ CE QU'ELLE NE PEUT PAS: promouvoir ou retirer une lecture — c'est une decision produit.
// ⛔ Aucune adresse imprimee.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, quantile, MIN_RESOLUS } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const toutes = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(toutes);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));
const thin = (t) => t.symbolVerdict === 'thin';

/* Le terrain: branche « sur », issue connue, et les DEUX lectures lisibles. Une ligne sans `firstLiq`
 * ou sans `symbolVerdict` sort de la comparaison — « absent » n'est pas « faux » — et le nombre de
 * sorties est imprime. */
const base = toutes.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL
  && issue(t) !== null);
const terrain = base.filter((t) => typeof t.symbolVerdict === 'string' && Number.isFinite(t.firstLiq));
console.log('\n  ── LE TERRAIN ──\n');
console.log('    branche « sur », issue connue                     ' + base.length);
console.log('    dont les DEUX lectures lisibles                   ' + terrain.length
  + '   (' + (base.length - terrain.length) + ' ecarte(s), « absent » n est pas « faux »)');
if (terrain.length < 60) {
  console.log('\n  ⛔ Terrain trop petit pour trois strates: rien ne se publie plutot qu un tableau de cellules a 5.\n');
  process.exit(0);
}

function mesure(g) {
  const rug = g.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(g.map(fnd).filter(Boolean));
  return { res: g.length, rug, fN: f.size, brut: proportionAvecBornes(rug, g.length) };
}
/* La garde de saturation, reprise de probe-candidats-dans-la-branche-sure.js: un ecart se lit contre la
 * marge qui restait, et une cellule dont la marge est plus etroite que l'intervalle ne POUVAIT rien
 * montrer. Elle ne compte alors ni pour ni contre. */
function compare(M, C) {
  if (!M.res || !C.res) return null;
  const d = 100 * (M.brut.taux - C.brut.taux);
  const ref = M.brut.taux < C.brut.taux ? M.brut : C.brut;
  const marge = 100 * (1 - ref.taux);
  const largeur = Math.max(100 * (M.brut.haute - M.brut.basse), 100 * (C.brut.haute - C.brut.basse));
  return { d, marge, sature: marge < largeur, disj: disjoints(M.brut, C.brut) };
}
const rendu = (r) => (r === null ? '(une cellule vide)'.padEnd(30)
  : (((r.d >= 0 ? '+' : '') + r.d.toFixed(1) + ' pts / ' + r.marge.toFixed(0) + '  '
    + (r.sature ? '⛔ SATUREE' : r.disj ? '💎 DISJOINTS' : '⚠️ chevauchants')).padEnd(30)));

/* ── LES STRATES, CALCULEES SUR LE TERRAIN ───────────────────────────────────────────────────────── */
const liqs = terrain.map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 1 / 3), q2 = quantile(liqs, 2 / 3);
const STRATES = [
  ['basse  ', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2], ['haute  ', (l) => l >= q2],
];
console.log('\n  ── `thin` SEPARE-T-IL ENCORE A LIQUIDITE COMPARABLE ? ──\n');
console.log('    terciles du terrain: ' + Math.round(q1) + '  et  ' + Math.round(q2) + '\n');
console.log('    strate     thin                        non-thin                    ecart / marge');
console.log('    ' + '-'.repeat(104));
let tient = 0, testables = 0;
for (const [nom, pred] of STRATES) {
  const g = terrain.filter((t) => pred(t.firstLiq));
  const M = mesure(g.filter(thin)), C = mesure(g.filter((t) => !thin(t)));
  const r = compare(M, C);
  const cell = (m) => (m.res ? (m.rug + '/' + m.res).padStart(8) + ' ' + pct(m.brut.taux)
    + ' (' + String(m.fN).padStart(2) + 'f)' : '   (vide)'.padEnd(22));
  console.log('    ' + nom + '  ' + cell(M).padEnd(28) + cell(C).padEnd(28) + rendu(r));
  if (r && !r.sature) { testables++; if (r.disj) tient++; }
}
console.log('\n    `thin` separe dans ' + tient + ' des ' + testables + ' strate(s) TESTABLE(S)'
  + (testables < 3 ? '   ⛔ (des strates saturees ou vides sont exclues du denominateur)' : ''));

/* ── ET LE CONDITIONNEMENT INVERSE, PARCE QU'UNE SEULE DIRECTION EST UNE IMPRESSION ──────────────── */
console.log('\n  ── LA LIQUIDITE SEPARE-T-ELLE ENCORE A `thin` FIXE ? ──\n');
console.log('    groupe       tercile bas                 tercile haut                ecart / marge');
console.log('    ' + '-'.repeat(104));
let tientL = 0, testablesL = 0;
for (const [nom, pred] of [['thin    ', thin], ['non-thin', (t) => !thin(t)]]) {
  const g = terrain.filter(pred);
  const B = mesure(g.filter((t) => t.firstLiq < q1)), H = mesure(g.filter((t) => t.firstLiq >= q2));
  const r = compare(B, H);
  const cell = (m) => (m.res ? (m.rug + '/' + m.res).padStart(8) + ' ' + pct(m.brut.taux)
    + ' (' + String(m.fN).padStart(2) + 'f)' : '   (vide)'.padEnd(22));
  console.log('    ' + nom + '  ' + cell(B).padEnd(28) + cell(H).padEnd(28) + rendu(r));
  if (r && !r.sature) { testablesL++; if (r.disj) tientL++; }
}
console.log('\n    la liquidite separe dans ' + tientL + ' des ' + testablesL + ' groupe(s) TESTABLE(S)');

/* ── LA CONCENTRATION, PARCE QU ELLE A DEJA RETOURNE UN TITRE AUJOURD HUI ────────────────────────── */
const par = new Map();
for (const t of terrain) { const f = fnd(t); if (f) par.set(f, (par.get(f) || 0) + 1); }
const tri = [...par.entries()].sort((a, b) => b[1] - a[1]);
const gros = new Set(tri.slice(0, 3).map((e) => e[0]));
const lignesGros = tri.slice(0, 3).reduce((s, e) => s + e[1], 0);
console.log('\n  ── ET SANS LES TROIS PLUS GROS FINANCEURS ──\n');
console.log('    ' + terrain.length + ' tokens · ' + par.size + ' financeurs · les 3 plus gros portent '
  + tri.slice(0, 3).map((e) => e[1]).join(' + ') + ' = ' + lignesGros + ' lignes ('
  + (100 * lignesGros / terrain.length).toFixed(1) + ' %)\n');
/* ⛔ ET UNE ETIQUETTE « SATUREE » NE SUFFIT PLUS ICI, parce qu'elle confond deux echecs opposes.
 * `sature` vaut `marge < largeur`, et retirer des lignes ELARGIT les intervalles: une comparaison peut
 * donc devenir « saturee » sans que l'effet ait bouge d'un point, seulement parce qu'il reste moins de
 * donnees. Lire ca comme « l'effet s'est effondre » serait faux. Les deux causes se distinguent en
 * regardant ce qui a bouge: l'ECART (l'effet) ou l'intervalle (la puissance). */
console.log('    strate     tous les financeurs           sans les 3 plus gros          ce qui a bouge');
console.log('    ' + '-'.repeat(112));
for (const [nom, pred] of STRATES) {
  const f = (g) => compare(mesure(g.filter(thin)), mesure(g.filter((t) => !thin(t))));
  const g = terrain.filter((t) => pred(t.firstLiq));
  const gSans = g.filter((t) => !gros.has(fnd(t)));
  const a = f(g), b = f(gSans);
  let cause = '';
  if (a && b) {
    const garde = b.d / a.d;
    cause = 'ecart ' + a.d.toFixed(1) + ' -> ' + b.d.toFixed(1) + ' (' + (100 * garde).toFixed(0) + ' %)'
      + ' · n ' + g.length + ' -> ' + gSans.length + '   '
      + (garde >= 0.5 ? "💎 l EFFET TIENT, l intervalle s elargit" : '⛔ l EFFET TOMBE');
  }
  console.log('    ' + nom + '  ' + rendu(a) + rendu(b) + cause);
}
console.log('\n  ⚠️ « SATUREE » apres retrait ne veut PAS dire « effet disparu »: retirer des lignes elargit');
console.log('     les intervalles, donc une comparaison peut basculer sans que l ecart bouge. La colonne');
console.log('     de droite dit laquelle des deux choses a bouge — c est elle qui tranche, pas l etiquette.');

console.log('\n  ── LA LECTURE HONNETE ──\n');
if (!testables) {
  console.log('    ⛔ AUCUNE strate testable: toutes saturees ou vides. Ce terrain ne peut pas repondre,');
  console.log('       et le dire est le resultat — ce n est PAS « thin ne separe pas ».');
} else if (tient === 0) {
  console.log('    ⛔ `thin` NE SEPARE DANS AUCUNE STRATE TESTABLE: a liquidite comparable il ne dit plus');
  console.log('       rien, donc il designait la TAILLE. Et `firstLiq` est present sur les 2142 lignes,');
  console.log('       gratuitement, la ou le symbol check se paie.');
} else if (tient === testables) {
  console.log('    💎 `thin` SEPARE DANS TOUTES LES STRATES TESTABLES: a liquidite comparable il dit');
  console.log('       encore quelque chose que `firstLiq` ne dit pas — il ne designe donc PAS seulement');
  console.log('       les petits, et il ne meurt pas de ce qui a tue `impersonation`.');
  console.log('    ⚠️ Mais aucune strate ne reste DISJOINTE apres retrait des trois plus gros: l ecart y');
  console.log('       garde l essentiel de sa taille (colonne « ce qui a bouge »), ce sont les lignes qui');
  console.log('       manquent. Ce n est donc ni une confirmation ni une refutation a ce niveau — juste');
  console.log('       un terrain trop mince pour trancher, et c est ca qu il faut rapporter.');
} else {
  console.log('    ⚠️ `thin` separe dans ' + tient + ' strate(s) sur ' + testables + ': ni ombre de la taille, ni');
  console.log('       independant d elle. Une direction sur des cellules partielles est une impression,');
  console.log('       pas un resultat — les effectifs et les financeurs sont imprimes pour le juger.');
}
console.log('  ⚠️ Une strate SATUREE ne dit pas « pas de difference »: elle dit que la marge restante');
console.log('     etait plus etroite que l intervalle, donc qu aucun ecart ne POUVAIT y apparaitre.');
console.log('  ⛔ ET RIEN N EST PROMU NI RETIRE. Consommer une lecture dans la regle vivante est une');
console.log('     decision produit, et une lecture qui separe aujourd hui doit etre annoncee datee puis');
console.log('     notee VERS L AVANT. Aucune adresse imprimee.\n');
