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

console.log(`\n  tranches de 24 h SANS aucune entree, sur 8 : ${vides}`);

/* ═══ TROIS CAUSES, UNE SEULE APPARENCE — ET DEUX SONT ELIMINABLES D'ICI ═══
 *
 * Un silence peut vouloir dire: (1) la copie locale ne se synchronise plus, (2) l'infrastructure ou
 * la chaine sont a l'arret, (3) le collecteur lui-meme ne tourne plus. Elles se ressemblent
 * exactement dans ce fichier, et seule la troisieme est une panne de NOTRE cote.
 *
 * La premiere version s'arretait a « regarder le planificateur ». C'etait honnete mais paresseux: le
 * collecteur JUMEAU (mainstreet) est joignable en HTTP et publie sa propre fraicheur. S'il est a jour
 * pendant que nous sommes muets, l'infrastructure et la chaine sont hors de cause — et il ne reste
 * qu'une explication au lieu de trois. Mesure du 2026-08-05: lag 0,1 h et 4914 reglements dans
 * l'heure, pendant que ce radar-ci se taisait depuis 7,5 h.
 *
 * ⚠️ CE QUE LA COMPARAISON NE PROUVE PAS, et qui doit se dire: le jumeau indexe des REGLEMENTS x402,
 * pas des nouveaux pools. Une chaine occupee peut lancer peu de tokens. Elle ecarte donc « la chaine
 * est morte », jamais « aucun pool n'est ne depuis 7 heures ». */
async function comparerAuJumeau() {
  const URL = process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app';
  try {
    const r = await fetch(URL + '/api/agent/health', { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { lu: false, pourquoi: 'HTTP ' + r.status };
    const j = await r.json();
    const l = (j && j.live) || {};
    return { lu: true, lag: l.settlementsLagHours, stale: l.settlementsWindowStale, parHeure: l.settlements1h };
  } catch (e) { return { lu: false, pourquoi: String((e && e.message) || e) }; }
}

comparerAuJumeau().then((j) => {
  console.log('\n  ── le collecteur JUMEAU (mainstreet), pour ecarter les causes communes ──');
  if (!j.lu) {
    // Non lu n'est pas « le jumeau va mal »: on ne conclut rien, et on le dit.
    console.log(`    ⚠️ NON LU (${j.pourquoi}) — aucune cause ne peut etre ecartee par cette voie.`);
  } else {
    console.log(`    lag ${j.lag}h · stale ${j.stale} · ${j.parHeure} reglements dans l heure`);
    const jumeauSain = typeof j.lag === 'number' && j.lag < 1 && j.stale === false;
    if (process.exitCode && jumeauSain) {
      console.log('    ⛔ Le jumeau est A JOUR pendant que ce radar se tait.');
      console.log('       Ecartees: infrastructure, chaine a l arret. Restent: le cron de CE collecteur,');
      console.log('       ou une absence reelle de nouveaux pools — que ce chiffre ne mesure PAS');
      console.log('       (il compte des reglements x402, pas des lancements).');
    } else if (process.exitCode) {
      console.log('    Le jumeau decroche aussi — la cause est probablement commune, pas propre a ce cron.');
    }
  }
  if (process.exitCode) {
    console.log('\n     Le mecanisme d annonce ne peut rien noter tant que ca dure.');
    console.log('     ⚠️ Verifier le planificateur sur la machine qui l heberge: `hermes` est absent de');
    console.log('     cette machine-ci, donc rien ici ne peut confirmer ni infirmer qu il tourne.');
  }
});
