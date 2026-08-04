#!/usr/bin/env node
// replay-no-erc20-record.js — « aucun enregistrement de securite ERC-20 » separe-t-il, hors 0xb200 ?
// ================================================================================================
// La piste 0xb200 a livre son mecanisme. Ce qui distingue les 156 de leurs 722 temoins n'est pas le
// prefixe, c'est leur `firstReason` :
//
//     « no ERC-20 security record exists »   0xb200 84,0 %   temoin 0,0 %   +84 pts
//
// Un prefixe vanity n'explique rien ; un contrat sans code analysable, si — le scanner de securite
// n'a rien a lire. La memoire b20-prefix-impersonation decrit exactement cette forme : prefixe B20 +
// precompile a ~0 octet de bytecode.
//
// Donc la question honnete n'est plus « le prefixe separe-t-il », c'est : **cette raison-la
// separe-t-elle sur TOUTE la base**, y compris hors 0xb200 ? Une regle qui ne vaut que sur les 156
// est une regle sur 156 tokens. Une regle sur le mecanisme vaut partout ou le mecanisme apparait.
//
// ⛔ MESURE ET RAPPORTE. Ne promeut rien : in-sample, sur les donnees qui l'ont produit.
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
const estB200 = (t) => String(t.addr).toLowerCase().startsWith('0xb200');

// La raison exacte, telle qu'elle est ecrite en base — pas une paraphrase.
const SANS_RECORD = /no ERC-20 security record/i;
const sansRecord = (t) => SANS_RECORD.test(String(t.firstReason || ''));

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(40)}     0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = ((r / g.length - BASE) * 100);
  console.log(`    ${label.padEnd(40)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${pct(r, g.length).padStart(6)} · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, o, lift };
}

console.log(`\n  taux de base : ${pct(rows.filter(rugged).length, rows.length)}  (${rows.length} tokens)`);

const avec = rows.filter(sansRecord);
const sans = rows.filter((t) => !sansRecord(t));

console.log('\n  la raison, sur TOUTE la base :');
ligne('« no ERC-20 security record »', avec);
ligne('tout le reste', sans);

// ── LE CONTROLE : la raison tient-elle HORS du groupe qui l'a fait remarquer ? ──────────────────
// Si elle ne separe que sur les 0xb200, c'est le prefixe qui parle et la raison n'est qu'une
// etiquette. Si elle separe aussi hors 0xb200, c'est le mecanisme.
console.log('\n  ⭐ LE CONTROLE : la raison, HORS 0xb200');
const horsB200 = rows.filter((t) => !estB200(t));
const a = ligne('hors 0xb200, AVEC la raison', horsB200.filter(sansRecord));
const b = ligne('hors 0xb200, SANS la raison', horsB200.filter((t) => !sansRecord(t)));
if (a && b) {
  const d = (a.r / a.n - b.r / b.n) * 100;
  console.log(`\n    -> ecart de la raison, prefixe exclu : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  if (a.n < 20) console.log(`    ⚠️ n=${a.n} hors prefixe : trop petit pour trancher. Indication, pas resultat.`);
  else if (Math.abs(d) < 5) console.log('    ⛔ La raison ne separe pas hors 0xb200 : c est le prefixe qui portait le signal.');
  else console.log('    La raison porte le signal hors du groupe qui l a fait remarquer.');
}

// Et l'inverse : le prefixe tient-il SANS la raison ?
console.log('\n  et le symetrique : le prefixe, chez ceux qui n ont PAS la raison');
ligne('0xb200 SANS la raison', rows.filter((t) => estB200(t) && !sansRecord(t)));
ligne('0xb200 AVEC la raison', rows.filter((t) => estB200(t) && sansRecord(t)));

console.log('\n  Lecture : celui des deux qui garde son ecart quand on neutralise l autre est le');
console.log('  mecanisme ; l autre n en est que la trace.');
