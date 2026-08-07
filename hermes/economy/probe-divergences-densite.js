#!/usr/bin/env node
// probe-divergences-densite.js — compter les divergences compte-vs-densite SANS melanger les instruments.
// ================================================================================================
// Le 2026-08-06 la mesure a montre que `siblingCount` porte une DENSITE et non un compte: parmi les
// tokens dont le vrai compte franchit 20, ceux qui le franchissent des la premiere page ruggent a
// 97,1 % (106 tokens) et ceux qui ne le franchissent qu'en profondeur a 3,7 % (27). Le seuil « choisi a
// la main » de 20 valait donc 20/50 = 0,40 destinataire par transaction.
//
// Depuis, `siblingTxScanned` est persiste et la densite se calcule. Reste a savoir ce qu'un seuil a 0,40
// vaudrait — ce qui exige des divergences RESOLUES, et cette sonde les compte.
//
// ⛔ ET ELLE NE LES COMPTE PAS TOUTES PAREIL, PARCE QU'ELLES NE SONT PAS LA MEME MESURE. `traceFeeder`
// rend QUATRE etats de balayage, verifies par le producteur (lib/feeder.js:332 et sa boucle):
//
//   · `end`        — l'historique est epuise. La densite porte sur TOUTE LA VIE du financeur.
//   · `page_cap`   — la borne de six pages est atteinte. La densite est exacte DANS la fenetre de ~300
//                    transactions, mais ce n'est pas un taux de vie: le reste de l'historique est inconnu.
//   · `read_error` — une page est tombee en cours. Meme forme que `page_cap`, sauf que la taille de la
//                    fenetre a ete decidee par une PANNE et non par un choix.
//   · `no_read`    — rien n'a ete lu. Aucune densite n'existe.
//
// Une densite `end` et une densite `page_cap` ne sont donc PAS la meme quantite. Les jeter dans un meme
// compteur et les comparer a un seul seuil, c'est refaire — dans l'analyse cette fois — la faute que ce
// depot a corrigee dans le code: deux instruments sous un nom.
//
// ⚠️ CE QUE CETTE SONDE PEUT PROUVER: combien de financeurs DISTINCTS divergent, dans quel SENS, et sur
// quel etat de balayage repose chaque divergence.
// ⛔ CE QU'ELLE NE PEUT PAS: chiffrer le seuil. Il y faut des divergences resolues sur lecture COMPLETE,
// en nombre suffisant. Le compte est publie; la conclusion ne l'est pas.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');

const SEUIL_COMPTE = 20;      // le seuil pose a la main, sur le COMPTE
const SEUIL_DENSITE = 0.40;   // son equivalent en densite, par l'identite 20/50

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

/* Un financeur, pas un token: quinze tokens derriere un financeur restent UN tirage. La cle porte le
 * couple compte/transactions, qui identifie une lecture de financeur. */
const parFinanceur = new Map();
for (const t of rows) {
  if (!(t.siblingTxScanned > 0) || typeof t.siblingCount !== 'number') continue;
  const cle = t.siblingCount + '/' + t.siblingTxScanned;
  if (!parFinanceur.has(cle)) {
    parFinanceur.set(cle, { cle, compte: t.siblingCount, tx: t.siblingTxScanned,
      arret: t.siblingScanStoppedBy || 'inconnu', pages: t.siblingPagesRead, tokens: [] });
  }
  parFinanceur.get(cle).tokens.push(t);
}

const lignes = [...parFinanceur.values()].map((f) => {
  const densite = f.compte / f.tx;
  const parCompte = f.compte >= SEUIL_COMPTE ? 'DANGER' : 'sur';
  const parDensite = densite >= SEUIL_DENSITE ? 'DANGER' : 'sur';
  const r = f.tokens.filter((t) => issue(t) === 'rugged').length;
  const res = f.tokens.filter((t) => issue(t) !== null).length;
  return { ...f, densite, parCompte, parDensite,
    diverge: parCompte !== parDensite,
    sens: parCompte === 'DANGER' ? 'compte plus severe' : 'densite plus severe',
    rug: r, resolus: res };
}).sort((a, b) => a.densite - b.densite);

console.log(`\n  ${lignes.length} financeur(s) distinct(s) portant une densite`
  + `  ·  ${lignes.reduce((s, f) => s + f.tokens.length, 0)} token(s) derriere eux\n`);
console.log('    compte/tx      densite  arret        tok  rug/res   compte / densite');
console.log('    ' + '-'.repeat(84));
for (const f of lignes) {
  console.log('    ' + f.cle.padEnd(14) + f.densite.toFixed(3).padStart(7) + '  ' + f.arret.padEnd(11)
    + String(f.tokens.length).padStart(5) + ('  ' + f.rug + '/' + f.resolus).padEnd(9)
    + f.parCompte.padEnd(7) + '/ ' + f.parDensite
    + (f.diverge ? '   <<< DIVERGE (' + f.sens + ')' : ''));
}

/* ── LE COMPTE QUI GOUVERNE, ET IL EST PLUS PETIT QU'IL N'Y PARAIT ────────────────────────────── */
const divergents = lignes.filter((f) => f.diverge);
const surLectureComplete = divergents.filter((f) => f.arret === 'end');
const surPlancher = divergents.filter((f) => f.arret === 'page_cap' || f.arret === 'read_error');
const resolus = surLectureComplete.filter((f) => f.resolus > 0);

console.log('\n  ── les divergences, par ce sur quoi elles reposent ──\n');
console.log(`    divergences au total                       ${divergents.length}`);
console.log(`    dont sur une lecture COMPLETE (\`end\`)      ${surLectureComplete.length}`);
console.log(`      dont au moins un token RESOLU            ${resolus.length}`);
console.log(`    dont sur un PLANCHER (page_cap/read_error) ${surPlancher.length}`);

console.log(`\n  ⛔ SEULES LES DIVERGENCES SUR LECTURE COMPLETE COMPTENT VERS LE CHIFFRAGE, et elles`);
console.log(`     doivent etre RESOLUES. Etat: ${resolus.length} sur les ${MIN_RESOLUS} qu'exige le plancher de ce depot.`);
if (surPlancher.length) {
  console.log(`  ⚠️ ${surPlancher.length} divergence(s) reposent sur une fenetre bornee. Leur densite est exacte DANS`);
  console.log('     la fenetre, mais ce n est pas un taux de vie: le reste de l historique est inconnu, et');
  console.log('     rien ne dit que la suite ressemble au debut. Les compter avec les lectures terminees');
  console.log('     melangerait deux quantites sous un seul nom — la faute meme que cette variable a subie.');
}

/* Les deux sens, separes: une regle qui ne se trompe que dans un sens n'a pas le meme cout qu'une regle
 * qui se trompe dans les deux. Jusqu'au 2026-08-07 toutes les divergences observees allaient dans le
 * sens « compte plus severe »; la premiere en sens inverse est apparue ce jour-la. */
const sensCompte = divergents.filter((f) => f.parCompte === 'DANGER').length;
console.log('\n  ── le SENS des divergences ──\n');
console.log(`    le COMPTE est plus severe que la densite    ${sensCompte}`);
console.log(`    la DENSITE est plus severe que le compte    ${divergents.length - sensCompte}`);
console.log('  ⚠️ Tant que les deux sens existent, la densite n est pas « plus permissive » que le compte:');
console.log('     elle reclasse dans les DEUX sens, et un chiffrage doit peser les deux erreurs separement.\n');
