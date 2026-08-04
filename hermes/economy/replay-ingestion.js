#!/usr/bin/env node
// replay-ingestion.js — la base est-elle encore ALIMENTEE, ou le dispositif tourne-t-il a vide ?
// ================================================================================================
// Le mecanisme d'annonce (lib/announced-rules.js) ne note que les tokens apparus APRES sa frontiere.
// S'il n'en arrive plus, le bulletin dira « 0 note » pour toujours et le dispositif entier sera une
// illusion de rigueur: tout l'appareil de mesure en place, et rien a mesurer.
//
// Ce script repond a une seule question, par les DONNEES et non par la configuration d'un cron: a
// quelle cadence des tokens entrent-ils dans la base, et quand le dernier est-il entre ?
//
// ⚠️ CE QU'IL NE PEUT PAS DIRE. Il lit une base sur disque, pas un planificateur. Une cadence qui
// s'arrete peut vouloir dire « le cron est mort », « la copie locale n'est plus synchronisee avec
// celle qui tourne », ou « le marche est calme ». Ces trois-la se ressemblent ici, et seul le premier
// serait une panne. La distinction demande de regarder le planificateur lui-meme, ce que ce fichier
// ne fait pas et ne pretend pas faire.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const stat = fs.statSync(DB);
const rows = Object.values(JSON.parse(fs.readFileSync(DB, 'utf8')))
  .map((t) => Date.parse(t.firstSeen))
  .filter((x) => Number.isFinite(x))
  .sort((a, b) => a - b);

const JOUR = 86400000;
const maintenant = Date.now();

console.log(`\n  base : ${rows.length} tokens`);
console.log(`  fichier ecrit le : ${stat.mtime.toISOString()}`);
console.log(`  ⚠️ l horodatage du FICHIER est une date d ECRITURE, pas une date d OBSERVATION —`);
console.log(`     les deux ont deja ete confondues ici. Les dates ci-dessous viennent des tokens.\n`);

if (!rows.length) { console.log('  ⛔ aucune date lisible — rien a conclure.'); process.exit(2); }

const dernier = rows[rows.length - 1];
const ageH = (maintenant - dernier) / 3600000;
console.log(`  premiere observation : ${new Date(rows[0]).toISOString()}`);
console.log(`  derniere observation : ${new Date(dernier).toISOString()}  (il y a ${ageH.toFixed(1)} h)`);

// Cadence par tranche de 24 h, sur les 8 derniers jours.
console.log('\n  entrees par tranche de 24 h :');
let vides = 0;
for (let j = 7; j >= 0; j--) {
  const fin = maintenant - j * JOUR;
  const debut = fin - JOUR;
  const n = rows.filter((d) => d > debut && d <= fin).length;
  if (n === 0) vides++;
  const barre = '█'.repeat(Math.min(40, Math.round(n / 8)));
  console.log(`    J-${j}  ${String(n).padStart(4)}  ${barre}`);
}

/* ⛔ LE SEUIL SE DERIVE DE LA CADENCE OBSERVEE, IL NE SE CHOISIT PAS.
 *
 * Premiere version: 12 h, raisonnees depuis la fenetre de maturite du scorecard. Elle a affiche
 * « ✅ la collecte alimente encore la base » sur une base silencieuse depuis 6,7 h — alors que la
 * cadence reelle est HORAIRE (p50 = 1 h sur 210 heures actives). Six passes manquees presentees
 * comme un fonctionnement normal, par un seuil pris dans un raisonnement au lieu des donnees. C'est
 * la faute meme que ce depot a documentee toute la nuit sur les seuils de regles, appliquee ici a
 * l'instrument qui devait la surveiller.
 *
 * On mesure donc l'ecart entre heures ACTIVES et on publie ses quantiles a cote du verdict, pour que
 * le lecteur puisse contester le seuil au lieu de le subir. */
const heuresActives = [...new Set(rows.map((d) => Math.floor(d / 3600000)))].sort((a, b) => a - b);
const ecarts = [];
for (let i = 1; i < heuresActives.length; i++) ecarts.push(heuresActives[i] - heuresActives[i - 1]);
ecarts.sort((a, b) => a - b);
const q = (p) => (ecarts.length ? ecarts[Math.min(ecarts.length - 1, Math.ceil(p * ecarts.length) - 1)] : null);
const p50 = q(0.5), p99 = q(0.99), maxEcart = ecarts.length ? ecarts[ecarts.length - 1] : null;

console.log('');
console.log(`  cadence mesuree sur ${heuresActives.length} heures actives :`);
console.log(`    ecart entre heures actives — p50 ${p50}h · p99 ${p99}h · max observe ${maxEcart}h`);
console.log(`    ecart ACTUEL : ${ageH.toFixed(1)} h\n`);

/* Trois etats, parce que « au-dessus du p99 » et « sans precedent » ne disent pas la meme chose:
 * le premier est inhabituel, le second n'a jamais ete vu et merite un autre niveau d'alarme. */
if (p99 == null) {
  console.log('  ⚠️ Pas assez d historique pour deriver un seuil — rien a conclure sur la cadence.');
  process.exitCode = 2;
} else if (ageH > maxEcart) {
  console.log(`  ⛔ ${ageH.toFixed(1)} h de silence — SUPERIEUR au plus long creux jamais observe (${maxEcart}h).`);
  process.exitCode = 1;
} else if (ageH > p99) {
  console.log(`  ⚠️ ${ageH.toFixed(1)} h de silence — au-dessus du p99 (${p99}h), mais un creux de ${maxEcart}h`);
  console.log('     existe dans l historique. Inhabituel, PAS sans precedent.');
  process.exitCode = 1;
} else {
  console.log(`  ✅ ${ageH.toFixed(1)} h — dans la cadence habituelle.`);
}

if (process.exitCode) {
  console.log('\n     Le mecanisme d annonce ne peut rien noter tant que ca dure.');
  console.log('     ⚠️ Et ce n est PAS « le cron est mort ». Cette base est une copie LOCALE: une copie');
  console.log('     qui ne se synchronise plus ressemble EXACTEMENT a une collecte arretee, et un creux');
  console.log('     de marche nocturne leur ressemble aussi. Trois causes, une seule apparence —');
  console.log('     regarder le planificateur, pas ce fichier, avant de nommer une panne.');
}
console.log(`\n  tranches de 24 h SANS aucune entree, sur 8 : ${vides}`);
