#!/usr/bin/env node
// probe-couverture-dans-le-temps.js — la moitie illisible se resorbe-t-elle, ou est-elle le regime ?
//
// ⚠️ NE PAS CONFONDRE: « couverture » designe TROIS mesures etrangeres dans ce depot, et rien ne les
// distingue au point de lecture. Nomme ici le 2026-08-11 apres avoir failli citer l'une pour l'autre.
//   1. `probe-couverture-refaisable.js` — TEMPORELLE / UPTIME: quelle part du temps le collecteur
//      TOURNAIT (74,3 pct au 11/08). Ne dit RIEN de ce qui est dechiffrable.
//   2. ICI — LISIBILITE: quelle part des tokens resolus porte les DEUX lectures (53 pct au 11/08).
//   3. `probe-audit-independance-des-paris.js` / `probe-first-verdict-tient-il.js` — couverture du
//      CONTROLE: combien de tokens d'un groupe portent un financeur identifie (ex. 163/574).
// ⛔ Le produit LIT 53 pct de ce qu'il voit, et il TOURNAIT 74 pct du temps. Deux phrases, pas une.
// ================================================================================================
// `probe-rappel-et-cout.js` a mesure que la branche « sur » de l'union survit a 29,0 % en production
// contre 82,9 % dans l'univers lisible: 886 tokens resolus qu'aucun drapeau ne peut lire tombent dans
// « sur » par defaut. En classant ces 886, j'ai etiquete 335 d'entre eux « historiques — precede
// l'instrumentation », et donc destines a disparaitre.
//
// ⛔ C'ETAIT UNE ETIQUETTE, PAS UNE MESURE, ET ELLE ETAIT DE MOI. Cette sonde la teste: si la couverture
// monte avec le temps, le 29 % est un PLANCHER qui remontera seul. Si elle est plate, « historique » est
// un mot qu'on s'est raconte et le 29 % est un PLAFOND.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: la part des tokens resolus qui portent les DEUX lectures, jour par jour,
// avec bornes; et la composition de l'illisibilite, qui peut changer meme quand son total ne bouge pas.
// ⛔ CE QU'ELLE NE PEUT PAS: prevoir. Une serie plate sur quatorze jours ne garantit pas qu'elle le
// reste, elle refute seulement l'idee qu'une amelioration est DEJA en cours.
// ⛔ ET LES JOURS RECENTS SONT INCOMPLETS: un token vu il y a deux heures n'a pas d'issue, donc il
// n'entre pas ici. Le dernier jour porte moins de monde et ce n'est pas un effondrement.
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
let fins = null;
try {
  const j = JSON.parse(fs.readFileSync(path.join(RACINE, 'data/token-radar/blackouts.json'), 'utf8'));
  if (Array.isArray(j)) fins = j.map((t) => Date.parse(t.to)).filter(Number.isFinite);
} catch (e) { fins = null; }

const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const reprise = (t) => {
  if (fins === null) return false;
  const ms = Date.parse(t.firstSeen);
  return fins.some((f) => ms >= f && ms < f + 6 * 3600000);
};
/* « Lisible » = les DEUX drapeaux existent. C'est exactement la condition qui separe les deux univers
 * de `probe-rappel-et-cout.js`; toute autre definition mesurerait autre chose. */
const lisible = (t) => typeof t.siblingCount === 'number' && typeof t.freshDeployer === 'boolean';
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');

const resolus = rows.filter((t) => issue(t) !== null && String(t.firstSeen).length >= 10);
const jours = new Map();
for (const t of resolus) {
  const j = String(t.firstSeen).slice(0, 10);
  if (!jours.has(j)) jours.set(j, []);
  jours.get(j).push(t);
}
const series = [...jours.entries()].sort();

console.log('\n  ── LA COUVERTURE, JOUR PAR JOUR ──');
console.log('     « lisible » = `siblingCount` numerique ET `freshDeployer` booleen\n');
console.log('    jour          resolus  lisibles   couverture                 post-panne');
console.log('    ' + '-'.repeat(84));
for (const [j, g] of series) {
  const l = g.filter(lisible).length;
  const p = proportionAvecBornes(l, g.length);
  const rep = g.filter(reprise);
  const repTxt = rep.length
    ? String(rep.length).padStart(4) + ' tok, couv. ' + pct(rep.filter(lisible).length / rep.length)
    : '   —';
  console.log('    ' + j + String(g.length).padStart(9) + String(l).padStart(10) + '   '
    + ic(p).padEnd(24) + repTxt);
}

/* ── LA TENDANCE, ET ELLE SE JUGE SUR DES BORNES QUI SE CHEVAUCHENT OU NON ──────────────────────── */
const moitie = Math.floor(series.length / 2);
const agrege = (part) => {
  const g = part.flatMap(([, v]) => v);
  return { n: g.length, l: g.filter(lisible).length, p: proportionAvecBornes(g.filter(lisible).length, g.length) };
};
const p1 = agrege(series.slice(0, moitie)), p2 = agrege(series.slice(moitie));
console.log('\n  ── LA TENDANCE ──\n');
console.log('    1re moitie  ' + series[0][0] + ' -> ' + series[moitie - 1][0] + '   '
  + p1.l + '/' + p1.n + '   ' + ic(p1.p));
console.log('    2e  moitie  ' + series[moitie][0] + ' -> ' + series[series.length - 1][0] + '   '
  + p2.l + '/' + p2.n + '   ' + ic(p2.p));
if (p1.p.taux !== null && p2.p.taux !== null) {
  const d = 100 * (p2.p.taux - p1.p.taux);
  const disj = p1.p.haute < p2.p.basse || p2.p.haute < p1.p.basse;
  console.log('\n    ecart ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
    + (disj ? '💎 intervalles DISJOINTS — la couverture BOUGE vraiment'
      : '⛔ intervalles CHEVAUCHANTS — AUCUNE amelioration n est en cours'));
}

/* ── LA COMPOSITION DE L'ILLISIBILITE, QUI PEUT CHANGER SANS QUE LE TOTAL BOUGE ─────────────────── */
const classe = (t) => {
  const e = t.funderTrace;
  if (e === undefined) return 'champ absent';
  if (e === 'no_creator') return 'no_creator';
  if (e === 'failed') return 'failed';
  if (e === 'no_funder') return 'no_funder';
  return String(e);
};
console.log('\n  ── DE QUOI L ILLISIBILITE EST FAITE, PAR SEMAINE ──\n');
const semaines = [['1re moitie', series.slice(0, moitie)], ['2e moitie', series.slice(moitie)]];
for (const [nom, part] of semaines) {
  const ill = part.flatMap(([, v]) => v).filter((t) => !lisible(t));
  const m = new Map();
  for (const t of ill) m.set(classe(t), (m.get(classe(t)) || 0) + 1);
  console.log('    ' + nom.padEnd(12) + ill.length + ' illisible(s): '
    + [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => k + ' ' + n + ' (' + (100 * n / ill.length).toFixed(0) + ' %)').join('  '));
}
console.log('\n  ⚠️ Si le TOTAL ne bouge pas mais que la COMPOSITION se deplace de « champ absent » vers');
console.log('     « no_creator », alors ce que j ai appele « historique » a bien disparu — et a ete');
console.log('     REMPLACE a l identique par une cause permanente. Le remplacement est le resultat.');

console.log('\n  ⛔ CE QUE CETTE SONDE NE PEUT PAS FAIRE: prevoir. Une serie plate refute qu une amelioration');
console.log('     soit DEJA en cours; elle ne dit rien de ce qu un changement d instrument produirait.');
console.log('  ⛔ ET LES DERNIERS JOURS SONT INCOMPLETS par construction: un token sans issue n entre pas');
console.log('     dans ce calcul, donc le dernier jour porte moins de monde. Ce n est pas une chute.\n');
