#!/usr/bin/env node
// replay-rugready.js — le palier le plus severe est-il un residu, ou une regle vivante qui rate ?
// ================================================================================================
// `rug_ready` mesure −1,6 pt contre le taux de base (38 tokens, 73,7 % contre 75,3 %). Avant de
// crier au defaut, il faut savoir QUI a pose ces verdicts.
//
// Le fichier documente deja qu'une regle a ete TUEE le 26/07 : l'usurpation de symbole posait
// `rug_ready` et mesurait 80 % contre 81 % de base (n=10), soit −1 pt, et −14 pts sur sa
// contribution propre une fois retirees les prises que la regle du financeur attrapait deja. Elle
// portait 13 des 13 `rug_ready` de l'epoque. Le commentaire conclut : « The tier stays empty ».
//
// Or ligne 354 une AUTRE regle pose encore `rug_ready` : un token qui porte le prefixe d'adresse
// B20 (0xb200…) en embarquant du bytecode ERC-20 ordinaire. Donc le palier n'est pas vide.
//
// La question mesuree ici : parmi les 38, combien viennent de la regle morte (residu historique,
// `firstVerdict` n'est jamais reecrit) et combien de la regle vivante ? Un palier plat compose de
// residu est un fait d'archive ; un palier plat compose de verdicts VIVANTS est un defaut.
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
const BASE = rows.filter(rugged).length / rows.length;

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(34)}     0 —`); return; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = ((r / g.length - BASE) * 100).toFixed(1);
  console.log(`    ${label.padEnd(34)} ${String(g.length).padStart(5)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${pct(r, g.length).padStart(6)} · ${r / g.length >= BASE ? '+' : ''}${lift} pts`);
}

console.log(`\n  taux de base : ${pct(rows.filter(rugged).length, rows.length)}`);

const rr = rows.filter((t) => t.firstVerdict === 'rug_ready');
console.log(`\n  rug_ready total : ${rr.length}`);

// La regle morte laissait une trace : le champ `impersonates` (ou l'ancien symbolVerdict).
const parUsurpation = rr.filter((t) => t.impersonates !== undefined || t.symbolVerdict === 'impersonation');
const autres = rr.filter((t) => !(t.impersonates !== undefined || t.symbolVerdict === 'impersonation'));

console.log('\n  d ou viennent-ils :');
ligne('regle MORTE (usurpation symbole)', parUsurpation);
ligne('autre origine (regle vivante ?)', autres);

// Le prefixe B20 : la regle vivante ligne 354. Trace-t-elle quelque chose dans la base ?
const b20 = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));
console.log('\n  la regle VIVANTE (prefixe 0xb200 + bytecode ERC-20) :');
ligne('adresses en 0xb200…', b20);
console.log(`    dont rug_ready : ${b20.filter((t) => t.firstVerdict === 'rug_ready').length}`);

// Et la comparaison qui tranche : le palier du dessous.
console.log('\n  pour comparer :');
ligne('high_risk', rows.filter((t) => t.firstVerdict === 'high_risk'));
ligne('caution', rows.filter((t) => t.firstVerdict === 'caution'));

console.log('\n  Lecture : si les 38 sont du residu de la regle morte, le palier plat est une archive');
console.log('  et non un defaut — mais un consommateur qui lit `firstVerdict` aujourd hui ne peut pas');
console.log('  le savoir. Si une part vient d une regle vivante, c est cette regle qu il faut mesurer.');
