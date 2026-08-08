#!/usr/bin/env node
// probe-cout-des-accusations.js — accuser un survivant, ca coute. Combien, et lesquels ?
// ================================================================================================
// `probe-rappel-et-cout.js` a chiffre un contrefactuel: traiter `no_creator` comme un marqueur ferait
// passer le rappel de 51,0 a 74,0 % et la survie de la branche « sur » de 29,0 a 41,4 %, pour 26
// survivants accuses en plus. Vingt-six paraissait bon marche. Ce compte suppose pourtant que tous les
// survivants se valent, et ils ne se valent pas: accuser a tort un token a forte liquidite touche
// beaucoup plus de monde qu'accuser un token minuscule.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: la distribution de liquidite des faux positifs de chaque regle, leur
// concentration par financeur, et le taux de faux positifs par strate de liquidite avec ses bornes.
// ⛔ CE QU'ELLE NE PEUT PAS: convertir cela en argent. La liquidite d'un pool n'est pas la somme perdue
// par un acheteur qui renonce, et personne ici ne sait combien d'acheteurs lisent un verdict. C'est un
// PROXY d'exposition, pas un cout. Le nommer autrement serait fabriquer un chiffre.
// ⛔ ET UN FAUX POSITIF N'EST PAS SYMETRIQUE D'UN FAUX NEGATIF: laisser passer un rug coute a qui achete,
// accuser un survivant coute a qui vend. Cette sonde ne pese pas les deux — elle en decrit un seul.
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
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const k$ = (v) => (Number.isFinite(v) ? (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : String(Math.round(v))) : '—');

const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);
const REGLES = [
  ['funder-20 seul', (t) => parFinanceur(t) === true],
  ['jetable seul', (t) => parJetable(t) === true],
  ['UNION des deux', (t) => parFinanceur(t) === true || parJetable(t) === true],
  ['UNION + no_creator', (t) => parFinanceur(t) === true || parJetable(t) === true
    || t.funderTrace === 'no_creator'],
];

const resolus = rows.filter((t) => issue(t) !== null);
const survivants = resolus.filter((t) => issue(t) === 'survived');
console.log('\n  ── LA POPULATION QUI PORTE LE COUT ──\n');
console.log('    tokens resolus            ' + resolus.length);
console.log('    dont SURVIVANTS           ' + survivants.length
  + '   (c est sur eux, et eux seuls, qu une accusation peut etre fausse)');

/* ── LA DISTRIBUTION DE LIQUIDITE DES FAUX POSITIFS ──────────────────────────────────────────────── */
const liqSurv = survivants.map((t) => t.firstLiq).filter(Number.isFinite).sort((a, b) => a - b);
console.log('\n  ── QUELS SURVIVANTS SONT ACCUSES ? ──\n');
console.log('    reference: firstLiq des survivants   med ' + k$(quantile(liqSurv, 0.5))
  + '   p25 ' + k$(quantile(liqSurv, 0.25)) + '   p75 ' + k$(quantile(liqSurv, 0.75)));
console.log('\n    regle                  faux pos.  part des survivants   firstLiq med   peakLiq med   financeurs');
console.log('    ' + '-'.repeat(104));
for (const [nom, d] of REGLES) {
  const fp = survivants.filter((t) => d(t) === true);
  const l = fp.map((t) => t.firstLiq).filter(Number.isFinite).sort((a, b) => a - b);
  const p = fp.map((t) => t.peakLiq).filter(Number.isFinite).sort((a, b) => a - b);
  /* ⛔ LE RATIO DOIT PORTER SUR LA MEME POPULATION EN HAUT ET EN BAS. La premiere version divisait
   * TOUS les faux positifs par le nombre de financeurs de ceux qui en avaient un — or les tokens
   * `no_creator` n'en ont AUCUN par construction, donc la regle qui les inclut voyait son ratio gonfler
   * sans qu'aucun financeur ne soit plus charge. Numerateur et denominateur portent maintenant sur les
   * seuls faux positifs TRACES, et les autres sont comptes a part. */
  const avecF = fp.filter((t) => fnd(t));
  const f = new Set(avecF.map(fnd));
  const part = proportionAvecBornes(fp.length, survivants.length);
  console.log('    ' + nom.padEnd(22) + String(fp.length).padStart(7) + '   ' + ic(part).padEnd(22)
    + k$(l.length ? quantile(l, 0.5) : NaN).padStart(11) + k$(p.length ? quantile(p, 0.5) : NaN).padStart(14)
    + String(f.size).padStart(11)
    + (f.size ? '  (' + (avecF.length / f.size).toFixed(1) + ' fp traces/fin.' : '  (')
    + (fp.length - avecF.length ? ', ' + (fp.length - avecF.length) + ' sans financeur)' : ')'));
}

/* ── LE TAUX DE FAUX POSITIFS PAR STRATE, PARCE QUE C'EST LA QU'IL SE PAIE ───────────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
const STRATES = [['basse  ', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2], ['haute  ', (l) => l >= q2]];
console.log('\n  ── LE TAUX DE FAUX POSITIFS, PAR STRATE DE LIQUIDITE ──\n');
console.log('    tertiles de firstLiq: < ' + Math.round(q1) + '  |  ' + Math.round(q1) + ' a '
  + Math.round(q2) + '  |  > ' + Math.round(q2) + '\n');
console.log('    regle                  ' + STRATES.map(([n]) => ('liq ' + n.trim()).padEnd(26)).join(''));
for (const [nom, d] of REGLES) {
  const cases = STRATES.map(([, pred]) => {
    const s = survivants.filter((t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq));
    if (!s.length) return null;
    return { p: proportionAvecBornes(s.filter((t) => d(t) === true).length, s.length), n: s.length };
  });
  console.log('    ' + nom.padEnd(22)
    + cases.map((c) => (c ? (ic(c.p) + ' (' + c.n + ')').padEnd(26) : '—'.padEnd(26))).join(''));
}

/* ── LA COMPARAISON QUI DECIDE: LES DEUX UNIONS, CELLULE PAR CELLULE ─────────────────────────────── */
console.log('\n  ── CE QUE LE MARQUEUR `no_creator` AJOUTE, LA OU IL L AJOUTE ──\n');
const sansNC = REGLES[2][1], avecNC = REGLES[3][1];
let totalSup = 0;
for (const [nom, pred] of STRATES) {
  const s = survivants.filter((t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq));
  const a = s.filter((t) => sansNC(t) === true).length;
  const b = s.filter((t) => avecNC(t) === true).length;
  const sup = s.filter((t) => avecNC(t) === true && sansNC(t) !== true);
  totalSup += sup.length;
  const l = sup.map((t) => t.firstLiq).filter(Number.isFinite).sort((x, y) => x - y);
  console.log('    liq ' + nom + '  survivants ' + String(s.length).padStart(4)
    + '   accuses ' + String(a).padStart(3) + ' -> ' + String(b).padStart(3)
    + '   soit +' + String(sup.length).padStart(3) + ' de plus'
    + (l.length ? '   firstLiq med ' + k$(quantile(l, 0.5)) : ''));
}
console.log('\n    total de survivants accuses EN PLUS par le marqueur: ' + totalSup);

console.log('\n  ⛔ CE QUE CES CHIFFRES NE SONT PAS. La liquidite d un pool n est PAS la somme qu un acheteur');
console.log('     perd en renoncant, et rien ici ne dit combien d acheteurs lisent un verdict. C est un');
console.log('     PROXY d exposition; l appeler un cout en dollars serait fabriquer un chiffre.');
console.log('  ⛔ ET LES DEUX ERREURS NE SE PESENT PAS ICI. Laisser passer un rug coute a qui achete,');
console.log('     accuser un survivant coute a qui vend. Cette sonde ne decrit qu un seul des deux cotes;');
console.log('     l arbitrage entre eux est un choix de produit, pas une mesure.');
console.log('  ⚠️ ET LE COMPTE PAR FINANCEUR EST UN MAJORANT D INDEPENDANCE: deux adresses peuvent partager');
console.log('     un operateur, et un survivant sans financeur trace n entre dans aucun compte de tirages.\n');
