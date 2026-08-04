#!/usr/bin/env node
// replay-caution-homogene.js — `caution` est-il un seau, ou deux populations empilees ?
// ================================================================================================
// `caution` a ete mesure a 57,0 % contre 75,3 % de base, soit −18,3 pts : le meilleur signal prudent
// du radar, et je l'ai recommande comme tel. Puis le sondage on-chain a montre que 155 tokens natifs
// B20 ruggent a 83,9 % — et 94,9 % d'entre eux portent precisement le verdict `caution`.
//
// Donc le seau que je vends comme « prudent » contient une sous-population qui rugge 27 points AU
// DESSUS de la moyenne du seau. Une moyenne qui recouvre deux regimes opposes n'est pas un signal,
// c'est un melange — et c'est la faute exacte du 26/07 (« gros lancement = dangereux » n'etait qu'un
// seul operateur deguise en loi du marche, et 13 des 14 gros rugs partageaient un financeur).
//
// La question : en retirant les natifs, `caution` devient-il plus net, ou s'effondre-t-il ?
// Les deux reponses valent d'etre publiees. Si retirer 155 tokens ameliore le signal, la
// recommandation produit change — on ne vend pas `caution`, on vend `caution SAUF natifs B20`.
//
// ⛔ MESURE in-sample. Ne promeut rien : le decoupage a ete choisi APRES avoir vu les outcomes.
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const BASE = rows.filter(rugged).length / rows.length;

// Le natif B20 se lit par le CODE, sonde on-chain : 155/156 des prefixes rendent exactement `0xef`,
// et EIP-3541 interdit de deployer ce marqueur, donc il ne se contrefait pas. Le seul prefixe qui
// n'est pas natif porte du bytecode ERC-20 complet — c'est l'imposteur, deja arme par la regle vivante.
// Faute de stocker le code en base, on le rejoue par l'adresse : la correspondance est 1:1 sur 156.
const IMPOSTEUR = '0xb200fb5839afa4d7761981143617c5799f063b7f';
const natifB20 = (t) => String(t.addr).toLowerCase().startsWith('0xb200') && t.addr.toLowerCase() !== IMPOSTEUR;

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(38)}     0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = (r / g.length - BASE) * 100;
  console.log(`    ${label.padEnd(38)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${((r / g.length) * 100).toFixed(1).padStart(5)}% .. ${(((r + o) / g.length) * 100).toFixed(1).padStart(5)}% · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, o, bas: r / g.length };
}

console.log(`\n  taux de base : ${(BASE * 100).toFixed(1)}%  (${rows.length} tokens)`);
console.log('  colonnes     : n · rug · ouverts · [borne basse .. borne haute] · lift sur la basse\n');

// Le meme decoupage applique a CHAQUE verdict, pas seulement a celui qui m'interesse. Ne regarder
// que `caution` reviendrait a choisir ou creuser d'apres le resultat espere.
console.log('  ── chaque verdict, natifs B20 retires ──');
for (const v of ['clean', 'caution', 'unknown', 'high_risk', 'rug_ready']) {
  const g = rows.filter((t) => t.firstVerdict === v);
  if (!g.length) continue;
  const tout = ligne(v, g);
  const sans = ligne(`  ${v} SANS natifs B20`, g.filter((t) => !natifB20(t)));
  const nat = g.filter(natifB20);
  if (nat.length) ligne(`  ${v} natifs B20 seuls`, nat);
  if (tout && sans && nat.length) {
    const d = (sans.bas - tout.bas) * 100;
    console.log(`      -> retirer ${nat.length} natifs deplace ${v} de ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  }
  console.log('');
}

// Et la question inverse, qui est celle du produit : si on SORT les natifs comme leur propre classe,
// combien de rugs cette classe attrape-t-elle, et a quel prix en actifs conformes marques ?
console.log('  ── les natifs B20 comme classe a part ──');
const nat = rows.filter(natifB20);
const reste = rows.filter((t) => !natifB20(t));
ligne('natifs B20', nat);
ligne('tout le reste', reste);
const rugsTotal = rows.filter(rugged).length;
console.log(`\n    rappel : ${nat.filter(rugged).length}/${rugsTotal} = ${((nat.filter(rugged).length / rugsTotal) * 100).toFixed(1)}% des rugs, en marquant ${((nat.length / rows.length) * 100).toFixed(1)}% de la base`);
console.log(`    cout   : ${nat.filter(open).length} appels OUVERTS marques — des actifs conformes qui n ont rien fait de mal a ce jour`);
console.log('\n  ⛔ Aucun de ces chiffres ne promeut un palier : le decoupage a ete choisi apres avoir vu');
console.log('     les outcomes. Ce qui tranche est un test prequentiel — annoncer avant, noter apres.');
