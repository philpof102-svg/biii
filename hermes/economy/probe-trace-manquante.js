#!/usr/bin/env node
// probe-trace-manquante.js — quand la trace du financeur manque, l'ignorance est-elle NEUTRE ?
// ================================================================================================
// Mesure du 2026-08-07: quatre des six paris annonces ont un nombre de TIRAGES indetermine, parce que
// des tokens notes ne portent aucun financeur. Tant que l'absence de trace est aleatoire, l'ignorance
// est neutre — on sait juste moins. Si elle est CORRELEE a l'issue, elle est biaisee, et le taux par
// token des cartes penche dans un sens qu'on peut nommer.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: comment le taux de rug varie avec l'etat de trace, y compris a liquidite
// comparable, et combien de tokens chaque etat represente.
// ⛔ CE QU'ELLE NE PEUT PAS: donner un taux par TIRAGE du cote non trace. Un token sans createur lu n'a
// pas de financeur, donc pas d'unite d'independance — et ce n'est pas une lacune que le temps comblera,
// c'est une propriete de la donnee. L'indetermination des quatre paris est donc PERMANENTE de ce cote.
// ⛔ ELLE NE PEUT PAS NON PLUS conclure a une causalite. Un token dont l'explorateur ne nomme pas le
// createur a d'autres proprietes que celle-la.
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
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
const ETATS = ['ok', 'no_creator', 'failed', 'no_funder', 'ABSENT'];
const MARQUEUR_SANS_CREATEUR = 'records no creator';

const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const bornes = (g) => {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  return { n: g.length, res: res.length, rug, p: proportionAvecBornes(rug, res.length) };
};

console.log('\n  ── L ETAT DE TRACE ET L ISSUE ──\n');
console.log('    etat          tokens  resolus   rug   taux par token        porte un funder ?');
console.log('    ' + '-'.repeat(88));
for (const e of ETATS) {
  const g = rows.filter((t) => etat(t) === e);
  const b = bornes(g);
  const avecF = g.filter((t) => typeof t.funder === 'string' && t.funder.length > 10).length;
  const ic = b.p.taux === null ? '     —' : pct(b.p.taux) + ' [' + pct(b.p.basse).trim() + '–' + pct(b.p.haute).trim() + ']';
  console.log('    ' + e.padEnd(12) + String(b.n).padStart(6) + String(b.res).padStart(9)
    + String(b.rug).padStart(6) + '   ' + ic.padEnd(25) + avecF + ' / ' + b.n);
}

/* ── LA CORRECTION QUI DESAMORCE LA LECTURE LA PLUS ALARMANTE ────────────────────────────────────
 * `failed` se lit « l'explorateur est tombe », et un taux de rug eleve sur cet etat suggererait que les
 * pannes visent les rugs. Le depot a deja corrige ce classement le 2026-07-30 pour les tokens NEUFS,
 * mais les lignes anterieures gardent l'ancienne etiquette. On le VERIFIE au lieu de le supposer. */
const failed = rows.filter((t) => etat(t) === 'failed');
const legacy = failed.filter((t) => String(t.funderTraceError || '').includes(MARQUEUR_SANS_CREATEUR));
console.log('\n  ── ⛔ `failed` NE VEUT PAS DIRE « PANNE » ──\n');
console.log('    tokens en etat `failed`                              ' + failed.length);
console.log('    dont le MESSAGE dit « pas de createur indexe »       ' + legacy.length
  + (failed.length ? '   (' + (100 * legacy.length / failed.length).toFixed(0) + ' %)' : ''));
console.log('    veritables non-reponses de l explorateur             ' + (failed.length - legacy.length));
console.log('  ⚠️ Le classement a ete corrige le 2026-07-30 pour les tokens NEUFS; les lignes anterieures');
console.log('     gardent l ancienne etiquette. Lire « ' + (100 * legacy.length / failed.length).toFixed(0)
  + ' % de rug sur les pannes d explorateur » serait donc faux:');
console.log('     l essentiel de ce seau n est pas une panne, c est un constat definitif.');

/* ── LE CONTROLE QUI DECIDE: A LIQUIDITE COMPARABLE, L ECART SURVIT-IL ? ─────────────────────────
 * `token-radar.js` trie les candidats a la trace par liquidite DECROISSANTE et coupe a TRACE_MAX. Un
 * token peu liquide attend donc des passages entiers avant d'etre trace — et la liquidite est un
 * predicteur de rug connu. Sans stratifier, on mesurerait la file d'attente, pas la trace. */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
const STRATES = [
  ['basse   ', (l) => l < q1],
  ['moyenne ', (l) => l >= q1 && l < q2],
  ['haute   ', (l) => l >= q2],
];
console.log('\n  ── LE CONTROLE: MEME LIQUIDITE INITIALE, ETATS DIFFERENTS ──\n');
console.log('    tertiles de firstLiq: < ' + Math.round(q1) + '  |  ' + Math.round(q1) + ' a '
  + Math.round(q2) + '  |  > ' + Math.round(q2));
console.log('\n    etat          liq basse          liq moyenne        liq haute');
const cellules = {};
for (const e of ETATS) {
  const ligne = STRATES.map(([, pred]) => {
    const g = rows.filter((t) => etat(t) === e && Number.isFinite(t.firstLiq) && pred(t.firstLiq));
    const b = bornes(g);
    return b.res ? b : null;
  });
  cellules[e] = ligne;
  console.log('    ' + e.padEnd(12) + ligne.map((b) => (b
    ? (pct(b.p.taux).trim() + ' (' + b.res + ')').padEnd(19)
    : '—'.padEnd(19))).join(''));
}

/* Le fait qui porte la conclusion: la liquidite PROTEGE-t-elle dans chaque etat ? */
console.log('\n  ── CE QUE LA LIQUIDITE FAIT, ET NE FAIT PAS ──\n');
for (const e of ETATS) {
  const [bas, , haut] = cellules[e];
  if (!bas || !haut || bas.p.taux === null || haut.p.taux === null) continue;
  const delta = 100 * (haut.p.taux - bas.p.taux);
  console.log('    ' + e.padEnd(12) + 'basse ' + pct(bas.p.taux) + '  ->  haute ' + pct(haut.p.taux)
    + '   ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' pts'
    + (delta < -10 ? '   <- la liquidite protege' : delta > 5 ? '   <- elle ne protege PAS' : ''));
}

/* La comparaison qui interesse un acheteur: a HAUTE liquidite, ok contre no_creator. */
const okHaut = cellules.ok[2], ncHaut = cellules.no_creator[2];
if (okHaut && ncHaut && okHaut.p.taux !== null && ncHaut.p.taux !== null) {
  console.log('\n    💎 DANS LA STRATE HAUTE — celle qu un acheteur lit comme la plus sure:');
  console.log('       createur LU        ' + pct(okHaut.p.taux) + ' [' + pct(okHaut.p.basse).trim() + '–'
    + pct(okHaut.p.haute).trim() + ']  sur ' + okHaut.res + ' resolus');
  console.log('       createur NON LU    ' + pct(ncHaut.p.taux) + ' [' + pct(ncHaut.p.basse).trim() + '–'
    + pct(ncHaut.p.haute).trim() + ']  sur ' + ncHaut.res + ' resolus');
  console.log('       ecart              ' + (100 * (ncHaut.p.taux - okHaut.p.taux)).toFixed(1) + ' points'
    + (okHaut.p.haute < ncHaut.p.basse ? '   (les intervalles NE SE CHEVAUCHENT PAS)'
      : '   ⚠️ les intervalles se chevauchent — l ecart n est pas etabli'));
}

console.log('\n  ⛔ ET VOICI LA BORNE QUI NE SE LEVERA PAS. Un token dont l explorateur ne nomme pas le');
console.log('     createur n a pas de financeur — donc aucune unite d independance. Le taux ci-dessus est');
console.log('     et restera un taux PAR TOKEN: aucun compte de tirages n existe de ce cote, et le temps');
console.log('     n y changera rien. L indetermination des quatre paris est PERMANENTE, pas provisoire.');
console.log('  ⛔ AUCUNE CAUSALITE N EST AFFIRMEE. « Createur non indexe » va avec d autres proprietes');
console.log('     (proxy, deploiement par usine, creation anterieure a l index) qui ne sont pas mesurees ici.');
console.log('  ⚠️ La stratification se fait sur `firstLiq`, la liquidite a la PREMIERE VUE. Elle ne dit rien');
console.log('     de ce que la liquidite est devenue ensuite, et la file d attente de trace peut encore');
console.log('     porter un reste de biais que trois strates ne suffisent pas a retirer.\n');
