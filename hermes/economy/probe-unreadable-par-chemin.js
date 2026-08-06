#!/usr/bin/env node
// probe-unreadable-par-chemin.js — `unreadable` n'est pas une echelle, tant qu'on ne fixe pas le chemin.
// ================================================================================================
// `token-radar.js:495` stocke `v.unknowns.length` et jette la liste. Deux chemins de `rugsignals.js`
// remplissent ce tableau, et ils ne parlent pas la meme langue:
//
//   · chemin SIMULATION (aucun index) — soit `['*']` quand il n'y a MEME PAS de simulation, donc UN,
//     soit ['owner', 'LP lock status', 'holder distribution'], donc TROIS. Deux valeurs, pas plus.
//   · chemin INDEX — six conditions independantes, plus un groupe pour les onze pouvoirs non rapportes.
//     Toutes les valeurs de 0 a 7 sont atteignables.
//
// ⛔ CONSEQUENCE: `unreadable === 1` designe l'IGNORANCE MAXIMALE d'un cote (ni index ni simulation) et
// une lecture PRESQUE COMPLETE de l'autre (un seul champ manquant). La meme valeur stockee, deux etats
// opposes du monde. La sentinelle `['*']` a une longueur de 1 alors qu'elle signifie « tout est inconnu ».
//
// ⚠️ CE QUE CETTE SONDE PEUT PROUVER: que les deux chemins se comportent differemment a valeur EGALE, et
// de combien. Le discriminant ne coute rien — `basisAtFirstSight.ownerState` est deja stocke, et le
// chemin simulation n'en pose aucun.
// ⛔ CE QU'ELLE NE PEUT PAS: dire qu'une regle vivante en souffre. Aucune ne lit `unreadable` seul
// aujourd'hui, et le pari phare ne bouge que de 0,1 point une fois les chemins separes — sa seconde
// condition filtrait deja l'essentiel. Le danger mesure ici est LATENT, pas realise, et le dire est le
// resultat: une trouvaille structurelle dont on tait la portee reelle est une trouvaille survendue.
//
// ⚠️ BORNE QUI SURVIT A TOUT LE RESTE: `siblingCount` porte DEUX instruments depuis le 2026-08-04. Les
// taux ci-dessous melangent donc encore deux mesures sous un nom, et separer les chemins ne repare pas
// cela — c'est un autre defaut, mesure ailleurs.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;

/* Le discriminant, et il ne coute rien: `assessFromSimulationOnly` ne pose aucun `ownerState`, alors que
 * `assessRugFields` en pose toujours un — meme quand l'adresse est illisible, auquel cas il vaut
 * 'unknown'. Verifie par le PRODUCTEUR dans test/unreadable-count-is-not-a-signature.test.js. */
const cheminSimulation = (t) => { const b = basis(t); return b && b.ownerState == null; };

const resolus = rows.filter((t) => issue(t) !== null);
const BASE = 100 * resolus.filter((t) => issue(t) === 'rugged').length / resolus.length;
console.log(`\n  taux de base : ${BASE.toFixed(1)} %  ·  ${resolus.length} resolus sur ${rows.length}\n`);

function ligne(nom, g) {
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const res = g.filter((t) => issue(t) !== null).length;
  const ecart = res ? (100 * r / res) - BASE : null;
  console.log('    ' + nom.padEnd(38) + String(g.length).padStart(5) + ' tok · '
    + String(r).padStart(4) + '/' + String(res).padStart(4) + ' · '
    + (res ? (100 * r / res).toFixed(1).padStart(5) + ' %' : '  n/a')
    + (ecart == null ? '' : '  ' + (ecart >= 0 ? '+' : '') + ecart.toFixed(1) + ' pts'));
  return { n: g.length, r, res };
}

console.log('  ── LA SENTINELLE: `unreadable === 1` designe deux etats OPPOSES ──\n');
const un = rows.filter((t) => { const b = basis(t); return b && b.unreadable === 1; });
ligne('chemin SIMULATION (= tout inconnu)', un.filter(cheminSimulation));
ligne('chemin INDEX (= un champ manquant)', un.filter((t) => !cheminSimulation(t)));

console.log('\n  ── `unreadable` A CHEMIN CONSTANT — la seule lecture qui ait un sens ──');
for (const [nom, garde] of [['SIMULATION', cheminSimulation], ['INDEX', (t) => !cheminSimulation(t)]]) {
  console.log(`\n    ── chemin ${nom} ──`);
  for (let u = 0; u <= 8; u++) {
    const g = rows.filter((t) => { const b = basis(t); return b && b.unreadable === u && garde(t); });
    if (g.length) ligne('  unreadable = ' + u, g);
  }
}

/* ⛔ AUCUNE REGLE N'EST CREEE NI MODIFIEE ICI. La regle annoncee est gelee et notee vers l'avant. Ce
 * bloc chiffre ce qu'une regle NOUVELLE vaudrait, pour qu'une decision d'annonce repose sur un nombre.
 * Le nombre dit ici que le gain est nul: la seconde condition faisait deja le travail. */
console.log('\n  ── le cote SUR du pari phare, chemins separes ──\n');
const seau = rows.filter((t) => { const b = basis(t);
  return b && b.unreadable === 3 && typeof t.siblingCount === 'number' && t.siblingCount < 20; });
const a = ligne('tel que la regle GELEE le definit', seau);
const b2 = ligne('  restreint au chemin SIMULATION', seau.filter(cheminSimulation));
ligne('  et le reste (chemin index)', seau.filter((t) => !cheminSimulation(t)));

if (a.res && b2.res) {
  const d = (100 * b2.r / b2.res) - (100 * a.r / a.res);
  console.log(`\n  ecart apporte par la separation : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts sur ${b2.res} appels resolus.`);
  console.log('  ⛔ Un ecart de cet ordre ne justifie pas une nouvelle annonce. Le defaut de melange est');
  console.log('     REEL et prouve par le producteur; sa portee sur le pari en cours est NULLE, et');
  console.log('     confondre les deux serait vendre une trouvaille structurelle comme un correctif.\n');
}
