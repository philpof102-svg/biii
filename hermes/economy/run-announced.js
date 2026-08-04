#!/usr/bin/env node
// run-announced.js — le bulletin des regles PARIEES, note sur les seuls tokens arrives depuis.
// ================================================================================================
// La logique vit dans lib/prequential.js et les paris dans lib/announced-rules.js, tous deux purs et
// testes. Ce fichier lit le disque, injecte l'horloge, et met en forme.
//
// ⚠️ Le premier bulletin dira « pas encore notable » partout. C'est le comportement CORRECT d'une
// frontiere posee apres la derniere observation — et c'est aussi la preuve que la frontiere n'a pas
// ete placee dans le passe pour se donner des resultats immediats.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gradeAnnounced } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const c = gradeAnnounced(rows, process.argv[2] || new Date().toISOString());

console.log(`\n  bulletin des regles annoncees — ${c.updatedAt}`);
console.log(`  base disponible : ${c.tokensAvailable} tokens · fenetre de maturite ${c.maturityWindowHours}h\n`);

const pc = (x) => (x == null ? '   n/a' : (x * 100).toFixed(1).padStart(5) + '%');
const signe = (x) => (x == null ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(1) + ' pts');

for (const r of c.cards) {
  const etat = r.verdict === 'note' ? '📊' : r.verdict === 'trop-peu' ? '⏳' : r.verdict === 'regle-introuvable' ? '⛔' : '🕐';
  console.log(`  ${etat} ${r.label}`);
  console.log(`     annoncee le ${r.announcedAt}  ·  eligibles depuis : ${r.eligible == null ? 'n/a' : r.eligible}`);
  if (r.predicted) {
    console.log(`     PARI    danger ${pc(r.predicted.dangerRate)}   sur ${pc(r.predicted.safeRate)}`);
  }
  if (r.observed) {
    console.log(`     OBSERVE danger ${pc(r.observed.dangerRate)}   sur ${pc(r.observed.safeRate)}`
      + `   (${r.dangerResolved}+${r.safeResolved} resolus, ${r.dangerOpen + r.safeOpen} ouverts, ${r.abstained} abstentions)`);
  }
  if (r.deltaPts) console.log(`     ECART   danger ${signe(r.deltaPts.danger)}   sur ${signe(r.deltaPts.safe)}`);
  console.log(`     ${r.note}\n`);
}

console.log(`  ${c.note}\n`);
