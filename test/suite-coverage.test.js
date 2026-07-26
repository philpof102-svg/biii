#!/usr/bin/env node
'use strict';
/**
 * Le garde-fou du test qui ne tourne jamais.
 *
 * Le 2026-07-26, ONZE fichiers de test vivaient dans test/ sans etre references par `npm test` — dont
 * `scorecard.test.js` et `radar-scope.test.js`, ecrits le soir meme en croyant les avoir branches. Ils
 * passaient : je les lancais a la main. Mais la suite annoncait "280 passed, 0 failed" sans les avoir vus,
 * et ce chiffre etait donc vrai ET incomplet — la pire combinaison, parce qu'il n'y a rien a remarquer.
 *
 * Un fichier de test non lance n'est pas un test faible, c'est un fichier de commentaires. Et il pourrit
 * en silence : le code qu'il protege peut deriver pendant des semaines sans qu'une seule ligne rougisse.
 *
 * Trois d'entre eux etaient invisibles pour une raison bete — ils ne finissaient pas par `.test.js`. D'ou
 * la verification sur TOUT fichier executable du dossier, pas sur un motif de nom.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test || '';

/* Exclusions DELIBEREES, nommees une par une. Une liste d'exclusion par motif se remplit toute seule et
 * finit par cacher exactement ce que ce test cherche ; une liste explicite oblige a justifier chaque ligne. */
const EXCLUS = new Set([
  'suite-coverage.test.js',   // ce fichier — il est lui-meme dans le script, mais s'auto-exclure evite un cycle de lecture
]);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('couverture de la suite : tout fichier de test est-il reellement lance ?');

const fichiers = fs.readdirSync(__dirname).filter((f) => /\.(c?js|mjs)$/.test(f) && !EXCLUS.has(f));

t('aucun fichier de test n\'est orphelin', () => {
  const orphelins = fichiers.filter((f) => !script.includes('test/' + f));
  assert.equal(orphelins.length, 0,
    orphelins.length + ' fichier(s) dans test/ que `npm test` ne lance pas — ils ne protegent rien :\n       '
    + orphelins.join('\n       '));
});

t('le script ne reference pas un fichier qui n\'existe plus', () => {
  const cites = [...script.matchAll(/node\s+test\/([\w.-]+)/g)].map((m) => m[1]);
  const fantomes = cites.filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.equal(fantomes.length, 0, 'reference(s) morte(s) : ' + fantomes.join(', '));
});

t('la detection ne depend PAS du suffixe .test.js', () => {
  // Trois des onze orphelins s'appelaient agent-vet-gate.js, lure-ask.js, seed-exposure.js. Un garde base
  // sur le nom les aurait rates exactement comme le script les ratait.
  const sansSuffixe = fichiers.filter((f) => !/\.test\.(c?js)$/.test(f));
  assert.ok(sansSuffixe.length > 0, 'sanity : il existe bien des tests sans le suffixe, sinon cette regle ne prouve rien');
  for (const f of sansSuffixe) {
    assert.ok(script.includes('test/' + f), f + ' n\'est pas lance et ne porte pas le suffixe — le cas exact du 26/07');
  }
});

t('le test mordrait vraiment — verifie sur un orphelin simule', () => {
  const faux = 'orphelin-imaginaire.test.js';
  assert.ok(!script.includes('test/' + faux), 'un fichier absent du script doit etre detecte comme orphelin');
});

console.log('\n' + fichiers.length + ' fichier(s) de test verifie(s)');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
