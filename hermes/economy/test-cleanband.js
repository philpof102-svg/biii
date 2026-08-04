#!/usr/bin/env node
// test-cleanband.js — la bande verte disait « presque rien n'a rugge ici » sur un balayage qui
// n'avait pas eu lieu.
// ================================================================================================
// token-radar.js calculait :
//
//     const clean = c.liq >= 15000 && (sib === undefined || sib < INDUSTRIAL_FUNDER);
//
// `siblingCount` vaut `null` — pas `undefined` — quand l'explorateur n'a pas repondu sur l'historique
// du financeur (c'est ecrit ligne 522 du fichier). Mesure :
//
//     null === undefined  ->  false   la garde ne le voit pas
//     null < 20           ->  true    null se coerce en 0 : « moins de 20 freres »
//
// Un token dont le financeur n'a jamais ete verifie ressortait donc en 🟢. Et `siblingCountCensored`,
// calcule ligne 556 precisement pour marquer « ce compte est un plancher, pas un compte », n'avait
// AUCUN consommateur : le drapeau existait, la decision l'ignorait.
//
// Ce n'est pas qu'une question de prudence, c'est une question de fidelite a la mesure. Le 26/07 :
//
//     < 15k$ OU financeur industriel        55/65 = 85%
//     >= 15k$ ET pas d'usine                 2/34 =  6%
//     ...restreint aux tokens AVEC frères     0/15 =  0%
//
// La bande a 6% n'a jamais couvert les tokens sans donnee freres. Le code les y mettait quand meme.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); };

const INDUSTRIAL_FUNDER = 20;

// La decision telle qu'elle est ecrite aujourd'hui dans token-radar.js.
function decide({ liq, siblingCount, siblingCountCensored }) {
  const sib = siblingCount;
  const sibRead = typeof sib === 'number' && !siblingCountCensored;
  const clean = liq >= 15000 && sibRead && sib < INDUSTRIAL_FUNDER;
  return { clean, unknown: liq >= 15000 && !sibRead };
}

console.log('\n  la bande verte exige les DEUX moities, pas une');
{
  ok(decide({ liq: 50000, siblingCount: 3 }).clean === true, 'seed 50k + 3 freres lus -> vert');
  ok(decide({ liq: 50000, siblingCount: 26 }).clean === false, '26 freres = usine -> pas vert');
  ok(decide({ liq: 50000, siblingCount: 20 }).clean === false, 'pile au seuil (20) -> pas vert');
  ok(decide({ liq: 9000, siblingCount: 3 }).clean === false, 'seed sous 15k -> pas vert meme sans usine');
  ok(decide({ liq: 15000, siblingCount: 0 }).clean === true, 'pile a 15k avec 0 frere -> vert');
}

console.log('\n  un balayage qui n a pas eu lieu n est PAS un petit compte');
{
  // Le defaut exact : null passait la garde `undefined` puis se coercait en 0.
  const r = decide({ liq: 50000, siblingCount: null });
  ok(r.clean === false, 'siblingCount null -> PAS vert');
  ok(r.unknown === true, '...et marque explicitement comme indeterminable');
  const u = decide({ liq: 50000, siblingCount: undefined });
  ok(u.clean === false, 'siblingCount undefined -> PAS vert non plus');
  ok(u.unknown === true, '...egalement marque');

  // La preuve que l ancienne ligne les laissait passer, sur les memes entrees.
  const ancien = (liq, sib) => liq >= 15000 && (sib === undefined || sib < INDUSTRIAL_FUNDER);
  ok(ancien(50000, null) === true, 'ancien: null sortait VERT');
  ok(ancien(50000, undefined) === true, 'ancien: undefined sortait VERT');
  ok(null < INDUSTRIAL_FUNDER, 'et voila pourquoi: null < 20 est vrai, null se coerce en 0');
  ok((null === undefined) === false, '...tandis que null === undefined est faux, donc la garde ratait');
}

console.log('\n  un compte CENSURE est un plancher, pas un compte');
{
  // siblingCountCensored = lecture ratee, page tronquee, ou plafond a 50. Dans les trois cas le
  // nombre qu on tient peut etre tres en dessous du vrai.
  ok(decide({ liq: 50000, siblingCount: 5, siblingCountCensored: true }).clean === false,
    '5 freres mais compte tronque -> PAS vert (le vrai peut etre 500)');
  ok(decide({ liq: 50000, siblingCount: 5, siblingCountCensored: true }).unknown === true,
    '...et marque indeterminable');
  ok(decide({ liq: 50000, siblingCount: 5, siblingCountCensored: false }).clean === true,
    'le meme compte non censure reste vert — la garde ne refuse pas tout');
}

console.log('\n  la borne : la bande reste utilisable');
{
  // Une garde qui refuse tout n est pas une garde, c est une panne. Le vert doit encore sortir.
  const sains = [
    { liq: 20000, siblingCount: 0 }, { liq: 50000, siblingCount: 1 },
    { liq: 100000, siblingCount: 19 }, { liq: 15000, siblingCount: 12 },
  ];
  ok(sains.every((t) => decide(t).clean === true), `${sains.length} tokens sains sortent tous en vert`);
  ok(sains.every((t) => decide(t).unknown === false), '...et aucun n est marque indeterminable');
}

console.log('\n  le fichier expedie fait bien ca');
{
  // Reclamation de CLASSE, commentaires retires : ce test et le fichier citent tous deux l ancienne
  // ligne pour l expliquer, et un scan qui ne distingue pas le code du commentaire signale le
  // correctif comme le defaut.
  const src = fs.readFileSync(path.join(__dirname, 'token-radar.js'), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  ok(!src.some((l) => /sib === undefined \|\| sib < INDUSTRIAL_FUNDER/.test(l)),
    'l ancienne condition ne survit pas dans le code');
  ok(src.some((l) => /typeof sib === 'number' && !db\[c\.addr\]\.siblingCountCensored/.test(l)),
    'la lecture est exigee explicitement');
  ok(src.some((l) => /cleanBandUnknown/.test(l)), 'et le troisieme etat est enregistre');
  // siblingCountCensored avait zero consommateur avant ce correctif.
  const uses = src.filter((l) => /siblingCountCensored/.test(l));
  ok(uses.length >= 2, `siblingCountCensored est desormais lu, pas seulement ecrit (${uses.length} lignes)`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
