#!/usr/bin/env node
// replay-ownerstate.js — pourquoi l'ARMEMENT selectionne-t-il des tokens MOINS dangereux ?
// ================================================================================================
// Anomalie mesuree le 04/08 et laissee sans explication: dans le palier `rug_ready`, la regle « proxy
// contract » ARMEE rugge a 82,4 % (17 tokens) quand la meme propriete simplement FLAGGEE rugge a
// 84,7 % (118 tokens). La condition qui promeut au palier le plus grave selectionne donc des tokens
// legerement moins dangereux — ce qui n'a aucun sens si l'armement mesure le danger.
//
// L'hypothese: armer exige `ownerState === 'live'`, c'est-a-dire que le propriétaire ait ete LU. Un
// token dont l'index de securite connait le proprietaire est un token INDEXE — peut-etre simplement
// un token moins jetable. Si c'est ca, l'armement ne mesure pas un pouvoir armable, il mesure la
// COUVERTURE de notre source, et il herite de sa correlation.
//
// Le test ne porte donc pas sur les proxys mais sur TOUTE la base: `ownerState` lu contre non lu.
// C'est le controle qui manque — et il est plus large que l'anomalie qu'il explique.
//
// ⚠️ CE QU'IL NE PEUT PAS DIRE. Une correlation entre lisibilite et survie n'etablit aucune cause. Un
// index couvre mieux ce qui vit plus longtemps, et un token qui vit plus longtemps a le temps d'etre
// indexe: les deux sens sont compatibles avec le meme chiffre, et rien ici ne les separe.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

/* ⚠️ « live » DANS CETTE BASE N'EST PAS « APPEL OUVERT ». Premiere version de ce script: elle comptait
 * tout `outcome === 'live'` comme non resolu et imprimait donc une borne haute de 100 % partout, ce qui
 * ecrasait le seul resultat interessant. Or la fenetre de maturite derivee vaut 4 h et le jeu couvre
 * dix jours: un token vu il y a des jours et toujours vivant a REPONDU. On reutilise donc le classement
 * canonique de lib/prequential.js — recopier sa logique ici en aurait fait une copie plus faible, ce
 * qui est le defaut le plus repete du depot. */
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);

const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);   // 'rugged' | 'survived' | null
const rugged = (t) => issue(t) === 'rugged';
const resolus = rows.filter((t) => issue(t) !== null);
const BASE = resolus.filter(rugged).length / resolus.length;

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(40)}    0 —`); return null; }
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const s = g.filter((t) => issue(t) === 'survived').length;
  const nr = g.length - r - s;                                    // non resolus: exclus des taux
  const res = r + s;
  const lift = res ? (r / res - BASE) * 100 : 0;
  console.log(`    ${label.padEnd(40)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(s).padStart(3)} surv · ${String(nr).padStart(2)} n.r. · `
    + `${res ? ((r / res) * 100).toFixed(1).padStart(5) : '  n/a'}% · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, s, bas: res ? r / res : null };
}

const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const etat = (t) => { const b = basis(t); return b ? String(b.ownerState || '(absent)') : '(pas de basis)'; };

console.log(`\n  taux de base : ${(BASE * 100).toFixed(1)}%  (${rows.length} tokens)`);
console.log('  colonnes : n · rug · survivants · non-resolus · taux · lift\n');

console.log('  ── LE CONTROLE : taux de rug par etat du proprietaire, sur TOUTE la base ──');
const etats = [...new Set(rows.map(etat))].sort();
const parEtat = new Map();
for (const e of etats) parEtat.set(e, ligne(e, rows.filter((t) => etat(t) === e)));

/* La comparaison qui decide: `live` (le seul etat qui permet d'armer) contre `unknown` (le plus
 * frequent, et celui qui l'INTERDIT). Si `live` rugge moins, l'armement herite d'une protection qui
 * n'a rien a voir avec le pouvoir qu'il pretend mesurer. */
const live = parEtat.get('live'), inconnu = parEtat.get('unknown');
if (live && inconnu) {
  const d = (live.bas - inconnu.bas) * 100;
  console.log(`\n    -> ecart live vs unknown : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  if (d < -5) {
    console.log('    ⭐ EXPLICATION TENUE: un proprietaire LU va de pair avec un taux de rug PLUS BAS.');
    console.log('       L armement exige cet etat, donc il herite de cette correlation — il selectionne');
    console.log('       la COUVERTURE de notre source, pas le danger. C est pourquoi « arme » rugge moins');
    console.log('       que « flagge ».');
  } else if (d > 5) {
    console.log('    ⛔ HYPOTHESE INVERSEE: un proprietaire lu rugge PLUS. L anomalie reste inexpliquee.');
  } else {
    console.log('    ⛔ HYPOTHESE MORTE: l etat du proprietaire ne separe pas. L anomalie de l armement');
    console.log('       vient d ailleurs, et n=17 suffit peut-etre a l expliquer par le bruit seul.');
  }
}

// Le meme decoupage RESTREINT aux proxys, pour voir si l'effet general suffit a couvrir l'anomalie.
const PROXY = /proxy contract|is_proxy/i;
const liste = (t, c) => (Array.isArray(t[c]) ? t[c] : []);
const proxyTouche = (t) => liste(t, 'armedAtFirstSight').concat(liste(t, 'flagsAtFirstSight'))
  .some((x) => PROXY.test(String(x)) && !/^\(defused/i.test(String(x)));

console.log('\n  ── le meme decoupage, restreint aux tokens qui mentionnent un proxy ──');
const px = rows.filter(proxyTouche);
for (const e of ['live', 'renounced', 'unknown']) ligne('proxy · ' + e, px.filter((t) => etat(t) === e));

console.log('\n  ⚠️ Une correlation entre LISIBILITE et survie n etablit aucune cause: un index couvre mieux');
console.log('     ce qui dure, et ce qui dure a le temps d etre indexe. Les deux sens donnent ce chiffre.');
