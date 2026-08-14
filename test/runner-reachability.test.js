#!/usr/bin/env node
'use strict';
/**
 * Ce que la flotte LANCE vraiment — et ce qui a seulement l'air d'etre lance.
 * ==========================================================================
 * `hermes/economy/agents.json` est la liste faisant autorite: `check-runners.sh` l'utilise pour
 * verifier que chaque agent ACTIVE a son runner installe dans `$HERMES_HOME/scripts`. Son propre
 * en-tete dit pourquoi elle existe — « a job can be scheduled, visible, and dead ». Ce fichier pose
 * la question d'a cote: parmi ce que le depot CONTIENT, qu'est-ce qui est vraiment sur ce chemin ?
 *
 * ⛔ 1. UN RUNNER CORROMPU PORTANT LE NOM D'UN RUNNER PLANIFIE. `biii-scan.sh` existe DEUX fois:
 * `hermes/agents/biii-monitor/biii-scan.sh` (le vrai, avec sa notice d'installation) et
 * `./biii-scan.sh` a la racine. Mesure du 2026-08-15 sur celui de la racine:
 *     premiers octets  357 273 277  → BOM UTF-8 AVANT le `#!`
 *     lignes reelles   1            → les `\n` sont des litteraux, pas des fins de ligne
 *     execution        exit 127     → « ﻿#!/bin/bashn#: No such file or directory »
 * ⚠️ Et je m'etais trompe en le lisant: j'attendais un exit 0, en me disant qu'un fichier entierement
 * commente ne fait rien et reussit. Le BOM l'empeche: `#` n'ouvre plus un commentaire quand il n'est
 * pas en debut de mot, donc bash TENTE d'executer la ligne. Il echoue fort, pas en silence — mais il
 * porte le nom exact du runner que l'agent `biii-watch` fait tourner toutes les 30 minutes, et la
 * notice d'installation du vrai dit « cp this to ~/.hermes-biii/scripts/biii-scan.sh ». Copier le
 * mauvais est une erreur d'un seul caractere de chemin.
 *
 * ⛔ 2. CE QUI N'EST SUR AUCUN CHEMIN PLANIFIE. Mesure du meme jour: l'agent `biii-watch` lance
 * `biii-scan.sh` → `node scan.js watchlist.json`. `scan.js` (100 lignes) est donc le scanner vivant,
 * et il EST teste. Le reste du dossier ne l'est pas: ~1900 lignes que rien dans `agents.json`
 * n'atteint, dont `launchers-integration-v3.js` — la SEULE version qui connaisse B20, notre propre
 * standard (v2 n'en parle que dans un commentaire; un `grep -c` comptait cette chaine et non une
 * capacite). Et `cron-biii-monitor.sh`, reecrit avec soin le 2026-07-27 apres trois cassures
 * documentees, n'apparait pas non plus dans `agents.json`.
 *
 * ⚖️ BORNE, et elle compte: `agents.json` est la liste que `check-runners.sh` valide. Si Hermes porte
 * d'autres entrees de cron EN DEHORS de cette liste, elles ne sont pas lisibles depuis le depot. Ce
 * fichier ne dit donc pas « ce code ne tourne jamais »: il dit « rien dans le depot ne l'atteint », ce
 * qui est deja la question que personne ne posait.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { choisirFormeSyntaxe, verifierSyntaxe } = require('./bash-runner');

/**
 * ⚠️ 2026-08-14: les deux cas de controle de syntaxe de ce fichier appelaient `bash -n` avec un chemin
 * WINDOWS. Sur la machine qui lance la passe de nuit, `bash` resout vers WSL, qui n'adresse pas `D:\...`:
 * les deux scripts du dossier ressortaient 127 et etaient publies « script(s) shell invalide(s) » sans
 * avoir jamais ete ouverts. En forme `/mnt/d/...` ils sortent tous les deux en 0 — ils etaient VALIDES.
 * Le savoir vit maintenant dans `./bash-runner`, ecrit pour ce meme defaut cinq jours plus tot dans
 * `note-refusal.test.js` et que ce fichier n'avait pas appele.
 */
const { forme: FORME_BASH, echecs: ECHECS_BASH } = choisirFormeSyntaxe();

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('runner reachability — ce que la flotte lance vraiment:');

const RACINE = path.join(__dirname, '..');
const MONITEUR_SH = path.join(RACINE, 'hermes', 'agents', 'biii-monitor');
const AGENTS = require(path.join(RACINE, 'hermes', 'economy', 'agents.json')).agents;

/* Tous les fichiers du depot portant le nom d'un runner planifie. */
function trouver(nom, dir = RACINE, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (/^(node_modules|\.git|\.claude|data|dist)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) trouver(nom, p, out);
    else if (e.name === nom) out.push(p);
  }
  return out;
}

const runners = [...new Set(AGENTS.filter((a) => a.enabled)
  .flatMap((a) => [a.script, a.dataScript]).filter(Boolean))];

t('la liste des agents est lue et des runners sont declares', () => {
  /* Temoin: une liste vide ferait passer tout le reste sans rien verifier. */
  assert.ok(AGENTS.length >= 5, 'succes vide: ' + AGENTS.length + ' agent(s)');
  assert.ok(runners.length >= 5, 'succes vide: ' + runners.length + ' runner(s) actif(s)');
  assert.ok(runners.includes('biii-scan.sh'), 'temoin: le runner du scanner doit etre declare');
});

/* Fichiers portant un nom de runner planifie et qui ne peuvent PAS s executer. Liste explicite:
 * chaque ligne se justifie, et une entree EN PLUS fait rougir tout de suite.
 * ⛔ Non repare volontairement: ce fichier n'est reference par RIEN (toutes les mentions du depot
 * pointent hermes/agents/biii-monitor/biii-scan.sh, et INSTALL-hermes-agent.md donne le chemin
 * complet a copier). Le reparer reviendrait a RESSUSCITER un outil dont je deduirais l'intention
 * d'un commentaire d'une ligne — creer un vivant plutot que retirer un mort. Le retirer est un geste
 * d'operateur, pas le mien. */
const ORPHELINS_CORROMPUS = new Map([
  ['biii-scan.sh', 'la copie a la RACINE du depot: BOM UTF-8 avant le shebang + des \\n litteraux, une'
    + ' seule ligne, exit 127. Referencee par rien; le vrai runner est dans hermes/agents/biii-monitor/.'],
]);

t('★ tout fichier portant le nom d un runner planifie doit pouvoir s executer', () => {
  const casses = [];
  for (const nom of runners) {
    for (const f of trouver(nom)) {
      const octets = fs.readFileSync(f);
      /* Un BOM avant le shebang: le noyau ne voit plus `#!`, et bash n'ouvre plus de commentaire. */
      if (octets[0] === 0xEF && octets[1] === 0xBB && octets[2] === 0xBF) {
        casses.push(path.relative(RACINE, f) + ': BOM UTF-8 avant le shebang');
        continue;
      }
      const txt = octets.toString('utf8');
      if (!txt.startsWith('#!')) { casses.push(path.relative(RACINE, f) + ': pas de shebang en tete'); continue; }
      /* Des `\n` litteraux: tout le script tient sur une ligne et ne fait pas ce qu'il montre. */
      if (!txt.includes('\n') && txt.includes('\\n')) {
        casses.push(path.relative(RACINE, f) + ': des \\n LITTERAUX au lieu de fins de ligne');
      }
    }
  }
  /* On compare l ENSEMBLE des noms casses a la liste justifiee: un nouveau piege rougit aussitot,
   * et un piege disparu oblige a retirer sa ligne. */
  const nomsCasses = [...new Set(casses.map((c) => path.basename(c.split(':')[0])))].sort();
  assert.deepEqual(nomsCasses, [...ORPHELINS_CORROMPUS.keys()].sort(),
    'fichier(s) portant un nom de runner planifie et incapables de s executer:\n  ' + casses.join('\n  ')
    + '\n  Le vrai runner dit « cp this to ~/.hermes-biii/scripts/ »: copier le mauvais est une erreur'
    + ' d un seul caractere de chemin. Soit il est repare, soit sa raison est ecrite ci-dessus.');
});

t('le VRAI runner, lui, s execute — sinon la liste ci-dessus excuserait tout', () => {
  /* Cas oppose: sans ce temoin, un depot ou TOUS les runners seraient casses passerait aussi. */
  const vrai = path.join(MONITEUR_SH, 'biii-scan.sh');
  const octets = fs.readFileSync(vrai);
  assert.notStrictEqual(octets[0], 0xEF, 'aucun BOM devant le shebang du vrai runner');
  assert.ok(octets.toString('utf8').startsWith('#!'), 'shebang en tete');
  assert.ok(octets.toString('utf8').split('\n').length > 3, 'un vrai script, pas une ligne');
  const vu = verifierSyntaxe(FORME_BASH, vrai);
  /* Les trois etats ne se valent pas et ne partagent pas la meme phrase: « invalide » accuse le
   * script, « illisible » n'accuse que notre propre capacite a le lire. Les confondre est exactement
   * ce qui a rendu ce cas rouge en affirmant une chose fausse sur un fichier sain. */
  assert.notStrictEqual(vu.etat, 'invalide', 'le vrai runner ne passe pas `bash -n`: ' + vu.detail);
  assert.strictEqual(vu.etat, 'valide',
    'PAS MESURE — le vrai runner n a pas pu etre lu par bash, ce qui ne dit RIEN sur lui: ' + vu.detail
    + '\n  formes essayees: ' + (ECHECS_BASH.join(' | ') || 'aucune'));
});

t('chaque runner planifie existe au moins une fois dans le depot', () => {
  const absents = runners.filter((n) => trouver(n).length === 0);
  assert.deepEqual(absents, [],
    'runner(s) declare(s) dans agents.json et introuvable(s) ici: ' + JSON.stringify(absents));
});

/* ── Recensement du dossier du moniteur: atteignable, ou justifie ────────────────────────────── */
const MONITEUR = path.join(RACINE, 'hermes', 'agents', 'biii-monitor');
const ATTEINT = new Set([
  'scan.js',            // biii-scan.sh → node scan.js   (agent `biii-watch`, ACTIF)
  'readonly-guard.js',  // hook pre_tool_call de Hermes, installe dans $HERMES_HOME/hooks
]);
/* Chaque ligne se justifie. Une entree EN MOINS = quelque chose est devenu atteignable, tant mieux:
 * retirer sa ligne. Une entree EN PLUS = du code neuf que rien n'atteint, et il faut le dire tout de
 * suite plutot que de le decouvrir dans six mois. */
const HORS_CHEMIN = new Map([
  ['deep-scan.js', 'lance par cron-biii-monitor.sh, qui n apparait pas dans agents.json'],
  ['deep-scan-v2.js', 'aucun fichier ni script ne le lance — seule porte vers launchers-integration-v3'],
  ['biii-realtime-monitor.js', 'aucun script ne le lance — seule porte vers launchers-integration-v2'],
  ['launchers-integration-v2.js', 'requis seulement par biii-realtime-monitor.js; pas de support B20'],
  ['launchers-integration-v3.js', 'requis seulement par deep-scan-v2.js et une probe; SEULE version qui connait B20'],
  ['build-watchlist.js', 'outil manuel: reconstruit watchlist.json, pas un agent planifie'],
]);

t('★ le dossier du moniteur est recense: atteignable, ou justifie ligne par ligne', () => {
  const fichiers = fs.readdirSync(MONITEUR).filter((f) => f.endsWith('.js')).sort();
  assert.ok(fichiers.length >= 5, 'succes vide: ' + fichiers.length + ' fichier(s) lu(s)');
  const inconnus = fichiers.filter((f) => !ATTEINT.has(f) && !HORS_CHEMIN.has(f));
  assert.deepEqual(inconnus, [],
    'fichier(s) ni declare(s) atteignable(s) ni justifie(s): ' + JSON.stringify(inconnus)
    + '\n  Soit il est sur un chemin planifie (l ajouter a ATTEINT), soit il ne l est pas et sa raison'
    + ' doit etre ecrite — du code que rien n atteint se decouvre autrement six mois plus tard.');
  const excusesMortes = [...HORS_CHEMIN.keys()].filter((f) => !fichiers.includes(f));
  assert.deepEqual(excusesMortes, [], 'justification(s) pour un fichier disparu: ' + JSON.stringify(excusesMortes));
});

t('le scanner VIVANT est bien celui que le runner appelle', () => {
  /* Cas oppose: sans lui, un recensement ou TOUT serait « hors chemin » passerait aussi. */
  const sh = fs.readFileSync(path.join(MONITEUR, 'biii-scan.sh'), 'utf8');
  assert.match(sh, /node .*scan\.js/, 'biii-scan.sh doit lancer scan.js');
  assert.doesNotMatch(sh, /deep-scan/, 'et non le deep-scan, qui vit sur un autre cron');
  assert.ok(fs.existsSync(path.join(MONITEUR, 'scan.js')));
});

t('les scripts shell du dossier passent le controle de syntaxe', () => {
  const sh = fs.readdirSync(MONITEUR).filter((f) => f.endsWith('.sh'));
  assert.ok(sh.length >= 1, 'succes vide: aucun script shell lu');
  const casses = [];
  const illisibles = [];
  for (const f of sh) {
    const vu = verifierSyntaxe(FORME_BASH, path.join(MONITEUR, f));
    if (vu.etat === 'invalide') casses.push(f + ': ' + vu.detail);
    else if (vu.etat === 'illisible') illisibles.push(f + ': ' + vu.detail);
  }
  /* ORDRE DELIBERE: on annonce d'abord ce qu'on n'a PAS PU LIRE. Un fichier illisible compte comme
   * non controle, donc `casses` vide ne prouve rien tant qu'il en reste — sans cette ligne, un bash
   * hors d'etat rendrait « aucun script invalide », c'est-a-dire un vert bati sur zero lecture. */
  assert.deepStrictEqual(illisibles, [],
    'PAS MESURE — script(s) que bash n a pas pu ouvrir ici. Ceci n est PAS un verdict sur eux:\n  '
    + illisibles.join('\n  ') + '\n  formes essayees: ' + (ECHECS_BASH.join(' | ') || 'aucune'));
  assert.deepStrictEqual(casses, [], 'script(s) shell invalide(s):\n  ' + casses.join('\n  '));
  /* Temoin de non-vacuite: `sh.length >= 1` plus haut borne la liste lue, celui-ci borne ce qui a
   * ete effectivement CONTROLE — les deux ne coincident que si aucun fichier n a ete saute. */
  assert.strictEqual(casses.length + illisibles.length, 0);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
