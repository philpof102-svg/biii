#!/usr/bin/env node
// replay-b200-shape.js — la FORME de l'adresse, comptee et non regardee.
// ================================================================================================
// Les quatre echantillons du bras « no ERC-20 security record » ressemblent a ca :
//
//     0xb200000000000000000000a06071a9363fb0e13f
//     0xb200fb5839afa4d7761981143617c5799f063b7f   <- et celle-la, non
//
// Un tunnel de zeros AU MILIEU d'une adresse ne se mine pas : chaque zero impose un facteur 16, et
// on est ici a plusieurs milliards de milliards d'essais. Une adresse comme ca n'est pas derivee
// d'un CREATE/CREATE2 — elle est CONSTRUITE. C'est un identifiant structure, pas un contrat.
//
// Si c'est vrai, « no ERC-20 security record exists » n'est pas un signal de risque : c'est le
// scanner qui dit correctement qu'il n'y a pas d'ERC-20 a scanner. Notre verdict `caution` mesurerait
// alors NOTRE angle mort, pas le token — et un angle mort etiquete « prudence » est exactement le
// motif qu'on passe la nuit a retirer : une lecture impossible devenue une affirmation sur le monde.
//
// Ce script COMPTE la forme. Il ne la regarde pas. Aucune valeur n'est recopiee a la main.
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
const SANS_RECORD = /no ERC-20 security record/i;

/** Le plus long tunnel de zeros consecutifs, compte — jamais estime a l'oeil. */
function plusLongTunnel(addr) {
  const hex = String(addr).toLowerCase().replace(/^0x/, '');
  let max = 0, cur = 0;
  for (const c of hex) { cur = c === '0' ? cur + 1 : 0; if (cur > max) max = cur; }
  return max;
}

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(44)}     0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = (r / g.length - BASE) * 100;
  // Les deux bornes, toujours : un appel ouvert n'est ni un succes ni un echec, et le taux ne peut
  // que MONTER quand ils se resolvent. Publier la basse seule serait vendre l'optimisme.
  const haute = (r + o) / g.length;
  console.log(`    ${label.padEnd(44)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${pct(r, g.length).padStart(6)} .. ${pct(r + o, g.length).padStart(6)} · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, o, bas: r / g.length, haut: haute };
}

const b200 = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));

console.log(`\n  taux de base : ${pct(rows.filter(rugged).length, rows.length)}  (${rows.length} tokens)`);
console.log(`  colonnes     : n · rugges · ouverts · [borne basse .. borne haute] · lift sur la basse\n`);

// ── 1. la forme existe-t-elle ailleurs que dans les 0xb200 ? ────────────────────────────────────
const STRUCTURE = 12;   // 12 zeros consecutifs = 16^12 ~ 3e14 essais : hors de portee d'un mineur.
const structure = (t) => plusLongTunnel(t.addr) >= STRUCTURE;

console.log(`  ── forme structuree (>= ${STRUCTURE} zeros consecutifs) sur TOUTE la base ──`);
ligne('adresse structuree', rows.filter(structure));
ligne('adresse ordinaire', rows.filter((t) => !structure(t)));

const struct = rows.filter(structure);
const structHorsB200 = struct.filter((t) => !String(t.addr).toLowerCase().startsWith('0xb200'));
console.log(`\n    dont HORS 0xb200 : ${structHorsB200.length}`);
if (!structHorsB200.length) console.log('    -> la forme n existe que sous ce prefixe : encore colineaire, rien a isoler ici.');

// ── 2. la forme et la raison : est-ce la MEME chose ? ───────────────────────────────────────────
// Si tout token structure est exactement un token « sans enregistrement ERC-20 », alors la raison
// n'est que le nom que notre scanner donne a la forme, et il n'y a qu'UN fait, pas deux.
console.log('\n  ── forme x raison, dans les 156 ──');
const q = (f, r) => b200.filter((t) => structure(t) === f && SANS_RECORD.test(String(t.firstReason || '')) === r);
ligne('structuree ET sans record', q(true, true));
ligne('structuree ET avec un autre motif', q(true, false));
ligne('ordinaire ET sans record', q(false, true));
ligne('ordinaire ET avec un autre motif', q(false, false));

// ── 3. le decoupage qui compte : forme structuree vs adresse ordinaire, SOUS le prefixe ─────────
console.log('\n  ⭐ sous le prefixe, la FORME separe-t-elle ?');
const a = ligne('0xb200 structuree', b200.filter(structure));
const b = ligne('0xb200 ordinaire', b200.filter((t) => !structure(t)));
if (a && b) {
  const d = (a.bas - b.bas) * 100;
  console.log(`\n    -> ecart sur la borne BASSE : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  // Le test qui compte n'est pas l'ecart, c'est sa SURVIE au pire cas des appels ouverts.
  const inversable = a.bas < b.haut && b.bas < a.haut;
  console.log(inversable
    ? '    ⚠️ Les intervalles se CHEVAUCHENT : la resolution des appels ouverts peut inverser l ordre.'
    : '    Les intervalles sont disjoints : l ordre survit au pire cas des appels ouverts.');
}

console.log('\n  ── ce que ces tokens declarent (source / chain) ──');
for (const champ of ['source', 'chain']) {
  const m = new Map();
  for (const t of b200.filter(structure)) { const v = String(t[champ] ?? '(absent)'); m.set(v, (m.get(v) || 0) + 1); }
  const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  console.log(`    ${champ.padEnd(8)} ${top.map(([v, n]) => `${v}=${n}`).join('  ')}`);
}
