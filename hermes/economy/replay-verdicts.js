#!/usr/bin/env node
// replay-verdicts.js — les verdicts ROUGES separent-ils, sur la meme base que la bande verte ?
// ================================================================================================
// Le rejeu du 04/08 a montre que la bande verte ne separe pas : 64,4 % de rugs contre 75,3 % de taux
// de base, et 72,5 % apres correctif. La question honnete qui suit est symetrique — si le vert ne
// dit rien, est-ce que le rouge dit quelque chose ?
//
// C'est la question INVERSEE, et elle merite d'etre posee dans cet ordre : un radar dont les verdicts
// rouges ne separent pas non plus n'est pas un radar, c'est un generateur d'alertes.
//
// LE PIEGE DE CETTE BASE, a garder en tete en lisant les chiffres :
//
//   1. Le taux de base est 75,3 %. Un verdict a 80 % n'est PAS bon ici — il fait +5 points. Sur une
//      base a 56 % (celle du backtest d'origine), 83 % faisait +27. Le meme pourcentage ne vaut pas
//      la meme chose selon ce qu'il bat.
//   2. Il n'y a pas d'etat « survecu » : `rugged` ou `live`. Les `live` sont des appels OUVERTS, pas
//      des succes. On les compte separement, jamais comme des reussites.
//   3. Biais de survivant deja documente dans ce depot : la boucle de re-jugement ne tourne que sur
//      `outcome === 'live'`. On lit donc `firstVerdict` (le verdict au PREMIER contact), pas un
//      verdict courant qui aurait ete revu seulement pour les survivants.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');

const BASE_N = rows.length;
const BASE_R = rows.filter(rugged).length;
const BASE = BASE_R / BASE_N;

function ligne(label, group) {
  const n = group.length;
  if (!n) { console.log(`    ${label.padEnd(22)} ${String(n).padStart(5)} —`); return; }
  const r = group.filter(rugged).length;
  const o = group.filter(open).length;
  const rate = r / n;
  const lift = ((rate - BASE) * 100).toFixed(1);
  const sign = rate >= BASE ? '+' : '';
  console.log(`    ${label.padEnd(22)} ${String(n).padStart(5)} tokens · ${String(r).padStart(4)} rugges · ${String(o).padStart(4)} ouverts · ${pct(r, n).padStart(6)} · ${sign}${lift} pts`);
}

console.log(`\n  taux de base : ${BASE_R}/${BASE_N} = ${pct(BASE_R, BASE_N)}  <- tout verdict se juge CONTRE ca`);

// 1. Chaque valeur de firstVerdict, telle qu'elle est en base.
const verdicts = {};
for (const t of rows) { const v = String(t.firstVerdict ?? 'aucun'); (verdicts[v] ||= []).push(t); }
console.log('\n  par firstVerdict (verdict au PREMIER contact) :');
for (const [v, g] of Object.entries(verdicts).sort((a, b) => b[1].length - a[1].length)) ligne(v, g);

// 2. Le rouge agrege — c'est la promesse du produit, pas les etiquettes internes.
const rouge = rows.filter((t) => t.firstVerdict === 'rug_ready' || t.firstVerdict === 'high_risk');
const pasRouge = rows.filter((t) => t.firstVerdict !== 'rug_ready' && t.firstVerdict !== 'high_risk');
console.log('\n  rouge agrege vs le reste :');
ligne('ROUGE (les deux)', rouge);
ligne('tout le reste', pasRouge);

// 3. Le rappel : sur tous les rugs de la base, combien le rouge en attrape-t-il ? Une precision
//    elevee sur 12 tokens ne vaut rien si 1387 rugs passent a cote.
const rugsAttrapes = rouge.filter(rugged).length;
console.log('\n  rappel :');
console.log(`    rugs attrapes par le rouge : ${rugsAttrapes}/${BASE_R} = ${pct(rugsAttrapes, BASE_R)}`);
console.log(`    part de la base marquee    : ${rouge.length}/${BASE_N} = ${pct(rouge.length, BASE_N)}`);

// 4. La moitie qui avait survecu a son backtest : le financeur industriel, isole.
const INDUSTRIAL = 20;
const usine = rows.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount >= INDUSTRIAL);
const pasUsine = rows.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < INDUSTRIAL);
console.log('\n  la condition « financeur industriel », isolee (uniquement les comptes LUS) :');
ligne(`>= ${INDUSTRIAL} freres`, usine);
ligne(`< ${INDUSTRIAL} freres`, pasUsine);

// 5. Et le seuil de liquidite, isole lui aussi.
const petit = rows.filter((t) => typeof t.firstLiq === 'number' && t.firstLiq < 15000);
const gros = rows.filter((t) => typeof t.firstLiq === 'number' && t.firstLiq >= 15000);
console.log('\n  la condition « seed < 15k$ », isolee :');
ligne('< 15k$', petit);
ligne('>= 15k$', gros);

console.log('\n  Lecture : une colonne « pts » proche de zero veut dire que le verdict ne dit rien que');
console.log('  le taux de base ne disait deja. Seul un ecart franc, sur un effectif non trivial, compte.');
