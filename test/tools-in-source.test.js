#!/usr/bin/env node
'use strict';
/**
 * toolsInSource — le défaut que sa propre docstring dit avoir corrigé était toujours atteignable.
 * ================================================================================================
 * Ce fichier compte les outils déclarés dans un source, et ce nombre alimente le contrôle de DÉRIVE
 * (source vs endpoint déployé). Sa docstring raconte qu'une première version, à base de regex, comptait
 * `name: 'biii'` — le nom du serveur dans son bloc `serverInfo` — comme un outil, produisant une dérive
 * fantôme permanente de 1. Le correctif a été de préférer `require(...).TOOLS`.
 *
 * ⚠️ MAIS LA REGEX EST RESTÉE EN REPLI, ET LE REPLI ÉTAIT SILENCIEUX. Mesure du 2026-07-29, un même
 * fichier à 3 outils portant aussi un `serverInfo = { name: … }` :
 *
 *     exporte TOOLS                        -> 3   correct
 *     sans module.exports (repli regex)    -> 4   la regex compte serverInfo
 *     exporte TOOLS mais JETTE au require  -> 4   repli SILENCIEUX vers la méthode fautive
 *
 * Le troisième est le vrai défaut : un fichier qui exporte parfaitement `TOOLS` mais dont le chargement
 * échoue — dépendance absente, effet de bord, erreur dans un module importé — rendait un nombre
 * indiscernable d'un nombre faisant autorité. Et l'en-tête du script dit précisément pourquoi c'est
 * grave : « a check that is red forever is a check everyone learns to skip ».
 *
 * ⚠️ LES BORNES. Tout ceci serait satisfait par une fonction qui répond « inconnu » partout : un module
 * qui exporte `TOOLS` doit rendre un compte EXACT, sans réserve — sinon plus aucune dérive n'est jamais
 * détectée et le contrôle devient décoratif.
 *
 * Run: node test/tools-in-source.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolsInSource } = require('../scripts/listing-manifest');

let pass = 0, fail = 0;
const t = (n, fn) => {
  try { fn(); pass++; console.log('  ok   ' + n); }
  catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e && e.message)); }
};
const ATTENDUS = 9;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tis-'));
const ecrire = (nom, src) => { const p = path.join(dir, nom); fs.writeFileSync(p, src); return p; };

/* 3 outils, PLUS un bloc serverInfo qui porte aussi un `name:` — le piège documenté. */
const TROIS = `
const TOOLS = [
  { name: 'alpha', description: 'a' },
  { name: 'beta',  description: 'b' },
  { name: 'gamma', description: 'c' },
];
const serverInfo = { name: 'monserveur', version: '1' };
module.exports = { TOOLS };
`;

try {
  console.log('toolsInSource — le nombre dit-il d\'où il vient ?\n');

  t('★ BORNE: un module qui exporte TOOLS rend un compte EXACT (3, pas 4)', () => {
    const r = toolsInSource(ecrire('bon.js', TROIS));
    assert.equal(r.count, 3, 'serverInfo ne doit pas être compté');
    assert.equal(r.method, 'module');
    assert.equal(r.exact, true);
    assert.equal(r.reason, null, 'un compte exact ne porte aucune réserve');
  });

  t('★ sans exports, le repli regex se DÉCLARE approximatif', () => {
    const r = toolsInSource(ecrire('sansexport.js', TROIS.replace('module.exports = { TOOLS };', '')));
    assert.equal(r.method, 'regex');
    assert.equal(r.exact, false, 'et surtout: il ne se fait pas passer pour exact');
  });
  t('   et il montre son imprécision plutôt que de la cacher (4 pour 3 outils)', () => {
    const r = toolsInSource(ecrire('sansexport2.js', TROIS.replace('module.exports = { TOOLS };', '')));
    assert.equal(r.count, 4, 'la regex compte aussi serverInfo — c\'est SU, donc déclaré');
    assert.match(r.reason, /phantom drift/, 'la raison rappelle ce que ça a déjà coûté');
  });

  t('★ un module qui JETTE au chargement n\'est plus approximé en silence', () => {
    const r = toolsInSource(ecrire('jette.js', "throw new Error('dependance manquante');\n" + TROIS));
    assert.equal(r.count, null, 'un nombre inventé ici deviendrait une fausse dérive');
    assert.equal(r.method, 'unreadable');
    assert.match(r.reason, /could not be loaded/);
  });
  t('   et la raison dit POURQUOI on n\'approxime pas', () => {
    const r = toolsInSource(ecrire('jette2.js', "throw new Error('boom');\n" + TROIS));
    assert.match(r.reason, /not approximated/);
    assert.match(r.reason, /deploy drift that is not there/);
  });

  t('un fichier absent est illisible, pas vide', () => {
    const r = toolsInSource(path.join(dir, 'absent.js'));
    assert.equal(r.count, null);
    assert.equal(r.method, 'unreadable');
  });

  t('★ les trois méthodes sont mutuellement exclusives', () => {
    const vues = new Set([
      toolsInSource(ecrire('m.js', TROIS)).method,
      toolsInSource(ecrire('r.js', TROIS.replace('module.exports = { TOOLS };', ''))).method,
      toolsInSource(path.join(dir, 'nope.js')).method,
    ]);
    assert.deepStrictEqual([...vues].sort(), ['module', 'regex', 'unreadable']);
  });

  t('★ CONTRAT: seul un compte exact peut fonder une accusation de dérive', () => {
    /* C'est la règle que le script applique : `inRepo` ne prend le nombre que si `exact`. Le vérifier
     * ici garde les deux moitiés cohérentes si l'une des deux bouge. */
    for (const r of [toolsInSource(ecrire('r2.js', TROIS.replace('module.exports = { TOOLS };', ''))),
      toolsInSource(path.join(dir, 'nope2.js'))]) {
      assert.equal(r.exact, false);
      assert.ok(r.reason && r.reason.length > 20, 'et il doit se justifier en clair');
    }
    assert.equal(toolsInSource(ecrire('m2.js', TROIS)).exact, true);
  });

  t('un TOOLS vide est un compte exact de zéro, pas une absence', () => {
    const r = toolsInSource(ecrire('vide.js', 'const TOOLS = [];\nmodule.exports = { TOOLS };\n'));
    assert.equal(r.count, 0, 'zéro outil déclaré est une RÉPONSE');
    assert.equal(r.exact, true);
  });

  const manquants = ATTENDUS - (pass + fail);
  if (manquants !== 0) { fail++; console.log('  FAIL le compte ne tombe pas : ' + (pass + fail - 1) + '/' + ATTENDUS); }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
