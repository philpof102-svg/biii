#!/usr/bin/env node
// probe-1a4-est-ce-jetable-deguise.js — la bande 1-4 dit-elle autre chose que « deployeur jetable » ?
// ================================================================================================
// Mesure d'il y a une heure: dans la branche « sur » de `funder-20`, la bande 1-4 freres rugge a 63,5 %
// et la bande 5-19 a 15,6 % — quarante-huit points, intervalles disjoints. Avant d'en faire quoi que ce
// soit, une question doit etre tranchee: est-ce un axe NOUVEAU, ou `freshDeployer` mesure deux fois ?
//
// LES DEUX LECTURES NE REGARDENT PAS LA MEME CHOSE, ce qui rend la question ouverte plutot qu'evidente:
//   · `freshDeployer` = le DEPLOYEUR n'a recu QU UN transfert entrant (lib/feeder.js) — portefeuille
//     cree pour ce lancement et rien d'autre;
//   · `siblingCount` = le FINANCEUR a paye N portefeuilles SORTANTS.
// Wallets differents, directions opposees. Mais une operation jetable peut tres bien porter les deux, et
// alors la « decouverte » de tout a l'heure ne serait qu'un doublon.
//
// LE TEST, le meme que celui applique au deployeur jetable contre `funder-20`: chacune des deux lectures
// separe-t-elle ENCORE a l'interieur de chaque branche de l'autre ? Si l'une s'effondre partout, elle est
// l'ombre de l'autre. Les deux reponses sont un resultat.
//
// ⛔ CETTE SONDE NE TRAVAILLE QUE SOUS LE SEUIL. Au-dessus de vingt freres tout rugge a 97-99 % et il n y
// a rien a separer; melanger les deux regimes noierait la question.
// ⛔ AUCUNE ADRESSE N'EST IMPRIMEE. Structure, jamais intention.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');
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

/* Le terrain: la branche « sur » de la regle vivante, ou les deux lectures sont LISIBLES. Une ligne sans
 * `freshDeployer` sort de la comparaison — « absent » n'est pas « faux ». */
const terrain = rows.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL
  && typeof t.freshDeployer === 'boolean' && issue(t) !== null);
const basse = (t) => t.siblingCount <= 4;
const jetable = (t) => t.freshDeployer === true;

function mesure(g) {
  const rug = g.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(g.map(fnd).filter(Boolean));
  return { res: g.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, g.length),
    tirage: proportionAvecBornes(rug, g.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}
const cel = (b, j) => mesure(terrain.filter((t) => basse(t) === b && jetable(t) === j));

const exclus = rows.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL
  && issue(t) !== null && typeof t.freshDeployer !== 'boolean').length;
console.log('\n  ── LE TERRAIN: LA BRANCHE « SUR », LES DEUX LECTURES LISIBLES ──\n');
console.log('    tokens resolus sous le seuil, les deux champs lisibles   ' + terrain.length);
console.log('    ecartes faute de `freshDeployer` lisible                 ' + exclus
  + '   (« absent » n est pas « faux »)');
if (terrain.length < 40) {
  console.log('\n  ⛔ Terrain trop petit pour une table 2x2: rien ne se publie plutot qu un tableau de cellules a 3.');
  process.exit(0);
}

console.log('\n  ── LA TABLE 2x2 ──\n');
console.log('    ' + ''.padEnd(16) + 'deployeur JETABLE'.padEnd(34) + 'deployeur REUTILISE');
console.log('    ' + '-'.repeat(88));
const G = { '1-4': {}, '5-19': {} };
for (const [nom, b] of [['1-4', true], ['5-19', false]]) {
  G[nom].jet = cel(b, true); G[nom].reu = cel(b, false);
  const rendu = (m) => (m.res ? (m.rug + '/' + m.res).padStart(8) + ' ' + ic(m.brut).padEnd(24) : '  (vide)'.padEnd(33));
  console.log('    ' + (nom + ' freres').padEnd(16) + rendu(G[nom].jet) + rendu(G[nom].reu));
}

/* ── LES DEUX CONDITIONNEMENTS ───────────────────────────────────────────────────────────────────── */
const cmp = (titre, a, b, etiqA, etiqB) => {
  if (!a.res || !b.res) { console.log('    ' + titre.padEnd(30) + '⛔ une cellule vide'); return null; }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ' + titre.padEnd(30) + (etiqA + ' ' + pct(a.brut.taux)).padEnd(18)
    + (etiqB + ' ' + pct(b.brut.taux)).padEnd(18) + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts  '
    + (disjoints(a.brut, b.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants'));
  return disjoints(a.brut, b.brut);
};
console.log('\n  ── LA BANDE SEPARE-T-ELLE ENCORE, A DEPLOYEUR FIXE ? ──\n');
const s1 = cmp('deployeur JETABLE', G['1-4'].jet, G['5-19'].jet, '1-4', '5-19');
const s2 = cmp('deployeur REUTILISE', G['1-4'].reu, G['5-19'].reu, '1-4', '5-19');

console.log('\n  ── LE DEPLOYEUR SEPARE-T-IL ENCORE, A BANDE FIXE ? ──\n');
const s3 = cmp('bande 1-4', G['1-4'].jet, G['1-4'].reu, 'jet', 'reu');
const s4 = cmp('bande 5-19', G['5-19'].jet, G['5-19'].reu, 'jet', 'reu');

/* ── LE RECOUVREMENT BRUT, PUBLIE SANS ETRE TRAITE COMME UN TEST ─────────────────────────────────── */
const nB = terrain.filter(basse).length, nJ = terrain.filter(jetable).length;
const nBJ = terrain.filter((t) => basse(t) && jetable(t)).length;
console.log('\n  ── LE RECOUVREMENT ──\n');
console.log('    bande 1-4                    ' + nB + '  (' + (100 * nB / terrain.length).toFixed(1) + ' %)');
console.log('    deployeur jetable            ' + nJ + '  (' + (100 * nJ / terrain.length).toFixed(1) + ' %)');
console.log('    les DEUX                     ' + nBJ + '  (' + (100 * nBJ / terrain.length).toFixed(1) + ' %)');
if (nB && nJ) {
  const attendu = nB * nJ / terrain.length;
  console.log('    attendu si INDEPENDANTS      ' + attendu.toFixed(1) + '   -> observe/attendu = '
    + (nBJ / attendu).toFixed(2) + 'x');
  console.log('  ⚠️ Ce rapport n est PAS un test: il ne porte aucune borne, et deux lectures peuvent se');
  console.log('     recouvrir fortement en gardant chacune de l information. Ce qui tranche est la paire');
  console.log('     de conditionnements ci-dessus.');
}

console.log('\n  ── LA LECTURE HONNETE ──\n');
const bandeTient = [s1, s2].filter((x) => x === true).length;
const deployTient = [s3, s4].filter((x) => x === true).length;
console.log('    la BANDE separe dans ' + bandeTient + ' des 2 branches du deployeur');
console.log('    le DEPLOYEUR separe dans ' + deployTient + ' des 2 bandes');
if (bandeTient === 0) {
  console.log('\n  ⛔ LA BANDE NE SEPARE DANS AUCUNE BRANCHE: elle est l ombre de `freshDeployer`, et la');
  console.log('     trouvaille d il y a une heure est un DOUBLON. Le dire est le resultat.');
} else if (deployTient === 0) {
  console.log('\n  💎 LE DEPLOYEUR NE SEPARE PLUS UNE FOIS LA BANDE FIXEE, mais la bande, si: c est la bande');
  console.log('     qui portait le signal, et `freshDeployer` en etait le reflet.');
} else {
  console.log('\n  💎 LES DEUX SEPARENT ENCORE quelque part: aucune n est le simple reflet de l autre, et');
  console.log('     elles ne se remplacent pas.');
}
console.log('  ⚠️ Une cellule qui chevauche n est pas une cellule vide: elle peut n avoir que peu de');
console.log('     lignes. Les effectifs sont imprimes au-dessus pour que l absence de separation ne se');
console.log('     lise pas comme une egalite.');
console.log('\n  ⛔ ET RIEN N EST PROMU. Ce depot ecrit que balayer des seuils et garder le meilleur a tue');
console.log('     deux regles; une bande qui separe aujourd hui doit etre annoncee datee puis notee vers');
console.log('     l avant. Aucune adresse n est imprimee.\n');
