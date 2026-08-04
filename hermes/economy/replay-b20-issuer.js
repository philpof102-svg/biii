#!/usr/bin/env node
// replay-b20-issuer.js — les 155 natifs B20 sortent-ils du meme emetteur ?
// ================================================================================================
// Contexte acquis hors du depot le 2026-08-04 : B20 est le standard NATIF de Base (active le
// 2026-07-08, superset ERC-20 tournant en precompile), et `b20.o1.exchange` en est le premier
// launchpad — 8 045 tokens crees en 72 h selon son propre communique. Sa documentation annonce que
// tout ce qui est minte chez lui porte une adresse FINISSANT par « 01 ».
//
// C'est une revendication testable sur nos donnees, et elle vaut d'etre testee des deux cotes : si le
// suffixe separe, on peut attribuer une partie du standard a un emetteur ; s'il ne separe pas, la
// revendication ne se lit pas dans nos adresses et on n'attribue rien.
//
// ⚠️ CE QUE CE SCRIPT NE PEUT PAS DIRE. Un suffixe d'adresse est une convention publiee, pas une
// preuve de paternite : rien n'empeche un tiers de miner la meme terminaison. L'attribution reste une
// LECTURE, pas une identification. Et « rapporter la structure, jamais l'intention » s'applique
// entierement ici — un launchpad et une usine a rugs ont exactement le meme graphe.
//
// ⚠️⚠️ ET LE BIAIS QUI DOMINE TOUT LE RESTE : nous ne voyons que 156 adresses 0xb200 sur les ~8 045
// annoncees, soit ~1,9 %. Notre radar n'entre un token que s'il ouvre un POOL avec de la liquidite.
// Donc 83,9 % n'est pas « le taux de rug des B20 » — c'est celui des B20 assez avances pour avoir un
// pool observable. Population selectionnee. Ce chiffre ne se publie jamais sans cette phrase.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const BASE = rows.filter(rugged).length / rows.length;

// Le natif se lit par le CODE sonde on-chain (155/156 rendent exactement 0xef). Faute de stocker le
// code, on rejoue par l'adresse — la correspondance a ete verifiee 1:1 sur les 156 par probe-b200-code.js.
const IMPOSTEUR = '0xb200fb5839afa4d7761981143617c5799f063b7f';
const natifs = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200')
  && String(t.addr).toLowerCase() !== IMPOSTEUR);

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(40)}     0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = (r / g.length - BASE) * 100;
  console.log(`    ${label.padEnd(40)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · `
    + `${((r / g.length) * 100).toFixed(1).padStart(5)}% .. ${(((r + o) / g.length) * 100).toFixed(1).padStart(5)}% · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, o, bas: r / g.length, haut: (r + o) / g.length };
}

console.log(`\n  taux de base : ${(BASE * 100).toFixed(1)}%  ·  natifs B20 observes : ${natifs.length}`);
console.log('  colonnes : n · rug · ouverts · [borne basse .. borne haute] · lift sur la basse\n');

// ── la revendication : suffixe « 01 » ───────────────────────────────────────────────────────────
const suffixe01 = (t) => String(t.addr).toLowerCase().endsWith('01');
console.log('  ── suffixe « 01 » (convention annoncee par le launchpad o1) ──');
const a = ligne('natifs finissant par 01', natifs.filter(suffixe01));
const b = ligne('natifs NE finissant PAS par 01', natifs.filter((t) => !suffixe01(t)));

// Le controle indispensable : si le suffixe apparait au hasard, sa frequence doit etre proche de
// 1/256. Une frequence tres superieure indique une convention reellement appliquee; une frequence
// conforme au hasard signifie qu'on n'a rien attribue du tout.
const attendu = natifs.length / 256;
const observe = natifs.filter(suffixe01).length;
console.log(`\n    frequence : ${observe} observes contre ${attendu.toFixed(1)} attendus par hasard (1/256)`);
if (observe <= Math.max(2, attendu * 2)) {
  console.log('    ⛔ Conforme au hasard : le suffixe n attribue RIEN dans nos donnees.');
  console.log('       Ne pas nommer d emetteur. La convention existe peut-etre sans etre lisible ici.');
} else if (a && b) {
  const d = (a.bas - b.bas) * 100;
  console.log(`    Convention lisible. Ecart de rug entre les deux groupes : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  const chevauche = a.bas < b.haut && b.bas < a.haut;
  console.log(chevauche
    ? '    ⚠️ Intervalles chevauchants : les appels ouverts peuvent inverser l ordre.'
    : '    Intervalles disjoints : l ordre survit au pire cas.');
}

// ── et le controle de population, qui domine tout ────────────────────────────────────────────────
console.log('\n  ── couverture : ce que nous voyons du standard ──');
console.log(`    natifs B20 dans notre base : ${natifs.length}`);
console.log('    annonces par le launchpad  : ~8045 en 72h (source externe, NON verifiee par nous)');
console.log(`    part observee              : ~${((natifs.length / 8045) * 100).toFixed(1)}%`);
console.log('    -> notre taux ne decrit que les B20 ayant ouvert un POOL observable, pas le standard.');
