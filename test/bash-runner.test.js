#!/usr/bin/env node
'use strict';
/**
 * bash-runner — le portillon qui dit s'il a REGARDE.
 * =================================================
 * Ce helper existe parce que deux fichiers de test ont, a cinq jours d'ecart, publie un verdict sur
 * des scripts shell que `bash` n'avait jamais ouverts. Il porte donc TROIS etats la ou le code
 * d'origine en avait deux, et c'est la seule chose qui compte ici: `illisible` ne doit jamais se
 * laisser aplatir sur `invalide`, sous peine de faire d'une non-lecture une accusation.
 *
 * Les cas ci-dessous n'assertent presque rien sur le fond — c'est le but. Ils exigent que les
 * fonctions s'appellent sans jeter et que les trois etats restent trois. `node --check` ne prouve
 * rien ici: une variable non definie est une erreur d'EXECUTION, et ce depot a deja porte une
 * fonction morte sept heures avec une suite verte pour l'avoir oublie.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { posix, bashFormes, choisirFormeSyntaxe, verifierSyntaxe, classer } = require('./bash-runner');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('bash-runner — un echec de LECTURE n est pas un verdict:');

t('la traduction de chemin fait les deux formes, et laisse POSIX tranquille', () => {
  assert.strictEqual(posix('/mnt/')('D:\\a\\b.sh'), '/mnt/d/a/b.sh');
  assert.strictEqual(posix('/')('D:\\a\\b.sh'), '/d/a/b.sh');
  /* Sans lettre de lecteur (Linux/CI) seuls les separateurs bougent — sinon la forme `posix`
   * mangerait le chemin la ou il etait deja juste. */
  assert.strictEqual(posix('/mnt/')('/srv/a/b.sh'), '/srv/a/b.sh');
});

t('★ classer distingue TROIS etats, et jamais deux', () => {
  assert.deepStrictEqual(classer(null), { etat: 'valide' });
  assert.strictEqual(classer({ code: 'ENOENT' }).etat, 'illisible');           // pas de bash du tout
  assert.strictEqual(classer({ status: 127, stderr: 'bash: x.sh: No such file or directory' }).etat, 'illisible');
  assert.strictEqual(classer({ status: 2, stderr: 'x.sh: line 3: syntax error' }).etat, 'invalide');
});

t('★ le cas qui a coute le defaut: une NON-LECTURE ne ressort pas « invalide »', () => {
  const vu = classer({ status: 127, stderr: '/bin/bash: D:UsersVolKov...biii-scan.sh: No such file or directory' });
  assert.strictEqual(vu.etat, 'illisible');
  assert.notStrictEqual(vu.etat, 'invalide', 'un fichier jamais ouvert ne peut pas etre declare invalide');
});

t('bashFormes rend les trois formes, et n ajoute WSLENV que si on lui nomme des variables', () => {
  const sans = bashFormes();
  assert.strictEqual(sans.length, 3);
  assert.deepStrictEqual(sans.map((f) => f.nom), ['posix', 'gitbash', 'wsl']);
  assert.strictEqual(sans[2].env({ A: '1' }).WSLENV, undefined);
  const avec = bashFormes(['FOO', 'BAR']);
  assert.strictEqual(avec[2].env({ A: '1' }).WSLENV, 'FOO:BAR');
  /* Un WSLENV deja pose n est pas ecrase: on s ajoute derriere. */
  assert.strictEqual(avec[2].env({ WSLENV: 'DEJA' }).WSLENV, 'DEJA:FOO:BAR');
});

/* ── Les deux cas suivants FONT TRAVAILLER bash. Ils sont tolerants a son absence, mais ils le
 *    DISENT: un environnement sans bash ne doit pas se lire comme un environnement verifie. ─── */
const { forme: FORME, echecs: ECHECS } = choisirFormeSyntaxe();

t('★ le choix de forme est valide par un temoin POSITIF et son OPPOSE', () => {
  if (!FORME) {
    console.log('      (aucun bash utilisable ici — formes essayees: ' + ECHECS.join(' | ') + ')');
    assert.ok(ECHECS.length >= 3, 'les trois formes doivent avoir ete essayees et leur echec NOMME');
    return;
  }
  assert.ok(['posix', 'gitbash', 'wsl'].includes(FORME.nom));
});

t('★ TEMOIN OPPOSE — un script sain sort valide, un script casse sort invalide', () => {
  if (!FORME) { console.log('      (pas de bash: non mesure)'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-runner-test-'));
  try {
    const bon = path.join(tmp, 'bon.sh'); fs.writeFileSync(bon, '#!/bin/bash\necho ok\n');
    const casse = path.join(tmp, 'casse.sh'); fs.writeFileSync(casse, '#!/bin/bash\nif [ 1 ; then\n');
    /* Les deux sorties DOIVENT differer: identiques, elles ne mesureraient rien du tout. */
    assert.strictEqual(verifierSyntaxe(FORME, bon).etat, 'valide');
    assert.strictEqual(verifierSyntaxe(FORME, casse).etat, 'invalide');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('un fichier absent est « illisible », pas « invalide » — et bash n est meme pas derange', () => {
  const vu = verifierSyntaxe(FORME, path.join(os.tmpdir(), 'nexiste-pas-' + process.pid + '.sh'));
  assert.strictEqual(vu.etat, 'illisible');
});

t('sans forme utilisable, tout controle rend « illisible » — jamais un vert par defaut', () => {
  assert.strictEqual(verifierSyntaxe(null, __filename).etat, 'illisible');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
