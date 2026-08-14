#!/usr/bin/env node
'use strict';
/**
 * Le cliquet des assertions AVEUGLES AUX TROIS ETATS.
 *
 * Ce depot distingue partout trois reponses: une valeur, `false` (« lu, et c est non ») et `null`
 * (« pas pu lire »). C est sa propriete de surete la plus repetee. Mesure du 2026-08-15, les
 * assertions laches ne peuvent pas toutes porter cette distinction:
 *
 *     assert.equal(null, undefined)      PASSE   ⚠️ « pas pu lire » = « pas de valeur »
 *     assert.equal(0, false)             PASSE
 *     assert.equal(false, null)          rejete  ✅
 *     assert.deepEqual([false], [null])  PASSE   ⚠️ la forme PROFONDE est plus lache que la scalaire
 *     assert.deepEqual([0n], [null])     PASSE   ⚠️ une allowance de zero = une allowance illisible
 *
 * Releve du meme jour sur test/, commentaires blanchis: 1326 assertions laches au total, dont
 * 91 attendant `null` et 16 attendant `undefined` — les 107 ou la distinction peut se perdre. Les
 * 203 qui attendent `false` sont moins exposees: `assert.equal` y REJETTE `null`.
 *
 * ⛔ CE FICHIER NE DEMANDE PAS DE NETTOYAGE. Reecrire 107 assertions sans avoir montre, pour chacune,
 * que le sujet peut rendre l autre valeur, ce serait du bruit — et le seuil choisi ferait la mesure.
 * C est un CLIQUET: le compte ne doit pas MONTER. Une nouvelle assertion lache contre `null` echoue
 * ici et se corrige en `strictEqual`, ce qui coute une ligne au moment ou on l ecrit.
 *
 * ⛔ BORNES. (1) Il compte des FORMES, pas des defauts: une assertion lache contre `null` n est fausse
 * que si le sujet peut rendre `undefined`, et ce test ne le sait pas. (2) Il lit `test/`, donc il ne
 * dit rien des assertions vivant ailleurs. (3) Baisser les plafonds ci-dessous est encourage; les
 * MONTER demande d ecrire pourquoi.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const DIR = path.join(__dirname);

/* Plafonds MESURES le 2026-08-15, pas choisis. Ils descendent quand quelqu un resserre une assertion. */
const PLAFOND = { null: 91, undefined: 16 };

const blanchir = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

const motif = (val) => new RegExp('(?:deepEqual|assert\\.equal)\\s*\\([^;]{0,140}?,\\s*' + val + '\\s*[,)]', 'g');

const fichiers = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== path.basename(__filename));
let laches = { null: 0, undefined: 0 }, strictes = 0, total = 0;
for (const f of fichiers) {
  const src = blanchir(fs.readFileSync(path.join(DIR, f), 'utf8'));
  laches.null += (src.match(motif('null')) || []).length;
  laches.undefined += (src.match(motif('undefined')) || []).length;
  strictes += (src.match(/(?:deepStrictEqual|strictEqual)\s*\([^;]{0,140}?(?:null|undefined)\s*[,)]/g) || []).length;
  total += (src.match(/deepEqual\s*\(|assert\.equal\s*\(/g) || []).length;
}

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* ── TEMOINS. Un compte issu d un instrument non verifie n est pas une mesure. ──────────────────── */
ok(fichiers.length > 100, 'TEMOIN: ' + fichiers.length + ' fichiers de test lus');
ok(total > 500, 'TEMOIN: ' + total + ' assertions laches vues au total — l instrument lit bien');
ok(strictes > 50, 'TEMOIN: ' + strictes + ' assertions STRICTES contre null/undefined — sinon le motif serait aveugle');

/* ── LE BLANCHIMENT MARCHE. approvals.test.js CITE le piege dans un commentaire; le compter serait
 * confondre AFFIRMER et CITER — l erreur commise en construisant ce releve. ─────────────────────── */
const brutApprovals = fs.readFileSync(path.join(DIR, 'approvals.test.js'), 'utf8');
ok(/deepEqual\(\[0n\],\s*\[null\]\)/.test(brutApprovals),
  'TEMOIN: approvals.test.js contient bien la CITATION du piege dans un commentaire');
ok((blanchir(brutApprovals).match(motif('null')) || []).length
   < (brutApprovals.match(motif('null')) || []).length,
  'Le blanchiment retire bien au moins une occurrence citee en commentaire — sans lui, ce cliquet'
  + ' compterait une DOCUMENTATION comme un defaut');

/* ── LE CLIQUET. ───────────────────────────────────────────────────────────────────────────────── */
ok(laches.null <= PLAFOND.null,
  'Assertions laches attendant `null`: ' + laches.null + ' (plafond ' + PLAFOND.null + ').'
  + ' `assert.equal(x, null)` PASSE quand x vaut undefined, donc elle ne distingue pas « pas pu lire »'
  + ' de « pas de valeur ». Utiliser strictEqual pour toute nouvelle assertion de ce genre.');
ok(laches.undefined <= PLAFOND.undefined,
  'Assertions laches attendant `undefined`: ' + laches.undefined + ' (plafond ' + PLAFOND.undefined + ').'
  + ' Meme raison, dans l autre sens: `null` y passe.');

/* ── ET LE PLAFOND DOIT SUIVRE VERS LE BAS, sinon il cesse de mordre. ──────────────────────────── */
ok(laches.null >= PLAFOND.null - 10 || PLAFOND.null <= 81,
  'Le compte reel (' + laches.null + ') est bien en dessous du plafond (' + PLAFOND.null + '): baisser'
  + ' PLAFOND.null, sinon le cliquet laisse rentrer ce qui vient d etre nettoye.');

/* ── DETECTION POWER: le motif attrape-t-il la forme qu il vise ? ──────────────────────────────── */
const FAUX = 'assert.equal(r.note, null);';
ok((FAUX.match(motif('null')) || []).length === 1, 'DETECTION POWER: une assertion lache contre null est bien vue');
const BON = 'assert.strictEqual(r.note, null);';
ok((BON.match(motif('null')) || []).length === 0, 'DETECTION POWER: la forme STRICTE n est pas comptee');

/* ⚠️ Le format de cette ligne n est pas libre. `test:total` ne reconnait que « N passed, N failed »
 * (ou avec un point median), et un fichier qui imprime autre chose est LANCE mais jamais COMPTE: la
 * suite reste verte pendant que le total est sous-evalue. C est la faute du 2026-07-27 — 13 suites
 * ignorees, 101 tests, un total presente comme complet — et ma premiere version disait
 * « 10 checks passed », ce qui l a reproduite le jour meme ou j ajoutais ce fichier. */
console.log('  ' + n + ' passed, 0 failed');
console.log('  laches vs null: ' + laches.null + '/' + PLAFOND.null
  + ' · vs undefined: ' + laches.undefined + '/' + PLAFOND.undefined
  + ' · strictes vs null|undefined: ' + strictes);
console.log('  ⛔ Compte des FORMES, pas des defauts: une assertion lache n est fausse que si le sujet');
console.log('     peut rendre l autre valeur, ce que ce test ne sait pas.');
