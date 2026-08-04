#!/usr/bin/env node
// probe-fields.js — quels champs existent VRAIMENT, et lesquels sont des instantanes d'aujourd'hui ?
// ================================================================================================
// Deux fois cette nuit un resultat entierement a zero a trahi un nom de champ invente (`liq`,
// `survived`). Avant d'ecrire un rejeu prequentiel, on demande a la base ce qu'elle contient au lieu
// de le supposer — et surtout on cherche la question qui decide tout:
//
//   `siblingCount` est-il le compte AU MOMENT du token, ou le compte D'AUJOURD'HUI ?
//
// Si c'est aujourd'hui, alors la regle « financeur industriel >= 20 freres », mesuree a 91,8 % / 45,5 %,
// juge chaque token avec une information qui n'existait pas quand il a ete juge. Ce serait un regard
// vers le futur, et le chiffre le plus fort du radar serait a refaire.
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

// Presence de chaque champ, tous tokens confondus.
const compte = new Map();
for (const t of rows) for (const k of Object.keys(t)) compte.set(k, (compte.get(k) || 0) + 1);
console.log(`\n  ${rows.length} tokens — presence des champs :`);
for (const [k, n] of [...compte.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(26)} ${String(n).padStart(4)}  ${((n / rows.length) * 100).toFixed(1)}%`);
}

// Le champ financeur, s'il existe: combien de tokens par financeur, et le compte stocke correspond-il ?
const avecFunder = rows.filter((t) => t.funder);
console.log(`\n  tokens avec un financeur trace : ${avecFunder.length}`);
if (avecFunder.length) {
  const parFunder = new Map();
  for (const t of avecFunder) parFunder.set(t.funder, (parFunder.get(t.funder) || 0) + 1);
  console.log(`  financeurs distincts           : ${parFunder.size}`);

  /* LE TEST QUI TRANCHE. Pour chaque token, on compare le `siblingCount` STOCKE au nombre de tokens
   * du meme financeur presents dans CETTE base. S'ils collent, le champ est un instantane global —
   * donc post-datant la plupart des tokens qu'il decrit — et tout jugement qui s'en sert regarde en
   * avant. S'ils divergent, le champ porte autre chose (des freres hors de notre base) et il faut le
   * dire aussi, parce qu'alors on ne peut PAS le reconstruire depuis nos seules donnees. */
  let colle = 0, diverge = 0, sansCompte = 0;
  const exemples = [];
  for (const t of avecFunder) {
    if (typeof t.siblingCount !== 'number') { sansCompte++; continue; }
    const dansBase = parFunder.get(t.funder);
    if (t.siblingCount === dansBase) colle++;
    else { diverge++; if (exemples.length < 5) exemples.push(`${String(t.sym || '?').padEnd(12)} stocke=${t.siblingCount}  dans-notre-base=${dansBase}`); }
  }
  console.log(`\n  siblingCount stocke vs freres presents dans cette base :`);
  console.log(`    identiques : ${colle}     differents : ${diverge}     sans compte : ${sansCompte}`);
  for (const e of exemples) console.log(`      ${e}`);
  console.log(diverge > colle
    ? '    -> le compte vient d AILLEURS que de notre base: non reconstructible ici, et sa date est inconnue.'
    : '    -> le compte suit notre base: c est un instantane GLOBAL, donc posterieur a la plupart des tokens.');
}

// Et l'ordre chronologique existe-t-il seulement ? Sans `firstSeen` lisible, aucun prequentiel n'est possible.
const datables = rows.filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const dates = datables.map((t) => Date.parse(t.firstSeen)).sort((a, b) => a - b);
console.log(`\n  firstSeen lisible : ${datables.length}/${rows.length}`);
if (dates.length) {
  console.log(`    du ${new Date(dates[0]).toISOString()} au ${new Date(dates[dates.length - 1]).toISOString()}`);
  const jours = (dates[dates.length - 1] - dates[0]) / 86400000;
  console.log(`    fenetre : ${jours.toFixed(1)} jours`);
}
