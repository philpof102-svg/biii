#!/usr/bin/env node
// probe-pourquoi-fnd20-s-inverse.js — la regle vivante change de signe. Pourquoi ?
// ================================================================================================
// Mesure du 2026-08-09: `fnd20` (financeur >= 20 freres) separe de +48,8 points par TOKEN et de
// -20,4 points par OPERATEUR. Les financeurs qu'elle marque ruggent a 64,4 %, ceux qu'elle ne marque
// pas a 84,8 %. Elle marque 721 tokens derriere TREIZE financeurs contre 320 derriere 183.
//
// ⛔ NE PAS CONCLURE « LA REGLE EST FAUSSE ». Deux raisons de se mefier de l'inversion elle-meme:
//   1. treize operateurs, c'est sous le plancher de ce depot — aucun taux par tirage n'est publiable;
//   2. la plupart des 183 financeurs du complement ne portent QU'UN SEUL token, et pour eux la
//      « moyenne par financeur » n'est rien d'autre que l'issue de ce token. Comparer treize gros
//      operateurs a cent-quatre-vingts singletons, ce n'est pas comparer des operateurs.
//
// ⚠️ ET IL Y A DEUX QUANTITES QU'ON PEUT CONFONDRE, ce que cette sonde separe explicitement:
//   · `siblingCount` = combien de wallets ce financeur a payes SUR LA CHAINE (ce que lit `fnd20`);
//   · le nombre de tokens que ce financeur porte DANS NOTRE BASE.
// Un financeur peut avoir 300 freres on-chain et deux tokens chez nous. Les traiter comme une seule
// grandeur ferait dire a la courbe l'inverse de ce qu'elle dit.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: si l'inversion survit quand on compare des operateurs de taille
// comparable, et comment le taux de rug d'un financeur varie avec chacune des deux quantites.
// ⛔ CE QU'ELLE NE PEUT PAS: dire qui sont ces operateurs. Un financeur a beaucoup de freres peut etre
// un launchpad ou une usine a rugs — ce depot ecrit lui-meme qu'ils sont indiscernables sous cet angle.
// ⛔ AUCUNE ADRESSE N'EST IMPRIMEE.
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

/* Un financeur = une ligne. On lui attache SES tokens resolus, et le `siblingCount` que le radar a lu
 * pour lui (il peut varier d'un token a l'autre si la lecture a change; on garde le maximum vu, qui est
 * la borne la moins fausse pour un compte qui est deja un plancher quand la lecture est censuree). */
const financeurs = new Map();
for (const t of rows) {
  const f = fnd(t); if (!f || issue(t) === null) continue;
  if (!financeurs.has(f)) financeurs.set(f, { tokens: 0, rugs: 0, sib: null });
  const e = financeurs.get(f);
  e.tokens++; if (issue(t) === 'rugged') e.rugs++;
  if (typeof t.siblingCount === 'number') e.sib = Math.max(e.sib === null ? -1 : e.sib, t.siblingCount);
}
const tous = [...financeurs.values()].filter((e) => e.sib !== null);
const marques = tous.filter((e) => e.sib >= SEUIL);
const compl = tous.filter((e) => e.sib < SEUIL);

console.log('\n  ── LES DEUX QUANTITES QU ON PEUT CONFONDRE ──\n');
console.log('    `siblingCount` = wallets payes SUR LA CHAINE (ce que lit `fnd20`)');
console.log('    « tokens portes » = tokens de CE financeur DANS NOTRE BASE. Ce ne sont pas les memes.\n');
const med = (arr) => (arr.length ? quantile(arr.slice().sort((a, b) => a - b), 0.5) : NaN);
console.log('    groupe          financeurs   tokens portes: med / max     siblingCount: med / max');
console.log('    ' + '-'.repeat(88));
for (const [nom, g] of [['marques (>=20)', marques], ['complement (<20)', compl]]) {
  const tk = g.map((e) => e.tokens), sb = g.map((e) => e.sib);
  console.log('    ' + nom.padEnd(18) + String(g.length).padStart(6)
    + String(med(tk)).padStart(18) + ' / ' + String(Math.max(...tk)).padEnd(8)
    + String(med(sb)).padStart(14) + ' / ' + String(Math.max(...sb)));
}
const singletons = compl.filter((e) => e.tokens === 1).length;
console.log('\n    ⚠️ ' + singletons + ' des ' + compl.length + ' financeurs du complement ne portent QU UN token ('
  + (100 * singletons / compl.length).toFixed(0) + ' %).');
console.log('       Pour eux, la « moyenne par financeur » n est rien d autre que l issue de ce token.');

/* ── LE CONTROLE: COMPARER DES OPERATEURS DE TAILLE COMPARABLE ───────────────────────────────────── */
console.log('\n  ── L INVERSION SURVIT-ELLE ENTRE OPERATEURS COMPARABLES ? ──\n');
console.log('    seuil de taille   marques (n)          complement (n)        ecart non pondere');
console.log('    ' + '-'.repeat(92));
const moyenne = (g) => (g.length ? g.reduce((s, e) => s + e.rugs / e.tokens, 0) / g.length : null);
for (const min of [1, 2, 3, 5, 10]) {
  const M = marques.filter((e) => e.tokens >= min), C = compl.filter((e) => e.tokens >= min);
  if (!M.length || !C.length) { console.log('    >= ' + String(min).padEnd(14) + '⛔ un cote vide'); continue; }
  const mM = moyenne(M), mC = moyenne(C);
  const d = 100 * (mM - mC);
  console.log('    >= ' + String(min).padEnd(14) + (pct(mM) + '  (' + M.length + ')').padEnd(21)
    + (pct(mC) + '  (' + C.length + ')').padEnd(22)
    + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts'
    + (M.length < MIN_RESOLUS || C.length < MIN_RESOLUS ? '   ⛔ un cote sous le plancher' : ''));
}
console.log('\n  ⚠️ Si l ecart reste NEGATIF a mesure qu on exige des operateurs plus gros des DEUX cotes,');
console.log('     l inversion n est pas un artefact de singletons. S il se retourne, elle en etait un.');

/* ── LA COURBE: LE TAUX DE RUG D UN FINANCEUR CONTRE CHACUNE DES DEUX QUANTITES ──────────────────── */
const bandes = (cle, seuils, nom) => {
  console.log('\n  ── TAUX DE RUG D UN FINANCEUR SELON ' + nom + ' ──\n');
  console.log('    bande            financeurs   tokens   moyenne non ponderee   taux par token (agrege)');
  console.log('    ' + '-'.repeat(96));
  for (let i = 0; i < seuils.length; i++) {
    const bas = seuils[i], haut = seuils[i + 1];
    const g = tous.filter((e) => e[cle] >= bas && (haut === undefined || e[cle] < haut));
    if (!g.length) continue;
    const tk = g.reduce((s, e) => s + e.tokens, 0), rg = g.reduce((s, e) => s + e.rugs, 0);
    const p = proportionAvecBornes(rg, tk);
    const etiquette = haut === undefined ? '>= ' + bas : bas + '-' + (haut - 1);
    console.log('    ' + etiquette.padEnd(17) + String(g.length).padStart(6) + String(tk).padStart(9)
      + '   ' + pct(moyenne(g)).padEnd(22) + ic(p)
      + (g.length < MIN_RESOLUS ? '   ⛔ sous le plancher' : ''));
  }
};
bandes('sib', [0, 1, 5, 20, 100, 300], '`siblingCount` (wallets payes ON-CHAIN)');
bandes('tokens', [1, 2, 3, 6, 11, 26], 'LE NOMBRE DE TOKENS PORTES DANS NOTRE BASE');

console.log('\n  ⛔ CE QUE CETTE SONDE N ETABLIT PAS. Si les gros financeurs ruggent moins, « financeur');
console.log('     industriel » pourrait designer des LAUNCHPADS plutot que des usines a rugs — mais ce');
console.log('     depot ecrit lui-meme qu un launchpad et une usine sont INDISCERNABLES sous cet angle.');
console.log('     Rien ici ne permet de trancher, et une inversion de taux n est pas une identification.');
console.log('  ⛔ ET LE `siblingCount` EST UN PLANCHER quand la lecture a ete bornee: un financeur classe');
console.log('     dans une bande basse peut appartenir a une bande haute. Le sens de cette erreur pousse');
console.log('     des gros vers les petits, donc elle ATTENUE toute difference entre bandes.');
console.log('  ⛔ AUCUNE ADRESSE N EST IMPRIMEE. Structure, jamais intention.\n');
