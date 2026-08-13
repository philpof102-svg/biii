'use strict';
/**
 * unreleased-work-is-declared — ce qui est CORRIGE mais pas PUBLIE doit etre ECRIT.
 * =================================================================================
 * Le CHANGELOG raconte deja une fois le bug "ce qui est publie n est pas ce qu on croit": un tag v0.2.0
 * pointait un commit declarant 0.1.0, et la CI a publie 0.1.0 sous un tag annoncant 0.2.0. La garde ajoutee
 * alors refuse de publier quand tag, package.json et server.json divergent.
 *
 * Cette garde ne se declenche QU AU MOMENT DE PUBLIER. Elle protege contre publier la MAUVAISE chose; rien
 * ne protege contre NE PAS PUBLIER la bonne. Mesure du 2026-08-13: biii-mcp@0.2.1 sert l arbre de d928b38
 * (27/07), soit 514 commits en arriere, SANS la garde finite(null) — donc un agent qui n a jamais paye y est
 * note comme s il avait paye aujourd hui, 13 points de fail-open — et SANS aucune echeance reseau. Et comme
 * trust-core est en bundleDependencies, personne ne peut corriger ca en mettant a jour une dependance: le
 * seul chemin est une republication. L absence d action est muette; ce test lui donne une voix.
 *
 * PROPRIETE, bidirectionnelle et sans seuil: une section `## Unreleased` existe SI ET SEULEMENT SI du code
 * EMBARQUE a change depuis le commit qui a pose la version courante. Le sens direct empeche un ecart de
 * tenir en silence; la reciproque empeche qu un `## Unreleased` permanent rende le test vide — c est
 * exactement la fossilisation qui a deja vide d autres gates de ce depot.
 *
 * ⛔ CE QUE CE TEST NE PROUVE PAS. Il lit GIT, jamais le registre npm: il etablit "l arbre a bouge depuis
 * que ce numero a ete pose", jamais "npm sert X". Une publication faite hors de ce depot, ou depuis un
 * arbre sale, lui est invisible. Il ne juge pas non plus la GRAVITE de l ecart — un commit de typo et un
 * fail-open de 13 points comptent pareil. Il exige qu on l ECRIVE, pas qu on publie.
 *
 * Run: node test/unreleased-work-is-declared.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const RACINE = path.join(__dirname, '..');
const PKG = require(path.join(RACINE, 'package.json'));
const CHANGELOG = fs.readFileSync(path.join(RACINE, 'CHANGELOG.md'), 'utf8');

const git = (...a) => execFileSync('git', ['-C', RACINE, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

console.log('BIII — le travail corrige mais non publie est declare:');

// Les repertoires EMBARQUES, lus depuis `files` plutot qu ecrits en dur: un nouveau repertoire livre entre
// donc automatiquement dans la mesure. `data/` est exclu — la flotte y commite des observations chaque heure,
// et un gate qui rougit toutes les heures sur de la donnee se fait desactiver, ce qui est pire qu aucun gate.
const CODE_LIVRE = (PKG.files || [])
  .filter((f) => f.endsWith('/') && !f.startsWith('data'))
  .map((f) => f.replace(/\/$/, ''));

let depot = true;
try { git('rev-parse', '--git-dir'); } catch { depot = false; }

if (!depot) {
  // Un checkout autonome (PaaS, tarball) n a pas d historique. On le DIT, et ca ne compte pas comme un succes:
  // un test qui passe vert sans avoir rien regarde est le fail-open que ce depot chasse partout ailleurs.
  console.log('  ! IGNORE — pas un checkout git, l ecart avec la version publiee est INMESURABLE ici.');
  console.log('\n' + pass + ' passed, ' + fail + ' failed, 1 skipped');
  process.exit(1);
}

t('CONTRE-BORNE — la mesure voit un vrai commit de release et un vrai corpus embarque', () => {
  assert.ok(CODE_LIVRE.length >= 3,
    'moins de 3 repertoires embarques lus dans `files` — la mesure porterait sur presque rien.');
  const suivis = git('ls-files', '--', ...CODE_LIVRE).split('\n').filter(Boolean).length;
  assert.ok(suivis >= 40,
    'seulement ' + suivis + ' fichiers embarques suivis par git; sous 40 ce test passerait vert sur un '
    + 'arbre vide — il affirmerait au lieu de mesurer.');
});

t('le commit qui a pose la version courante est resolvable — sans lui, rien n est mesurable', () => {
  const c = git('log', '--format=%H', '-S', '"version": "' + PKG.version + '"', '--', 'package.json')
    .split('\n').filter(Boolean);
  assert.ok(c.length > 0,
    'aucun commit ne pose "version": "' + PKG.version + '" dans package.json. Impossible de dater ce que '
    + 'le numero publie recouvre — le test echoue plutot que de supposer.');
});

t('`## Unreleased` existe SI ET SEULEMENT SI du code embarque a bouge depuis ce numero', () => {
  const commits = git('log', '--format=%H', '-S', '"version": "' + PKG.version + '"', '--', 'package.json')
    .split('\n').filter(Boolean);
  const release = commits[commits.length - 1];          // le plus ancien = celui qui a INTRODUIT le numero
  const bouge = git('diff', '--name-only', release + '..HEAD', '--', ...CODE_LIVRE)
    .split('\n').filter(Boolean);
  const declare = /^##\s+Unreleased/mi.test(CHANGELOG);

  if (bouge.length && !declare) {
    assert.fail(bouge.length + ' fichier(s) embarque(s) ont change depuis ' + release.slice(0, 7) + ' (qui a '
      + 'pose ' + PKG.version + '), et le CHANGELOG n a pas de section `## Unreleased`. Ce que npm sert '
      + 'sous ce numero n est donc PLUS ce que ce depot contient, et rien ne le dit. ⛔ Ne PAS corriger en '
      + 'bumpant la version: server.json est soumis au MCP Registry et doit nommer une version qui EXISTE '
      + 'sur npm — un numero pose en avance cree un manifeste vrai dans sa forme et faux a l installation '
      + '(voir _publishing_note). Le correctif est d ECRIRE la section. Exemples: ' + bouge.slice(0, 3).join(', '));
  }
  if (!bouge.length && declare) {
    assert.fail('le CHANGELOG porte `## Unreleased` alors qu AUCUN fichier embarque n a bouge depuis '
      + release.slice(0, 7) + '. Une section qui reste en place apres la publication satisfait ce test pour '
      + 'toujours et le vide de son sens — le retirer fait partie du release.');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
