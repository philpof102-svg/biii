#!/usr/bin/env node
// probe-cout-des-rugs-rates.js — l'autre plateau: ce qu'un rug rate laisse passer.
// ================================================================================================
// `probe-cout-des-accusations.js` a decrit le cout d'ACCUSER: les survivants marques a tort sont les
// PETITS (mediane 18-19k contre 29k), et en bande haute le marqueur n'ajoute rien d'etabli. Un seul
// plateau ne fait pas une balance. Celui-ci decrit l'autre: les rugs qui passent en « sur ».
//
// ⛔ ET LA PREMIERE CHOSE MESUREE A TUE LA MESURE PREVUE. L'idee etait de peser un rug rate par
// `dropPct`, l'ampleur de sa chute. Or ce champ n'est ecrit qu'a l'instant ou le seuil de rug est
// franchi (`drop >= RUG_DROP` ET `liq < RUG_FLOOR`, token-radar.js): il est CENSURE par construction.
// Mesure sur les 1542 rugs dates: min 0,961 · mediane 1,000 · max 1,000, DEUX valeurs distinctes a deux
// decimales. Une sortie constante n'est pas une mesure — `dropPct` ne porte aucune information de
// gravite, parce que tous les rugs observes sont des vidages complets.
// Ce qui reste, et qui mesure vraiment l'exposition laissee passer, c'est `peakLiq`.
//
// ⚠️ CE QU'IL PEUT PROUVER: combien de rugs chaque regle laisse passer, quelle liquidite de pic ils
// portaient, et le taux de faux negatifs par strate avec ses bornes.
// ⛔ CE QU'IL NE PEUT PAS: additionner les deux plateaux. Rater un rug coute a qui ACHETE, accuser un
// survivant coute a qui VEND. Ce sont deux personnes differentes; un solde net supposerait qu'elles
// n'en font qu'une. Les deux sont publies cote a cote et jamais soustraits.
// ⛔ ET `peakLiq` N'EST PAS UNE PERTE: c'est la liquidite du pool a son maximum, pas la somme qu'un
// acheteur a versee. Proxy d'exposition, encore.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, quantile } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const k$ = (v) => (Number.isFinite(v) ? (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : String(Math.round(v))) : '—');
const med = (arr) => (arr.length ? quantile(arr.slice().sort((a, b) => a - b), 0.5) : NaN);

const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);
const REGLES = [
  ['funder-20 seul', (t) => parFinanceur(t) === true],
  ['jetable seul', (t) => parJetable(t) === true],
  ['UNION des deux', (t) => parFinanceur(t) === true || parJetable(t) === true],
  ['UNION + no_creator', (t) => parFinanceur(t) === true || parJetable(t) === true
    || t.funderTrace === 'no_creator'],
];

/* ── D'ABORD, LE CHAMP QU'ON N'UTILISERA PAS, ET POURQUOI ────────────────────────────────────────── */
const drops = rows.map((t) => t.dropPct).filter(Number.isFinite).sort((a, b) => a - b);
console.log('\n  ── `dropPct` NE MESURE RIEN, ET C EST LA PREMIERE CHOSE A DIRE ──\n');
if (!drops.length) {
  console.log('    ⛔ aucun `dropPct` en base — rien a examiner, et rien ne se substitue en silence.');
} else {
  const distinctes = new Set(drops.map((d) => d.toFixed(2))).size;
  console.log('    ' + drops.length + ' rug(s) date(s)   min ' + drops[0].toFixed(3)
    + '   mediane ' + quantile(drops, 0.5).toFixed(3) + '   max ' + drops[drops.length - 1].toFixed(3));
  console.log('    valeurs distinctes a deux decimales: ' + distinctes);
  if (distinctes <= 3) {
    console.log('  ⛔ Ce champ est CENSURE par sa propre definition: il n est ecrit qu au moment ou le seuil');
    console.log('     de rug est franchi, donc il ne peut jamais valoir moins. Tous les rugs observes sont');
    console.log('     des vidages complets, et une sortie constante n est pas une mesure. La gravite d un');
    console.log('     rug rate se lit donc dans `peakLiq`, pas ici.');
  } else {
    console.log('  ⚠️ Ce champ varie plus que prevu (' + distinctes + ' valeurs): il redevient interpretable, et');
    console.log('     la conclusion ci-dessus, ecrite quand il n en portait que deux, doit etre revue.');
  }
}

/* ── LE PLATEAU DES RUGS RATES ───────────────────────────────────────────────────────────────────── */
const resolus = rows.filter((t) => issue(t) !== null);
const rugs = resolus.filter((t) => issue(t) === 'rugged');
const survivants = resolus.filter((t) => issue(t) === 'survived');
console.log('\n  ── LE PLATEAU DES RUGS RATES ──\n');
console.log('    rugs resolus  ' + rugs.length + '   ·   reference peakLiq median des rugs  '
  + k$(med(rugs.map((t) => t.peakLiq).filter(Number.isFinite))));
console.log('\n    regle                  rates   part des rugs           peakLiq med   firstLiq med   le plus gros');
console.log('    ' + '-'.repeat(106));
for (const [nom, d] of REGLES) {
  const fn = rugs.filter((t) => d(t) !== true);
  const pk = fn.map((t) => t.peakLiq).filter(Number.isFinite);
  const fl = fn.map((t) => t.firstLiq).filter(Number.isFinite);
  const p = proportionAvecBornes(fn.length, rugs.length);
  console.log('    ' + nom.padEnd(22) + String(fn.length).padStart(5) + '   ' + ic(p).padEnd(22)
    + k$(med(pk)).padStart(11) + k$(med(fl)).padStart(14)
    + k$(pk.length ? Math.max(...pk) : NaN).padStart(14));
}

/* ── LES DEUX PLATEAUX, PAR STRATE, COTE A COTE ET JAMAIS SOUSTRAITS ─────────────────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
const STRATES = [['basse  ', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2], ['haute  ', (l) => l >= q2]];
console.log('\n  ── LES DEUX PLATEAUX, PAR STRATE ──');
console.log('     gauche: rugs RATES (cout pour qui achete)   ·   droite: survivants ACCUSES (cout pour qui vend)\n');
for (const [nom, d] of REGLES) {
  console.log('    ' + nom);
  for (const [sn, pred] of STRATES) {
    const dedans = (t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq);
    const r = rugs.filter(dedans), s = survivants.filter(dedans);
    if (!r.length && !s.length) continue;
    const fn = r.filter((t) => d(t) !== true), fp = s.filter((t) => d(t) === true);
    const pfn = r.length ? proportionAvecBornes(fn.length, r.length) : null;
    const pfp = s.length ? proportionAvecBornes(fp.length, s.length) : null;
    console.log('      liq ' + sn + '  rates ' + String(fn.length).padStart(4) + '/' + String(r.length).padStart(4)
      + ' ' + (pfn ? ic(pfn) : '   —').padEnd(24)
      + '   accuses ' + String(fp.length).padStart(3) + '/' + String(s.length).padStart(4)
      + ' ' + (pfp ? ic(pfp) : '   —'));
  }
}

console.log('\n  ⛔ CES DEUX COLONNES NE S ADDITIONNENT PAS ET NE SE SOUSTRAIENT PAS. Un rug rate coute a');
console.log('     quelqu un qui ACHETE; un survivant accuse coute a quelqu un qui VEND. Un solde net');
console.log('     supposerait que ces deux personnes n en font qu une. Le poids relatif des deux erreurs');
console.log('     est un choix de produit, et il n est pas mesurable depuis cette base.');
console.log('  ⛔ `peakLiq` N EST PAS UNE PERTE: c est la liquidite du pool a son maximum, pas la somme');
console.log('     versee par un acheteur. Proxy d exposition, comme `firstLiq` du cote des accusations.');
console.log('  ⚠️ ET LES RUGS RATES SONT COMPTES SUR LES SEULS TOKENS RESOLUS. Un rug encore en cours');
console.log('     n entre nulle part — ni comme rate, ni comme attrape.\n');
