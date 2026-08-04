#!/usr/bin/env node
// replay-cleanband.js — combien de tokens basculent du vert vers « pas pu verifier » ?
// ================================================================================================
// Le correctif du 04/08 exige que l'historique du financeur ait REELLEMENT ete lu avant de placer un
// token dans la bande verte. Avant, un `siblingCount` absent passait la garde `sib === undefined` et
// le token ressortait sous « presque rien n'a rugge ici ».
//
// FORME REELLE DE LA BASE, lue et non devinee — la premiere version de ce script a inventé les noms
// de champs (`liq`, `survived`) et a sorti des zeros partout, la signature classique d'un nom
// invente :
//
//     liquidite     : firstLiq          (et non `liq` — `liq` est le champ du candidat en memoire)
//     issue         : outcome ∈ {rugged: 1399, live: 460}
//     freres        : siblingCount — 981 numeriques, 878 ABSENTS, 0 null
//     censure       : siblingCountCensored, present sur 868 lignes
//
// DEUX BORNES, PAS UN TAUX. `live` n'est pas « a survecu », c'est un appel OUVERT : un token vivant
// aujourd'hui peut rugger demain. Publier rugged/(rugged+live) comme un taux traiterait chaque appel
// ouvert comme une reussite. On donne donc les deux bornes, et le nombre d'ouverts avec.
//
// Lecture SEULE. Rien n'est ecrit, aucun verdict n'est reemis.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INDUSTRIAL_FUNDER = 20;
const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');

const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

// Les deux decisions, mot pour mot, sur le champ que la base porte vraiment.
const ancien = (t) => t.firstLiq >= 15000 && (t.siblingCount === undefined || t.siblingCount < INDUSTRIAL_FUNDER);
const nouveau = (t) => {
  const sib = t.siblingCount;
  const sibRead = typeof sib === 'number' && !t.siblingCountCensored;
  return t.firstLiq >= 15000 && sibRead && sib < INDUSTRIAL_FUNDER;
};

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');

/** Les deux bornes d'un groupe : au mieux tous les ouverts survivent, au pire tous ruggent. */
function bornes(group, label) {
  const r = group.filter(rugged).length;
  const o = group.filter(open).length;
  const n = group.length;
  const bas = pct(r, n);                 // les ouverts survivent tous
  const haut = pct(r + o, n);            // les ouverts ruggent tous
  console.log(`    ${label.padEnd(24)} ${String(n).padStart(5)} tokens · ${String(r).padStart(4)} rugges · ${String(o).padStart(4)} ouverts · taux entre ${bas} et ${haut}`);
  return { n, r, o };
}

const greenOld = rows.filter(ancien);
const greenNew = rows.filter(nouveau);
const flipped = greenOld.filter((t) => !nouveau(t));

console.log(`\n  base           : ${rows.length} tokens`);
console.log(`  vert AVANT     : ${greenOld.length}`);
console.log(`  vert APRES     : ${greenNew.length}`);
console.log(`  bascules -> ⚪ : ${flipped.length}  (${pct(flipped.length, greenOld.length)} de l'ancienne bande verte)`);

const jamaisLu = flipped.filter((t) => typeof t.siblingCount !== 'number').length;
console.log('\n  cause de la bascule :');
console.log(`    jamais lu (siblingCount absent)  ${jamaisLu}`);
console.log(`    compte censure (plancher)        ${flipped.length - jamaisLu}`);

console.log('\n  taux de rug, DEUX BORNES (les ouverts comptes des deux facons) :');
bornes(rows, 'toute la base');
bornes(greenOld, 'ancienne bande verte');
bornes(greenNew, 'nouvelle bande verte');
bornes(flipped, 'les BASCULES');

console.log('\n  Lecture : si les bascules ruggent PLUS que la bande gardee, le correctif a retire du');
console.log('  bruit reel. Si elles ruggent pareil, il a surtout retire de la couverture — a dire aussi.');
