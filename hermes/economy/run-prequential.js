#!/usr/bin/env node
// run-prequential.js — lance la marche chronologique sur la base reelle et imprime la carte.
// ================================================================================================
// La logique vit dans lib/prequential.js, pure et testable. Ce fichier ne fait que lire le disque,
// injecter l'horloge, et mettre en forme — pour que le calcul qu'on publie soit exerce par la suite
// de tests, pas par un script de rejeu qu'on lance a la main une fois.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runPrequential } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const raw = JSON.parse(fs.readFileSync(DB, 'utf8'));
const rows = Object.entries(raw).map(([addr, v]) => ({ addr, ...v }));

const now = process.argv[2] || new Date().toISOString();
const c = runPrequential(rows, now);

console.log(`\n  marche prequentielle — ${c.tokensWalked} tokens, fenetre de maturite ${c.maturityWindowHours}h`);
console.log(`  resolus a ${c.updatedAt} : ${c.resolvedTotal}  ·  non resolus : ${c.unresolved}`);
console.log(`  taux de base sur les RESOLUS : ${c.baseRate == null ? 'n/a' : (c.baseRate * 100).toFixed(1) + '%'}`);

// La propriete d'ordre se lit AVANT les resultats. Un chiffre produit par une marche qui fuit est
// faux quelle que soit sa tete, donc il ne merite pas d'etre lu en premier.
console.log(`\n  ── propriete d ordre ──`);
console.log(`    fuites vers le futur                 : ${c.orderBreaches}`);
console.log(`    1er token d un financeur avec freres : ${c.firstOfFunderWithPriorSiblings}`);
if (c.orderBreaches || c.firstOfFunderWithPriorSiblings) {
  console.log('    ⛔ La marche regarde en avant. Aucun chiffre ci-dessous n a de valeur.');
  process.exitCode = 1;
}

const pc = (x) => (x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%');
console.log(`\n  ── les regles, notees vers l avant ──`);
/* ⚠️ La colonne `n` ne portait QUE `dangerResolved`, collee a quatre taux dont deux ne s'appuient pas
 * dessus. Le 2026-08-06 `funder-derived-uncensored` affichait « safe 100,0 % » a cote d'un n de 687,
 * alors que ce 100 % reposait sur UN token: le denominateur du taux sur n'etait affiche nulle part. */
console.log(`    ${'regle'.padEnd(46)} ${'prec'.padStart(6)} ${'safe'.padStart(6)} ${'rappel'.padStart(6)} ${'marque'.padStart(6)}   nDgr  nSur (ouv/abst)`);
for (const r of c.cards) {
  const marque = r.derived ? '📐' : r.isStatic ? '🧱' : '✋';
  console.log(`    ${marque} ${r.label.slice(0, 43).padEnd(44)} ${pc(r.precision)} ${pc(r.safeRugRate)} ${pc(r.recall)} ${pc(r.markedShare)}   ${String(r.dangerResolved).padStart(4)}  ${String(r.safeResolved).padStart(4)}  (${r.dangerOpen}/${r.abstained})`);
  for (const m of r.tropMince || []) console.log(`        ⚠️ RETENU ${m}`);
  // Le seuil derive doit se montrer. S'il converge vers celui qu'on a choisi a la main, la regle
  // « independante » est la meme regle, et le controle qu'on croyait exercer n'existe pas.
  if (r.thresholdMedian != null) {
    console.log(`        seuil derive : min ${r.thresholdMin} · median ${r.thresholdMedian} · max ${r.thresholdMax}`);
  }
}
console.log(`\n    📐 seuil DERIVE du passe   ✋ seuil choisi a la main   🧱 trait statique (le rejeu ne prouve rien)`);
console.log(`    prec = part des appels DANGER qui ont rugge · safe = part des appels SAFE qui ont rugge`);
console.log(`    Un ecart prec/safe proche de zero = la regle n informe dans aucun des deux sens.`);
console.log(`\n  ${c.note}\n`);
