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
  /* Une carte peut porter le verdict `note` et ne publier AUCUN taux, si ses deux cotes sont trop
   * minces. L'icone suit ce qui est reellement sorti, pas le verdict: afficher 📊 « note » au-dessus de
   * deux `n/a` ferait lire un resultat la ou il n'y en a pas. Le champ `verdict` lui-meme est intact. */
  const rienPublie = r.observed && r.observed.dangerRate == null && r.observed.safeRate == null;
  const etat = r.verdict === 'regle-introuvable' ? '⛔'
    : r.verdict === 'pas-encore-notable' ? '🕐'
      : (r.verdict === 'trop-peu' || rienPublie) ? '⏳' : '📊';
  console.log(`  ${etat} ${r.label}`);
  console.log(`     annoncee le ${r.announcedAt}  ·  eligibles depuis : ${r.eligible == null ? 'n/a' : r.eligible}`);
  if (r.predicted) {
    console.log(`     PARI    danger ${pc(r.predicted.dangerRate)}   sur ${pc(r.predicted.safeRate)}`);
  }
  /* Chaque taux porte SON denominateur, colle a lui. La version precedente affichait « 19+2 resolus »
   * une fois, en bout de ligne, pour deux taux: rien ne disait lequel des deux reposait sur 2 appels. */
  if (r.observed) {
    console.log(`     OBSERVE danger ${pc(r.observed.dangerRate)} sur n=${String(r.dangerResolved).padEnd(4)}`
      + ` sur ${pc(r.observed.safeRate)} sur n=${String(r.safeResolved).padEnd(4)}`
      + `  (${r.dangerOpen}+${r.safeOpen} ouverts, ${r.abstained} abstentions)`);
  }
  /* ⚠️ LA BASE DE LA POPULATION JUGEE S'AFFICHE AVANT TOUT ECART. Le 2026-08-06 elle valait 97,2 %
   * quand celle de la base entiere valait 83,3 %: un « +10,9 pts en faveur du pari » y devenait
   * −0,9 pt contre le hasard. Sans cette ligne, le lecteur compare a un chiffre qu'il n'a pas. */
  if (r.baseRateJuge != null) {
    console.log(`     BASE    ${pc(r.baseRateJuge)} sur n=${r.baseRateJugeN}   <- taux de rug des appels REELLEMENT notes`);
  }
  // Une ligne d'ecart entierement `n/a` n'affirme rien: on la tait plutot que de meubler.
  if (r.deltaPts && (r.deltaPts.danger != null || r.deltaPts.safe != null)) {
    console.log(`     vs PARI danger ${signe(r.deltaPts.danger)}   sur ${signe(r.deltaPts.safe)}`);
  }
  if (r.deltaVsBase && (r.deltaVsBase.danger != null || r.deltaVsBase.safe != null)) {
    console.log(`     vs BASE danger ${signe(r.deltaVsBase.danger)}   sur ${signe(r.deltaVsBase.safe)}   <- bat-elle le hasard ICI ?`);
  }
  for (const m of r.tropMince || []) console.log(`     ⚠️ RETENU  ${m}`);
  console.log(`     ${r.note}\n`);
}

console.log(`  ${c.note}\n`);
