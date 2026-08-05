#!/usr/bin/env node
// probe-readme-claims.js — les chiffres que le README presente comme des faits, contre leur source.
// ================================================================================================
// Meme question que celle qui a tue `baseWR` dans polymarket-bot: un nombre ecrit une fois, presente
// comme mesure, recopie ensuite. Ici chaque chiffre a une source LISIBLE dans ce depot, donc l'ecart
// se constate au lieu de se discuter.
//
// Ce que cet instrument peut prouver: la valeur actuelle de chaque grandeur citee.
// Ce qu'il ne peut PAS prouver: que le README etait faux le jour ou il a ete ecrit.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..', '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');

const lignes = [];
const compare = (quoi, annonce, reel, ou) => lignes.push({ quoi, annonce, reel, ou });

/* ── registre issuer-verified ───────────────────────────────────────────────────────────────── */
const reg = JSON.parse(lire('data/issuer-verified.json'));
const entrees = Array.isArray(reg) ? reg : (reg.entries || reg.assets || Object.values(reg).find(Array.isArray) || []);
const chaines = new Set(entrees.map((e) => e.chainId));
compare('entrees issuer-verified', 147, entrees.length, 'data/issuer-verified.json');
compare('chaines distinctes', 9, chaines.size, 'data/issuer-verified.json');

/* Par source, tel que le README les detaille. */
const parSource = new Map();
for (const e of entrees) {
  const s = e.source || e.issuer || e.provenanceSource || '(non renseigne)';
  parSource.set(s, (parSource.get(s) || 0) + 1);
}

/* ── outils MCP ─────────────────────────────────────────────────────────────────────────────── */
const mcp = lire('bin/biii-mcp.js');
const outils = new Set([...mcp.matchAll(/name:\s*'(till_[a-z_]+)'/g)].map((m) => m[1]));
compare('outils MCP', 15, outils.size, 'bin/biii-mcp.js');

/* ── harnais d'eval ─────────────────────────────────────────────────────────────────────────── */
const evalSrc = lire('eval/verdict-harness.js');
const casEval = [...evalSrc.matchAll(/\bcases?\s*[:=]\s*\[/g)].length;
compare('cas du harnais eval (annonce README)', 17, null, 'eval/verdict-harness.js — lire la sortie de npm test');

console.log('\n  chiffres du README contre leur source :\n');
console.log('    grandeur                          annonce      reel   verdict');
console.log('    ' + '-'.repeat(70));
let faux = 0, justes = 0, indecidables = 0;
for (const l of lignes) {
  if (l.reel == null) { indecidables++; console.log(`    ${l.quoi.padEnd(32)} ${String(l.annonce).padStart(7)}   ${'n/a'.padStart(7)}   a lire ailleurs`); continue; }
  const ok = l.annonce === l.reel;
  if (ok) justes++; else faux++;
  console.log(`    ${l.quoi.padEnd(32)} ${String(l.annonce).padStart(7)}   ${String(l.reel).padStart(7)}   ${ok ? 'juste' : 'ECART'}`);
}

console.log('\n  detail du registre par source, avec ses chaines :');
const chainesParSource = new Map();
for (const e of entrees) {
  const s = e.source || e.issuer || e.provenanceSource || '(non renseigne)';
  if (!chainesParSource.has(s)) chainesParSource.set(s, new Set());
  chainesParSource.get(s).add(e.chainId);
}
for (const [s, n] of [...parSource.entries()].sort((a, b) => b[1] - a[1])) {
  const ch = [...chainesParSource.get(s)].sort((a, b) => a - b);
  console.log(`    ${String(n).padStart(4)}  chaines [${ch.join(', ')}]  ${String(s).slice(0, 52)}`);
}
console.log(`\n  chaines presentes : ${[...chaines].sort((a, b) => a - b).join(', ')}`);
console.log(`\n  ${justes} juste(s) · ${faux} ecart(s) · ${indecidables} a verifier autrement`);
console.log('  ⚠️ Un ecart ne dit PAS que le chiffre etait faux a l ecriture — il dit qu il n a pas suivi.\n');
