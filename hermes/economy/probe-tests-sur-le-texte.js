#!/usr/bin/env node
// probe-tests-sur-le-texte.js — quels tests jugent le TEXTE du code au lieu de son EFFET ?
// ================================================================================================
// Le 2026-08-05, `test/b20-unread-is-not-ok.test.js` asserait la SYNTAXE de l'affectation
// (`b20Check =` present dans la source) et restait vert pendant que cette ecriture etait MORTE: sa
// garde `if (db[c.addr])` etait fausse par construction, et zero token sur 1880 portait le champ.
// Le test prouvait « le code le dit », jamais « le code le fait ».
//
// ⛔ LIRE LA SOURCE N'EST PAS UNE FAUTE EN SOI. Certaines invariantes ne se testent QUE la: « aucun
// catch muet », « le helper canonique est appele », « le README porte le chiffre courant ». Ce depot
// en compte plusieurs, ecrites a dessein. La faute est le test qui juge le texte ALORS QUE l'effet
// etait exercable — il tient la place d'une preuve et n'en est pas une.
//
// Le discriminant retenu, faute de mieux et il est DECLARE: un fichier de test qui lit une source de
// production SANS jamais require() de module de production ne peut, par construction, observer aucun
// comportement. C'est un signalement, pas un verdict: la liste se lit, elle ne se coupe pas.
//
// ⚠️ Les commentaires sont blanchis avant analyse — trois gardes de cette session ont lu leur propre
// documentation comme du code.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..', '..');
const DIR = path.join(RACINE, 'test');
const fichiers = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();

const blanchir = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

/* ⛔ LA GRANULARITE DU FICHIER EST AVEUGLE AU CAS QUI A MOTIVE CET INSTRUMENT, et il a fallu le
 * verifier pour le voir. `test/b20-unread-is-not-ok.test.js` fait LES DEUX: il require('../lib/b20.js')
 * — donc il « exerce » — ET il asserte /b20Check\s*[:=]\s*'unread'/ sur le TEXTE de token-radar.js.
 * Classe propre au niveau fichier, c'est pourtant l'assertion exacte restee verte sur une ecriture
 * morte. On compte donc aussi les ASSERTIONS dont le sujet est une chaine de source. */
const ASSERTION_TEXTUELLE = /assert[^\n]*(\.test\(\s*(SRC|src|source|CODE|code)\b|(SRC|src|source|CODE|code)\.(includes|match|indexOf))/;
const parAssertion = [];

const lisent = [], exercent = [], texteSeul = [];
for (const f of fichiers) {
  const code = blanchir(fs.readFileSync(path.join(DIR, f), 'utf8'));
  /* Lire une SOURCE de production: readFileSync pointant vers lib/, bin/, hermes/ ou scripts/. */
  const litSource = /readFileSync\([^)]*(lib|bin|hermes|scripts|eval)[\/'"]/.test(code)
    || /readFileSync\([^)]*join\([^)]*'\.\.'[^)]*(lib|bin|hermes|scripts)/.test(code);
  /* Exercer: require() d'un module de production (pas node: ni un autre test). */
  const exerce = /require\(\s*'\.\.\/(lib|bin|hermes|vendor|eval)\//.test(code);
  if (litSource) lisent.push(f);
  if (exerce) exercent.push(f);
  if (litSource && !exerce) texteSeul.push(f);

  /* Les assertions dont le SUJET est une chaine de source, ligne par ligne — la granularite ou vit
   * reellement le defaut. Un fichier peut exercer neuf fois et juger le texte la dixieme. */
  code.split('\n').forEach((l, i) => {
    if (ASSERTION_TEXTUELLE.test(l)) parAssertion.push({ f, n: i + 1, exerce, l: l.trim().slice(0, 84) });
  });
}

console.log(`\n  ${fichiers.length} fichier(s) dans test/`);
console.log(`  ${lisent.length} lisent une source de production`);
console.log(`  ${exercent.length} require() un module de production`);
console.log(`  ${texteSeul.length} lisent la source SANS jamais l executer\n`);

if (!texteSeul.length) {
  console.log('  (aucun test purement textuel)\n');
} else {
  console.log('  ── tests qui jugent le TEXTE sans jamais observer un COMPORTEMENT ──\n');
  for (const f of texteSeul) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const n = (blanchir(src).match(/assert/g) || []).length;
    console.log(`    ${f.padEnd(42)} ${String(n).padStart(3)} assertion(s)`);
  }
  console.log('\n  ⚠️ CE N EST PAS UNE LISTE DE FAUTES. Plusieurs de ces gardes ne PEUVENT pas s ecrire');
  console.log('     autrement (une invariante de forme, un chiffre de README, un catch muet). La question');
  console.log('     a poser a chacune: l effet etait-il exercable ? si oui, le texte tient la place d une');
  console.log('     preuve. C est ainsi que b20-unread-is-not-ok.test.js est reste vert sur une ecriture morte.');
}
console.log('');

/* ── granularite ASSERTION: la ou le defaut vit reellement ──────────────────────────────────── */
console.log(`  ── assertions dont le SUJET est une chaine de SOURCE : ${parAssertion.length}\n`);
const masquees = parAssertion.filter((a) => a.exerce);
for (const a of parAssertion) {
  console.log(`    ${(a.f + ':' + a.n).padEnd(46)} ${a.exerce ? '⚠️ fichier qui EXERCE par ailleurs' : '(fichier textuel)'}`);
  console.log(`      ${a.l}`);
}
console.log(`\n  ${masquees.length} assertion(s) textuelle(s) DANS des fichiers qui exercent par ailleurs.`);
console.log('  ⛔ C est exactement la que le defaut se cache: le fichier passe pour comportemental,');
console.log('     et cette assertion-la ne prouve que la presence d une chaine dans le source.\n');
