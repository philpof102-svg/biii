#!/usr/bin/env node
// probe-quartile-degenerate.js — a quoi ressemble VRAIMENT une distribution ecrasee.
// ================================================================================================
// Le garde de `replay-basis-fields.js` teste `q1 === q3` en egalite EXACTE. Sur `lpLockedPct` il a
// laisse passer q1=0 contre q3=3.16e-14: deux nombres differents, le meme zero en substance. Avant
// de choisir un remplacant, on regarde ce que les champs reels donnent — un critere invente au
// jugé serait le meme defaut sous un autre nom.
//
// Ce que cet instrument peut prouver: la forme des distributions reelles du jeu.
// Ce qu'il ne peut PAS prouver: qu'un critere derive ici tiendra sur un champ futur.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const val = (t, champ) => { const b = basis(t); return b ? b[champ] : undefined; };

for (const champ of ['holders', 'lpLockedPct', 'topWalletPct', 'unreadable']) {
  const v = rows.map((t) => val(t, champ)).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) { console.log(`\n  ${champ}: aucune valeur lue`); continue; }
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const distincts = new Set(v).size;
  const seaux = [
    v.filter((x) => x <= q1).length,
    v.filter((x) => x > q1 && x <= q2).length,
    v.filter((x) => x > q2 && x <= q3).length,
    v.filter((x) => x > q3).length,
  ];
  const etendue = v[v.length - 1] - v[0];
  const interQ = q3 - q1;
  console.log(`\n  ── ${champ} ──`);
  console.log(`     n lus=${v.length} · distincts=${distincts} · min=${v[0]} · max=${v[v.length - 1]}`);
  console.log(`     q1=${q1} · median=${q2} · q3=${q3}`);
  console.log(`     q3-q1 = ${interQ}  ·  max-min = ${etendue}  ·  ratio = ${etendue ? (interQ / etendue).toExponential(3) : 'n/a'}`);
  console.log(`     tailles des 4 seaux : ${seaux.join(' · ')}   (vides: ${seaux.filter((n) => n === 0).length})`);
  console.log(`     q1 === q3 ? ${q1 === q3}`);
}
console.log('');
