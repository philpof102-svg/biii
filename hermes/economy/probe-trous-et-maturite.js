#!/usr/bin/env node
// probe-trous-et-maturite.js — « survecu » se decide-t-il sur des heures que personne n'a regardees ?
// ================================================================================================
// `lib/scorecard.js` lit `data/token-radar/blackouts.json`. `lib/prequential.js` ne le lit PAS — donc la
// marche et la notation des paris tranchent une issue sans savoir si la fenetre etait surveillee. La
// question posee ici est la version mesurable de ce soupcon: combien de tokens traversent toute leur
// fenetre de maturite pendant un trou, et combien d'entre eux sont comptes SURVIVANTS ?
//
// ⚠️ REPONSE, ET C'EST UN ZERO — MAIS UN ZERO EXPLIQUE. Aucune passe ne tourne pendant un trou, donc
// presque aucun token n'y est vu pour la premiere fois, donc presque aucune fenetre de maturite n'y
// tient — d'autant qu'elle ne dure que quatre heures. Le mecanisme se protege tout seul. C'est un
// argument de MECANISME, pas une absence de donnees, et il vaut mieux que le zero brut.
//
// ⚠️ CE QUI EST REEL EN REVANCHE, ET QU'AUCUN CHIFFRE PUBLIE NE DIT: la part AVEUGLE de la periode
// couverte. Elle se lit ci-dessous. Une base qui a cesse de regarder pendant pres d'un quart du temps
// n'est pas « surveillee en continu », et toute copie qui l'affirmerait serait fausse.
//
// ⛔ CE QUE CETTE SONDE NE PEUT PAS VOIR: un token lance ET mort pendant un trou n'entre JAMAIS dans la
// base — l'ingestion exige une liquidite minimale qu'un pool tire n'a plus. Il manque donc des RUGS,
// jamais des survivants. Le sens de ce biais est connu (le taux de base est sous-estime), son ampleur
// ne l'est pas, et aucune lecture de cette base ne peut la donner.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const RACINE = path.join(__dirname, '..', '..', 'data', 'token-radar');
const rows = Object.entries(JSON.parse(fs.readFileSync(path.join(RACINE, 'tokens.json'), 'utf8')))
  .map(([addr, v]) => ({ addr, ...v }));
const trous = JSON.parse(fs.readFileSync(path.join(RACINE, 'blackouts.json'), 'utf8'))
  .map((b) => ({ from: Date.parse(b.from), to: Date.parse(b.to), hours: b.hours }));

const H = 3600000;
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

const debut = Math.min(...rows.map((t) => Date.parse(t.firstSeen)).filter(Number.isFinite));
const fin = Math.max(...rows.map((t) => Date.parse(t.lastSeen)).filter(Number.isFinite));
const couvert = (fin - debut) / H;
const aveugle = trous.reduce((s, b) => s + b.hours, 0);

console.log(`\n  ${trous.length} trou(s) enregistre(s) · ${aveugle.toFixed(1)} h`);
console.log(`  periode couverte par la base : ${couvert.toFixed(1)} h`);
console.log(`  PART AVEUGLE : ${(100 * aveugle / couvert).toFixed(1)} %`);
console.log(`  fenetre de maturite : ${maturityH} h\n`);

const dansUnTrou = (a, b) => trous.some((x) => a >= x.from && b <= x.to);
const chevauche = (a, b) => trous.some((x) => a < x.to && b > x.from);
const fenetre = (t) => { const a = Date.parse(t.firstSeen); return Number.isFinite(a) ? [a, a + maturityH * H] : null; };

const groupe = { aveugle: [], partiel: [], surveille: [] };
for (const t of rows) {
  const f = fenetre(t);
  if (!f) continue;
  if (dansUnTrou(f[0], f[1])) groupe.aveugle.push(t);
  else if (chevauche(f[0], f[1])) groupe.partiel.push(t);
  else groupe.surveille.push(t);
}

function bilan(nom, g) {
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const s = g.filter((t) => issue(t) === 'survived').length;
  const o = g.filter((t) => issue(t) === null).length;
  console.log('    ' + nom.padEnd(40) + String(g.length).padStart(5) + ' tok · '
    + String(r).padStart(4) + ' rug · ' + String(s).padStart(4) + ' surv · ' + String(o).padStart(4) + ' ouv'
    + (r + s ? '  ' + (100 * r / (r + s)).toFixed(1).padStart(5) + ' %' : ''));
  return { r, s };
}

console.log('  ── les tokens, selon que leur fenetre de maturite a ete SURVEILLEE ──\n');
const av = bilan('fenetre ENTIEREMENT dans un trou', groupe.aveugle);
bilan('fenetre chevauchant un trou', groupe.partiel);
const su = bilan('fenetre entierement surveillee', groupe.surveille);

console.log(`\n  survivants decides sur une fenetre AVEUGLE : ${av.s}`);
if (!av.s) {
  console.log('  => aucun. Et la raison est mecanique: sans passe, pas d ingestion, donc presque aucun');
  console.log('     token n a sa premiere vue DANS un trou. Un zero explique, pas un zero constate.');
}

const tR = rows.filter((t) => issue(t) === 'rugged').length;
const tS = rows.filter((t) => issue(t) === 'survived').length;
console.log('\n  ── taux de base selon la population ──\n');
console.log(`    toute la base                      ${(100 * tR / (tR + tS)).toFixed(1)} %  sur ${tR + tS}`);
console.log(`    fenetres entierement surveillees   ${(100 * su.r / (su.r + su.s)).toFixed(1)} %  sur ${su.r + su.s}`);
console.log(`    ecart : ${((100 * su.r / (su.r + su.s)) - (100 * tR / (tR + tS))).toFixed(1)} pts`);
console.log('\n  ⛔ Brancher blackouts.json sur `outcomeKnownAt` ne changerait donc rien de mesurable');
console.log('     aujourd hui. Le dire est le resultat: on a regarde, la porte tient, et une correction');
console.log('     posee ici serait du travail sans effet vendu comme une reparation.\n');
