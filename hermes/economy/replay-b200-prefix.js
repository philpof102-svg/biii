#!/usr/bin/env node
// replay-b200-prefix.js — le prefixe 0xb200 apporte-t-il quelque chose que le financeur ne dit pas ?
// ================================================================================================
// Mesure precedente : les 156 adresses en 0xb200 ruggent a 83,3 % contre 75,3 % de base (+8,1 pts),
// et la regle vivante qui pose `rug_ready` n'en a marque qu'UNE, parce qu'elle exige en plus du
// bytecode ERC-20 ordinaire.
//
// La tentation est d'elargir la regle au prefixe seul. C'est exactement l'erreur qui a tue la regle
// d'usurpation de symbole le 26/07 : elle semblait porter un signal (+2 pts par symbole distinct),
// jusqu'a ce qu'on retire les prises que le financeur industriel attrapait DEJA — il restait 67 %
// sur 6 cas, soit −14 points, et deux fausses alertes confirmees.
//
// Donc la seule question qui vaut : le prefixe apporte-t-il quelque chose NET du financeur ?
//
// ⛔ Ce script MESURE et RAPPORTE. Il ne promeut aucun palier. Elargir un seuil en regardant les
// outcomes contre lesquels il sera note est l'erreur meme qu'on essaie de ne pas refaire — la
// decision demande un backtest prequentiel, pas un rejeu in-sample.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INDUSTRIAL = 20;
const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');
const BASE = rows.filter(rugged).length / rows.length;

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(38)}     0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = ((r / g.length - BASE) * 100).toFixed(1);
  console.log(`    ${label.padEnd(38)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${pct(r, g.length).padStart(6)} · ${r / g.length >= BASE ? '+' : ''}${lift} pts`);
  return { n: g.length, r, o };
}

// « usine » n'est vrai que si on a LU le compte. Un compte absent n'est pas un petit compte — c'est
// la lecon de cleanBand, appliquee ici pour ne pas gonfler artificiellement la part « nette ».
const usineLue = (t) => typeof t.siblingCount === 'number' && t.siblingCount >= INDUSTRIAL;
const nonUsineLue = (t) => typeof t.siblingCount === 'number' && t.siblingCount < INDUSTRIAL;
const compteInconnu = (t) => typeof t.siblingCount !== 'number';

const b200 = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));

console.log(`\n  taux de base : ${pct(rows.filter(rugged).length, rows.length)}  (${rows.length} tokens)`);
console.log(`\n  le prefixe, brut :`);
ligne('0xb200 (tous)', b200);

console.log('\n  decomposition du prefixe par ce que le FINANCEUR dit deja :');
const b200Usine = b200.filter(usineLue);
const b200Propre = b200.filter(nonUsineLue);
const b200Inconnu = b200.filter(compteInconnu);
ligne('0xb200 ET usine (deja attrape)', b200Usine);
ligne('0xb200 ET financeur lu, non-usine', b200Propre);
ligne('0xb200 ET compte NON LU', b200Inconnu);

console.log('\n  la contribution PROPRE du prefixe — la seule qui compte :');
console.log('    (les tokens que le prefixe signalerait et que le financeur ne signale pas)');
const contrib = ligne('contribution nette', b200Propre);
if (contrib) {
  const lift = ((contrib.r / contrib.n - BASE) * 100);
  console.log(`\n    -> ${contrib.r}/${contrib.n} rugges, ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts contre la base.`);
  if (contrib.n < 20) console.log(`    ⚠️ n=${contrib.n} : trop petit pour trancher. Ce n'est pas un resultat, c'est une indication.`);
  if (lift < 5) console.log('    ⚠️ Ecart faible : le prefixe ressemble au signal du financeur porte autrement.');
}

console.log('\n  le miroir : les non-0xb200, meme decoupage');
const nonB200 = rows.filter((t) => !String(t.addr).toLowerCase().startsWith('0xb200'));
ligne('non-0xb200, usine', nonB200.filter(usineLue));
ligne('non-0xb200, non-usine', nonB200.filter(nonUsineLue));

// ── LE CONTROLE QUI TRANCHE ────────────────────────────────────────────────────────────────────
// Les 156 sont TOUS dans le bucket « financeur non lu ». Donc leur +8,1 pts peut venir du prefixe
// OU du simple fait de ne pas avoir lu le financeur — et on sait deja que ne-pas-avoir-lu est
// associe a l'usine (26/07 : 15 des 20 `unknown` avaient creator: null, donc deployes par une usine).
// La comparaison honnete n'est donc PAS contre la base globale, c'est contre les autres non-lus.
console.log('\n  ⭐ LE CONTROLE : a l interieur du bucket « financeur NON LU »');
const nonLus = rows.filter(compteInconnu);
const nonLusB200 = nonLus.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));
const nonLusAutres = nonLus.filter((t) => !String(t.addr).toLowerCase().startsWith('0xb200'));
ligne('non lus, TOUS', nonLus);
ligne('non lus ET 0xb200', nonLusB200);
ligne('non lus, PAS 0xb200', nonLusAutres);
if (nonLusB200.length && nonLusAutres.length) {
  const a = nonLusB200.filter(rugged).length / nonLusB200.length;
  const b = nonLusAutres.filter(rugged).length / nonLusAutres.length;
  const d = (a - b) * 100;
  console.log(`\n    -> ecart du prefixe A L INTERIEUR du bucket : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  console.log(Math.abs(d) < 5
    ? '    ⛔ Sous 5 points : le prefixe n ajoute rien. Le +8,1 mesure « financeur non lu », pas 0xb200.'
    : '    Ecart non trivial : le prefixe porte quelque chose que « non lu » ne dit pas.');
}

console.log('\n  Lecture : si « 0xb200 non-usine » ne bat pas franchement la base sur un effectif non');
console.log('  trivial, le prefixe est le signal du financeur deguise — exactement ce qu on a trouve');
console.log('  pour l usurpation de symbole le 26/07, et ce qui l a fait retirer du verdict.');
