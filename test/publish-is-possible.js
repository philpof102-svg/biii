#!/usr/bin/env node
'use strict';
/**
 * CE QUI EST CORRIGE ICI PEUT-IL SEULEMENT ATTEINDRE QUELQU'UN ?
 * Run: npm run test:publish        (reseau — DELIBEREMENT hors de `npm test`)
 *
 * ⚠️ LA CONDITION LETALE, ET ELLE EST SILENCIEUSE DES DEUX COTES. npm REFUSE de republier une
 * version existante. Donc quand la version locale EGALE la version publiee alors que des fichiers
 * expedies ont change, il ne se passe rien de visible: le registre annonce la meme version que le
 * depot (« a jour » au premier regard), et `npm publish` echoue en 403 le jour ou quelqu'un
 * l'essaie. Entre les deux, chaque correctif ecrit ici est INATTEIGNABLE pour un installateur.
 *
 * MESURE DU 2026-08-16 qui a fait naitre ce fichier: `biii-mcp` publie en 0.2.1 le 2026-07-27, la
 * version locale valait AUSSI 0.2.1 — et **163 commits** avaient touche des chemins expedies depuis,
 * dont 137 sur `lib/` et `bin/`. Le meme jour, `lawbor-bot`: 0.2.1 des deux cotes, 23 commits. Un
 * mois de correctifs fail-closed, dont aucun ne pouvait etre installe.
 *
 * ⚖️ CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS
 *   · Il repond a « PUBLIER EST-IL POSSIBLE ? », pas a « le contenu differe-t-il ? ». Ce sont deux
 *     questions: la seconde se mesure en comparant le tarball (voir le gate jumeau de `mainstreet`,
 *     `test/published-package-drift.js`), la premiere est sa PRECONDITION — un contenu different
 *     sous une version identique ne peut PAS partir, quel que soit l'ecart.
 *   · Il ne juge pas les commits: il les COMPTE. Un commit qui ne change rien d'expedie n'est pas
 *     compte, parce que la question est « y a-t-il quelque chose a publier », pas « a-t-on travaille ».
 *
 * ⛔ LECTURE SEULE. Un `npm view` borne. Aucune publication, aucun jeton, aucune ecriture.
 *
 * Codes de sortie: 0 = publier est possible (ou rien a publier) · 1 = BLOQUE · 2 = sonde muette.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));

/* Les chemins que `files` expedie, tels quels: on les donne a git en pathspec. Ils viennent du
 * package.json a CHAQUE run, donc la liste ne peut pas vieillir a cote de lui. */
const EXPEDIES = (PKG.files || []).filter((f) => !f.startsWith('!'));

let pass = 0, fail = 0;
const t = (nom, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + nom); }
  else { fail++; console.log('  FAIL ' + nom + (detail ? '\n       ' + detail : '')); }
};

(async () => {
  console.log('publier est-il possible ? — ' + PKG.name + ' ' + PKG.version + ' contre le registre:\n');

  let meta;
  try {
    meta = JSON.parse(execFileSync('npm', ['view', PKG.name, '--json'], { encoding: 'utf8', shell: true, timeout: 60000 }));
  } catch (e) {
    /* ⚖️ Un registre muet n'est PAS un verdict. Sortie 2, distincte du blocage (1) et du vert (0):
     * une panne de sonde ne doit jamais se lire comme « tout va bien » NI comme « c'est casse ». */
    console.log('  registre INJOIGNABLE : ' + String((e && e.message) || e).split('\n')[0]);
    console.log('\n  ⚠️ AUCUNE CONCLUSION.');
    process.exitCode = 2; return;
  }

  const publiee = meta.version;
  const dateDeLaVersion = (meta.time && meta.time[publiee]) || null;
  console.log('  version locale  : ' + PKG.version);
  console.log('  version publiee : ' + publiee + (dateDeLaVersion ? '  (' + dateDeLaVersion.slice(0, 10) + ')' : ''));

  if (PKG.version !== publiee) {
    t('la version locale DIFFERE de la publiee — un publish peut partir', true);
    console.log('\n  ⛔ Ce gate ne dit PAS que le contenu est a jour: il dit que rien ne BLOQUE la');
    console.log('     publication. Le contenu se compare en telechargeant le tarball.');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0; return;
  }

  /* Versions EGALES: la seule question qui reste est « y a-t-il quelque chose d'expedie qui a
   * change depuis ? ». Si oui, ce travail est enferme — npm refusera la republication. */
  if (!dateDeLaVersion) {
    console.log('  le registre ne date pas cette version — impossible de compter ce qui a change depuis.');
    console.log('\n  ⚠️ AUCUNE CONCLUSION.');
    process.exitCode = 2; return;
  }

  const compter = (chemins) => {
    const sortie = execFileSync('git', ['log', '--oneline', '--since=' + dateDeLaVersion, '--', ...chemins],
      { cwd: RACINE, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return sortie.split('\n').filter(Boolean);
  };

  /* ⚠️ LE NOMBRE DOIT PORTER SA COMPOSITION. Premier run de ce fichier: « 464 commits » — dont
   * l'immense majorite sont les commits HORAIRES de la base d'observations, que `files` expedie
   * aussi (`data/token-radar/tokens.json`). Les compter n'est pas faux — une base plus fraiche EST
   * une raison de publier, la fraicheur est le produit — mais annoncer 464 laisse croire a 464
   * correctifs enfermes. On separe donc CODE et DONNEES, et on imprime les deux. */
  let commits = [];
  let commitsCode = [];
  try {
    commits = compter(EXPEDIES);
    const horsDonnees = EXPEDIES.filter((f) => !f.startsWith('data/'));
    commitsCode = horsDonnees.length ? compter(horsDonnees) : [];
  } catch (e) {
    console.log('  git muet : ' + String((e && e.message) || e).split('\n')[0]);
    process.exitCode = 2; return;
  }

  const donnees = commits.length - commitsCode.length;
  t('version identique au publie ET aucun fichier expedie modifie depuis', commits.length === 0,
    commits.length + ' commit(s) ont touche des chemins de `files` depuis la publication de ' + publiee
      + '\n       — dont ' + commitsCode.length + ' sur du CODE et ' + donnees + ' sur des DONNEES expediees.'
      + '\n       npm REFUSE de republier une version existante, donc RIEN de tout cela ne peut atteindre'
      + '\n       un installateur. Les cinq changements de CODE les plus recents:\n       · '
      + (commitsCode.slice(0, 5).join('\n       · ') || '(aucun — seules les donnees ont bouge)')
      + '\n\n       Geste: monter la version dans package.json, puis publier.');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
