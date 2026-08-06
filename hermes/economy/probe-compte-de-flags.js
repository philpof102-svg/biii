#!/usr/bin/env node
// probe-compte-de-flags.js — la frontiere `flags >= 3` du verdict livre, mesuree pour la premiere fois.
// ================================================================================================
// `rugsignals.js` decide le verdict ainsi: `armed.length` -> rug_ready, sinon `flags.length >= 3` ->
// high_risk, sinon `flags.length` -> caution. Ce 3 est pose a la main et n'avait jamais ete confronte
// aux issues, alors que `flagsAtFirstSight` est stocke depuis le debut.
//
// ⚠️ DEUX RESULTATS, ET LE SECOND EST UN NON-SIGNAL QU'IL FAUT DIRE:
//   1. La frontiere est INERTE. Sur 1931 lignes, quatre portent trois drapeaux et une en porte quatre.
//      Ce chemin ne produit pratiquement jamais de `high_risk`; les `high_risk` livres viennent
//      d'ailleurs.
//   2. Le compte de drapeaux n'est PAS un signal utilisable. Marginalement il est meme inverse — zero
//      drapeau rugge plus qu'un drapeau — mais cette inversion NE SURVIT PAS a la stratification: a
//      nombre de champs illisibles constant, l'ecart change de signe d'une strate a l'autre. Une
//      association marginale qui s'inverse selon la strate n'est pas un effet, c'est une composition.
//
// ⛔ UNE HYPOTHESE EST MORTE ICI ET ELLE EST ECRITE POUR NE PAS ETRE REJOUEE. On attendait un
// confondant de LISIBILITE: un drapeau exige un champ lu, donc zero drapeau devait signifier « rien n'a
// pu etre lu ». Mesure: `unreadable` moyen vaut 3,71 a zero drapeau et 3,89 a un drapeau, et la part a
// `unreadable >= 4` vaut 59,7 % contre 57,8 %. Les deux groupes sont aussi lisibles l'un que l'autre.
// L'explication etait fausse.
//
// ⛔ CE QUE CETTE SONDE NE DIT PAS: que le verdict livre soit mauvais. `verdict-caution` mesure +11,3
// points d'ecart reel dans la marche. Ce qui est mesure ici est le sous-signal COMPTE DE DRAPEAUX, pas
// le verdict, qui doit l'essentiel de son pouvoir a `armed` et aux inconnus.
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
const nbFlags = (t) => (Array.isArray(t.flagsAtFirstSight) ? t.flagsAtFirstSight.length : null);
const nbArmed = (t) => (Array.isArray(t.armedAtFirstSight) ? t.armedAtFirstSight.length : null);

const resolus = rows.filter((t) => issue(t) !== null);
const BASE = 100 * resolus.filter((t) => issue(t) === 'rugged').length / resolus.length;
const taux = (g) => { const r = g.filter((t) => issue(t) === 'rugged').length,
  res = g.filter((t) => issue(t) !== null).length; return { r, res, p: res ? 100 * r / res : null }; };

console.log(`\n  taux de base : ${BASE.toFixed(1)} %  ·  ${resolus.length} resolus sur ${rows.length}\n`);

console.log('  ── taux de rug par nombre de drapeaux a la premiere vue ──\n');
console.log('    flags   tokens    rug/res     taux    vs base');
const parN = new Map();
for (const t of rows) { const n = nbFlags(t); if (n == null) continue;
  if (!parN.has(n)) parN.set(n, []); parN.get(n).push(t); }
for (const [n, g] of [...parN.entries()].sort((a, b) => a[0] - b[0])) {
  const x = taux(g);
  console.log('    ' + String(n).padStart(5) + String(g.length).padStart(9)
    + ('   ' + x.r + '/' + x.res).padEnd(12)
    + (x.p == null ? '   n/a' : x.p.toFixed(1).padStart(6) + ' %')
    + (x.p == null ? '' : '   ' + ((x.p - BASE >= 0 ? '+' : '') + (x.p - BASE).toFixed(1) + ' pts').padStart(9))
    + (n === 3 ? '   <<< la frontiere LIVREE high_risk' : ''));
}

const hauts = rows.filter((t) => nbFlags(t) >= 3);
console.log(`\n  ⛔ LA FRONTIERE EST INERTE: ${hauts.length} token(s) sur ${rows.length} atteignent trois drapeaux.`);
console.log('     Le `high_risk` livre ne vient donc presque jamais de ce chemin.');

/* ── LA STRATIFICATION, qui decide si l'inversion marginale est un effet ou une composition ── */
console.log('\n  ── a nombre de champs ILLISIBLES constant, le drapeau informe-t-il ? ──\n');
console.log('    unreadable    0 flag         >= 1 flag        ecart');
const signes = [];
for (let u = 0; u <= 8; u++) {
  const g = rows.filter((t) => { const b = basis(t); return b && b.unreadable === u && nbFlags(t) != null; });
  const z = g.filter((t) => nbFlags(t) === 0), p = g.filter((t) => nbFlags(t) >= 1);
  const a = taux(z), b = taux(p);
  if (a.p == null || b.p == null || a.res < 10 || b.res < 10) continue;
  signes.push(b.p - a.p);
  console.log('    ' + String(u).padStart(10) + ('  ' + z.length + ' tok ' + a.p.toFixed(1) + ' %').padEnd(18)
    + ('  ' + p.length + ' tok ' + b.p.toFixed(1) + ' %').padEnd(18)
    + ((b.p - a.p >= 0 ? '+' : '') + (b.p - a.p).toFixed(1) + ' pts').padStart(9));
}
const positifs = signes.filter((x) => x > 0).length;
console.log(`\n  ${signes.length} strate(s) exploitable(s), dont ${positifs} ou le drapeau AGGRAVE et `
  + `${signes.length - positifs} ou il RASSURE.`);
if (positifs && positifs < signes.length) {
  console.log('  ⛔ L ecart CHANGE DE SIGNE selon la strate. Une association marginale qui s inverse');
  console.log('     ainsi n est pas un effet, c est une composition — et batir une regle dessus');
  console.log('     reviendrait a mesurer la repartition des strates, pas les drapeaux.');
}

/* ── `armed`, QUI PRODUIT `rug_ready` — LE VERDICT LE PLUS SEVERE DU PRODUIT ──────────────────────
 * Il merite le meme traitement que tout le reste aujourd'hui: son compte, sa base, son plafond. */
console.log('\n  ── `armed`, qui produit rug_ready ──\n');
for (const [nom, g] of [['armed = 0', rows.filter((t) => nbArmed(t) === 0)],
  ['armed >= 1', rows.filter((t) => nbArmed(t) >= 1)]]) {
  const x = taux(g);
  console.log('    ' + nom.padEnd(12) + String(g.length).padStart(6) + ' tok · ' + x.r + '/' + x.res
    + ' · ' + (x.p == null ? 'n/a' : x.p.toFixed(1) + ' %')
    + (x.p == null ? '' : '   ' + ((x.p - BASE >= 0 ? '+' : '') + (x.p - BASE).toFixed(1) + ' pts')));
}
const arme = taux(rows.filter((t) => nbArmed(t) >= 1));
if (arme.res) {
  const plafond = 100 - BASE;
  console.log(`\n  ⛔ LE VERDICT LE PLUS SEVERE N A AUCUN ECART MESURE. \`armed >= 1\` tire sur `
    + `${rows.filter((t) => nbArmed(t) >= 1).length} token(s) sur ${rows.length} (`
    + `${(100 * rows.filter((t) => nbArmed(t) >= 1).length / rows.length).toFixed(1)} %) et rugge au`);
  console.log(`     taux de base, a ${(arme.p - BASE).toFixed(1)} point pres, alors que le plafond`
    + ` atteignable est +${plafond.toFixed(1)} points.`);
  console.log(`  ⚠️ BORNE: ${arme.res} appels resolus. C'est au-dessus du plancher de 20 que ce depot`);
  console.log('     s impose, donc le chiffre se publie — mais de justesse, et il ne portera un verdict');
  console.log('     solide qu a plusieurs fois cet effectif. Un ecart nul sur 24 appels n est pas une');
  console.log('     preuve d inutilite: c est une absence de preuve d utilite, et les deux se disent');
  console.log('     differemment.');
}
console.log('');
