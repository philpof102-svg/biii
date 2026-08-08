#!/usr/bin/env node
// probe-thin-est-il-un-signal.js — `thin` separe-t-il, ou redit-il « ce token est neuf » ?
// ================================================================================================
// A 05h j'ai note que le seau `thin` de `symbolVerdict` porte 774 appels resolus derriere 149
// financeurs a 94,6 % de rug par tirage, contre 82,0 % pour la base, intervalles disjoints — et qu'aucune
// regle notee ne lit ce champ. Deux choses manquaient, et l'une des deux peut tout annuler.
//
// ⛔ CE QUE `thin` VEUT DIRE, LU DANS LE CODE (lib/meme.js): « aucun contrat a liquidite CREDIBLE ne
// porte ce symbole ». Ce n'est pas un jugement sur le token qu'on regarde, c'est un constat sur le
// SYMBOLE: personne d'etabli ne le porte. Autrement dit, un symbole neuf. Et « un token neuf rugge
// beaucoup » n'est pas un signal, c'est le taux de base du radar sous un autre nom.
// ⛔ PIRE, LA CIRCULARITE EST DIRECTE: « credible » se calcule A PARTIR DE LA LIQUIDITE, qui est la
// variable de stratification de tout ce depot et un predicteur de rug connu. `thin` pourrait n'etre
// qu'un proxy de liquidite. Le test qui tranche est donc: separe-t-il ENCORE a liquidite comparable ?
//
// ⚠️ CE QU'IL PEUT PROUVER: le taux de rug de `thin` contre son COMPLEMENT (et non contre une population
// qui le contient), a liquidite comparable et a etat de trace comparable, avec bornes et financeurs.
// ⛔ CE QU'IL NE PEUT PAS: dire que le champ est inutile s'il s'effondre. Un champ redondant reste utile
// quand l'autre lecture manque — mais il ne se vend pas comme une information nouvelle.
// ⛔ IL NE PROMEUT RIEN.
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
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU (' + p.effectif + ')' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

const thin = (t) => t.symbolVerdict === 'thin';
/* ⛔ Le complement EXCLUT les lignes sans champ: « absent » n'est pas « pas thin », c'est inconnu. */
const complement = (t) => t.symbolVerdict !== undefined && t.symbolVerdict !== 'thin';
const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);
const union = (t) => parFinanceur(t) === true || parJetable(t) === true;

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { res: res.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}
const duo = (nom, pop) => {
  const a = mesure(pop.filter(thin)), b = mesure(pop.filter(complement));
  if (!a.res || !b.res) { console.log('    ' + nom.padEnd(18) + '⛔ un cote vide — rien a comparer'); return null; }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ' + nom.padEnd(18) + (a.rug + '/' + a.res).padStart(9) + ' ' + ic(a.brut).padEnd(24)
    + (b.rug + '/' + b.res).padStart(9) + ' ' + ic(b.brut).padEnd(24)
    + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts  '
    + (disjoints(a.brut, b.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants'));
  return { a, b, d };
};

console.log('\n  ── CE QUE `thin` VEUT DIRE, ET POURQUOI CE N EST PEUT-ETRE PAS UN SIGNAL ──\n');
console.log('    lib/meme.js: `thin` = « aucun contrat a liquidite CREDIBLE ne porte ce symbole ».');
console.log('    C est un constat sur le SYMBOLE (personne d etabli ne le porte), pas sur le token juge.');
console.log('    Et « credible » se calcule a partir de la LIQUIDITE — la variable qui predit deja le rug.');

console.log('\n  ── 1. CONTRE SON COMPLEMENT (et non contre une population qui le contient) ──\n');
console.log('    decoupage             thin                       complement                 ecart');
console.log('    ' + '-'.repeat(102));
const global = duo('toute la base', rows);

/* ── 2. LE TEST QUI TRANCHE: A LIQUIDITE COMPARABLE ──────────────────────────────────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
console.log('\n  ── 2. A LIQUIDITE COMPARABLE — LE TEST DE CIRCULARITE ──\n');
console.log('    tertiles de firstLiq: < ' + Math.round(q1) + '  |  ' + Math.round(q1) + ' a ' + Math.round(q2)
  + '  |  > ' + Math.round(q2) + '\n');
console.log('    strate                thin                       complement                 ecart');
console.log('    ' + '-'.repeat(102));
const parStrate = [];
for (const [nom, pred] of [['liq basse', (l) => l < q1], ['liq moyenne', (l) => l >= q1 && l < q2],
  ['liq haute', (l) => l >= q2]]) {
  parStrate.push(duo(nom, rows.filter((t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq))));
}
const survit = parStrate.filter((x) => x && disjoints(x.a.brut, x.b.brut)).length;
console.log('\n    strates ou l ecart est ETABLI: ' + survit + ' sur ' + parStrate.filter(Boolean).length);
if (!survit) {
  console.log('  ⛔ L ECART NE SURVIT DANS AUCUNE STRATE. `thin` se comporte alors comme une reecriture de');
  console.log('     la liquidite, ce que son propre code laissait craindre: « credible » s en deduit. Ce');
  console.log('     n est pas un signal nouveau, et le presenter comme tel serait une trouvaille fabriquee.');
} else {
  console.log('  💎 L ecart survit dans ' + survit + ' strate(s): `thin` porte quelque chose que la liquidite seule');
  console.log('     n explique pas. Ce qui NE dit pas encore qu il est independant de l etat de trace.');
}

/* ── 3. ET A ETAT DE TRACE COMPARABLE ────────────────────────────────────────────────────────────── */
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
console.log('\n  ── 3. A ETAT DE TRACE COMPARABLE ──\n');
console.log('    etat                  thin                       complement                 ecart');
console.log('    ' + '-'.repeat(102));
const parTrace = [];
for (const e of ['ok', 'no_creator', 'failed', 'no_funder', 'ABSENT']) {
  parTrace.push(duo(e, rows.filter((t) => etat(t) === e)));
}
const survitTrace = parTrace.filter((x) => x && disjoints(x.a.brut, x.b.brut)).length;
console.log('\n    etats ou l ecart est ETABLI: ' + survitTrace + ' sur ' + parTrace.filter(Boolean).length);

/* ── 4. LE CONTREFACTUEL, QUOI QU IL EN SOIT ─────────────────────────────────────────────────────── */
const resolus = rows.filter((t) => issue(t) !== null);
const rugs = resolus.filter((t) => issue(t) === 'rugged');
const survivants = resolus.filter((t) => issue(t) === 'survived');
console.log('\n  ── 4. LE CONTREFACTUEL (mesure, PAS une proposition) ──\n');
console.log('    regle                  rappel                   survivants accuses        rates > 1M$');
console.log('    ' + '-'.repeat(98));
for (const [nom, d] of [['UNION actuelle', union], ['UNION + thin', (t) => union(t) || thin(t)],
  ['thin SEUL', thin]]) {
  const vp = rugs.filter((t) => d(t) === true).length;
  const fp = survivants.filter((t) => d(t) === true).length;
  const gros = rugs.filter((t) => d(t) !== true && Number.isFinite(t.peakLiq) && t.peakLiq > 1e6).length;
  console.log('    ' + nom.padEnd(22) + ic(proportionAvecBornes(vp, rugs.length)).padEnd(24)
    + ic(proportionAvecBornes(fp, survivants.length)).padEnd(26) + String(gros).padStart(5));
}

console.log('\n  ⛔ UN CHAMP REDONDANT N EST PAS UN CHAMP INUTILE. Si `thin` ne fait que redire la liquidite,');
console.log('     il reste lisible quand la trace manque — mais il ne se vend pas comme une information');
console.log('     nouvelle, et le fait publie a 05h (« un champ qu aucune regle ne lit ») garde sa valeur');
console.log('     de constat sans devenir une promesse de gain.');
console.log('  ⛔ LE COMPLEMENT EXCLUT LES LIGNES SANS CHAMP: « absent » n est pas « pas thin ». Les inclure');
console.log('     aurait gonfle le complement avec des inconnus et fabrique un ecart.');
console.log('  ⛔ STRUCTURE, JAMAIS INTENTION: `symbolVerdict` compare des chaines et des liquidites. Il ne');
console.log('     designe personne.\n');
