#!/usr/bin/env node
'use strict';
/**
 * suite-total — combien de tests cette suite lance-t-elle, REELLEMENT.
 *
 * POURQUOI CE FICHIER EXISTE
 * `npm test` enchaine une soixantaine de fichiers qui impriment chacun leur propre bilan, et personne
 * n'additionne. Le total finissait donc compte a la main, au jugé, et publie dans des messages de commit.
 * Deux fois de suite il etait faux:
 *
 *   2026-07-27, commit b : « Suite: 461 passed » — chiffre ecrit AVANT de lancer la suite. Reel: 459.
 *   2026-07-27, plus tard : « 473 passed » — chiffre MESURE, avec un compteur qui ne reconnaissait que
 *                           le separateur virgule. Les 13 suites qui separent avec un point median
 *                           (« N passed · M failed ») etaient ignorees en silence: 101 tests, 18 % de
 *                           la suite, absents d'un total presente comme complet.
 *
 * La seconde est la plus instructive: le nombre venait bien d'une mesure. C'est l'INSTRUMENT qui etait
 * faux, et un instrument faux rend un chiffre d'apparence tout a fait normale. Se promettre « d'etre plus
 * attentif » ne repare pas ca — un compteur dans le depot, si.
 *
 * DEUX FORMATS, PARCE QUE LES DEUX EXISTENT VRAIMENT
 * Les fichiers anciens impriment « N passed, M failed », les recents « N passed · M failed ». Aucun des
 * deux n'est a corriger: c'est au compteur de connaitre les deux, et d'echouer s'il en croise un
 * troisieme qu'il ne sait pas lire plutot que de l'omettre.
 *
 * ⚠️ UN SUCCES VIDE EST UN ECHEC. Si aucune ligne de bilan n'est reconnue, ce script sort en erreur au
 * lieu d'annoncer « 0 passed, 0 failed » d'un ton satisfait. Un zero rendu par un outil qui n'a rien su
 * lire ressemble trait pour trait a un zero mesure — c'est la meme faute que ce depot corrige dans
 * `standingVertex`, un etage plus haut.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');

/* On relance la vraie commande plutot que de redupliquer la liste des fichiers: une liste recopiee ici
 * divergerait de package.json sans que rien ne le signale, et on recompterait alors une suite qui n'est
 * pas celle qui tourne. */
/* La commande part en UNE chaine avec shell:true, et non en (commande, args[]) : Node 20+ refuse de
 * lancer un .cmd sans shell (CVE-2024-27980) et avertit quand on melange args[] et shell. Une chaine
 * unique passe les deux ecueils. Verifie ici meme: la variante `npm.cmd` + args[] a rendu « 0 bilans
 * lus » — et le garde-fou du succes-vide, quelques lignes plus bas, l'a attrapee. */
const r = spawnSync('npm test', { cwd: RACINE, encoding: 'utf8', shell: true });
const sortie = String(r.stdout || '') + String(r.stderr || '');

/* COMBIEN DE FICHIERS `npm test` LANCE-T-IL, d'apres package.json. C'est le denominateur: sans lui, ce
 * script ne saurait detecter qu'une chose — n'avoir RIEN lu. Un troisieme format de bilan apparaissant a
 * cote des deux connus passerait inapercu et on sous-compterait a nouveau, ce qui est precisement la
 * faute que ce fichier existe pour empecher. Compter les bilans sans savoir combien en attendre, c'est
 * refaire le bug avec une etape de plus. */
const scriptTest = String((require(path.join(RACINE, 'package.json')).scripts || {}).test || '');
const attendus = [...scriptTest.matchAll(/node\s+test\/([\w.-]+\.(?:c?js|mjs))/g)].map((m) => m[1]);

const BILANS = [
  { nom: 'virgule', re: /(\d+) passed, (\d+) failed/g },
  { nom: 'point median', re: /(\d+) passed · (\d+) failed/g },
];

let passed = 0, failed = 0, lignes = 0;
const parFormat = [];
for (const f of BILANS) {
  let n = 0, p = 0, e = 0;
  for (const m of sortie.matchAll(f.re)) { n++; p += Number(m[1]); e += Number(m[2]); }
  passed += p; failed += e; lignes += n;
  parFormat.push('  ' + String(n).padStart(3) + ' suite(s) au format « ' + f.nom + ' » → ' + p + ' passed, ' + e + ' failed');
}

console.log('total de la suite BIII\n');
console.log(parFormat.join('\n'));
console.log('\n  TOTAL : ' + passed + ' passed, ' + failed + ' failed'
  + '  (' + lignes + ' bilans lus / ' + attendus.length + ' fichiers lances)');

if (lignes === 0) {
  console.error('\n✗ AUCUN BILAN RECONNU. Ce n\'est pas « zero test »: c\'est un compteur qui n\'a rien su lire.\n'
    + '  Soit `npm test` n\'a pas tourne, soit les formats de bilan ont tous change. Regarder la sortie\n'
    + '  brute avant de croire un total — un succes vide est un echec.');
  process.exit(2);
}
if (attendus.length === 0) {
  console.error('\n✗ Le script `test` de package.json ne ressemble a rien de connu: impossible d\'en tirer\n'
    + '  combien de fichiers sont lances, donc impossible de savoir si le total ci-dessus est complet.');
  process.exit(2);
}
if (lignes !== attendus.length) {
  const manquants = Math.abs(attendus.length - lignes);
  console.error('\n✗ ' + lignes + ' bilans lus pour ' + attendus.length + ' fichiers lances — ' + manquants
    + ' de decalage.\n'
    + '  Un fichier imprime son bilan dans un format que ce compteur ne connait pas, et ses tests sont\n'
    + '  donc ABSENTS du total ci-dessus. C\'est exactement la faute du 2026-07-27 (13 suites ignorees,\n'
    + '  101 tests, un total presente comme complet). Ajouter le format a la liste BILANS — ne pas\n'
    + '  publier ce chiffre en attendant.');
  process.exit(1);
}
if (failed > 0) { console.error('\n✗ ' + failed + ' test(s) en echec'); process.exit(1); }
if (r.status !== 0) {
  console.error('\n✗ `npm test` est sorti en ' + r.status + ' alors que tous les bilans lus sont verts —\n'
    + '  donc quelque chose a casse EN DEHORS d\'un bilan (un fichier qui jette avant d\'imprimer, par ex.).');
  process.exit(1);
}
console.log('\n✓ suite verte');
