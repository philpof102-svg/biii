#!/usr/bin/env node
'use strict';
/**
 * judgeRun — la POSITION rendue est-elle celle de la phrase, ou celle du run qui la contient ?
 *
 * Ce module ne publie jamais la phrase: c'est sa regle de conception. La position est donc sa SEULE sortie,
 * et une position fausse rend faux le seul livrable. Mesure du 2026-08-14 sur le vecteur BIP-39 tout-a-zero,
 * en liste verticale numerotee (le format que le module dit lui-meme etre le plus courant):
 *
 *   3 mots parasites avant   phrase lignes 4-15   -> rendait « words: 12, spanning lines 1-15 »
 *   20 mots de liste apres   phrase lignes 1-12   -> rendait « words: 12, spanning lines 1-32 »
 *   DEUX phrases collees     phrases 1-12 ET 13-24 -> rendait UN SEUL constat « words: 12, lines 1-24 »
 *
 * Les deux premiers designaient des lignes qui ne portent pas la phrase. Le troisieme est le vrai defaut:
 * seule la PREMIERE fenetre valide d'un run est rendue, et l'intervalle gonfle RECOUVRAIT la seconde phrase.
 * L'omission etait donc invisible — « words: 12 » a cote d'un intervalle de 24 lignes est la contradiction
 * interne qui la trahissait, et personne ne la lisait.
 *
 * Les DEUX bornes sont epinglees ici. Retrecir l'intervalle en silence aurait echange un angle mort contre un
 * autre: le lecteur ne saurait plus qu'un run plus large entoure la phrase, la ou une seconde peut se tenir.
 * Donc le cas rassurant (phrase seule) doit rester SANS mise en garde, et le cas large doit en porter une —
 * sinon un module qui avertit toujours passerait ce fichier.
 *
 * Toutes les phrases sont le vecteur tout-a-zero publie dans le standard. Il ne tient rien et n'a jamais rien
 * tenu; utiliser autre chose serait l'erreur exacte que ce module existe pour trouver.
 */
const assert = require('node:assert');
const { loadWordlist, checksumValid, scanText, judgeRun } = require('../lib/seedscan');

const index = loadWordlist();

/* `lances` compte les cas REELLEMENT executes: sans lui, `failed === 0` rend le meme message que la boucle
 * ait tourne ou non, et le fichier ne distingue plus « verifie » de « jamais atteint ». */
let failed = 0, lances = 0;
const check = (label, got, want) => {
  lances++;
  let ok;
  try { assert.deepStrictEqual(got, want); ok = true; } catch { ok = false; }
  if (!ok) {
    failed++;
    process.stdout.write(`  FAIL ${label}\n    attendu ${JSON.stringify(want)}\n    obtenu  ${JSON.stringify(got)}\n`);
  } else process.stdout.write(`  ok   ${label}\n`);
};

const PHRASE = ('abandon '.repeat(11) + 'about').split(' ');
/* Le vecteur DOIT valider, sinon tout ce fichier mesurerait la mauvaise branche et sortirait vert. */
check('le vecteur de test a bien un checksum valide', checksumValid(PHRASE, index), true);

/** Liste verticale numerotee: un mot par ligne, donc ligne N = mot N. */
const numbered = (words) => words.map((w, i) => (i + 1) + '. ' + w).join('\n');
const STRAY = ['zoo', 'zebra', 'young'];          // 3 mots de la liste, en-deca de OFFSET_SLACK
const TAIL = Array(20).fill('zoo');
const CAVEAT = /Only the FIRST valid window in a run is reported/;

// ── 1. Phrase seule: la borne rassurante. Position exacte, et AUCUNE mise en garde. ──────────────────
const seule = scanText(numbered(PHRASE), index);
check('phrase seule — un seul constat', seule.length, 1);
check('phrase seule — verdict confirmed', seule[0].verdict, 'confirmed');
check('phrase seule — commence ligne 1', seule[0].line, 1);
check('phrase seule — finit ligne 12', seule[0].endLine, 12);
check('phrase seule — le run ne depasse pas la phrase', seule[0].runWords, 12);
check('phrase seule — pas de mise en garde', CAVEAT.test(seule[0].note), false);

// ── 2. Mots parasites AVANT: le cas pour lequel OFFSET_SLACK existe. La phrase commence ligne 4. ─────
const avant = scanText(numbered(STRAY.concat(PHRASE)), index);
check('parasites avant — un seul constat', avant.length, 1);
check('parasites avant — la phrase commence ligne 4, pas ligne 1', avant[0].line, 4);
check('parasites avant — et finit ligne 15', avant[0].endLine, 15);
check('parasites avant — le run, lui, commence ligne 1', avant[0].runLine, 1);
check('parasites avant — run de 15 mots', avant[0].runWords, 15);
check('parasites avant — mise en garde presente', CAVEAT.test(avant[0].note), true);

// ── 3. Mots de la liste APRES: la phrase finit ligne 12, le run ligne 32. ────────────────────────────
const apres = scanText(numbered(PHRASE.concat(TAIL)), index);
check('queue apres — la phrase finit ligne 12, pas 32', apres[0].endLine, 12);
check('queue apres — le run finit bien ligne 32', apres[0].runEndLine, 32);
check('queue apres — mise en garde presente', CAVEAT.test(apres[0].note), true);

// ── 4. Les deux a la fois. ───────────────────────────────────────────────────────────────────────────
const deuxCotes = scanText(numbered(STRAY.concat(PHRASE).concat(TAIL)), index);
check('des deux cotes — phrase lignes 4-15',
  [deuxCotes[0].line, deuxCotes[0].endLine], [4, 15]);
check('des deux cotes — run lignes 1-35',
  [deuxCotes[0].runLine, deuxCotes[0].runEndLine], [1, 35]);

/* ⚠️ LA PROPRIETE, PAS LE LITTERAL: une phrase de 12 mots en liste verticale occupe EXACTEMENT 12 lignes.
 * Epingler « 1-15 » aurait protege la constante; ceci interdit la forme fautive elle-meme, quel que soit
 * l'endroit ou la phrase se trouve. C'est ce qui rougissait avant le correctif, sur trois cas sur quatre. */
for (const [nom, f] of [['seule', seule[0]], ['avant', avant[0]], ['apres', apres[0]], ['deux', deuxCotes[0]]]) {
  check('l\'intervalle rendu couvre 12 lignes pour 12 mots — cas ' + nom, f.endLine - f.line + 1, f.words);
}

/* Les deux bornes doivent DIFFERER, sinon « avertir toujours » passerait ce fichier. */
check('le cas rassurant et le cas large ne portent pas la meme note',
  CAVEAT.test(seule[0].note) !== CAVEAT.test(avant[0].note), true);

// ── 5. DEUX phrases dans UN SEUL run: l'omission doit se DIRE. ───────────────────────────────────────
const collees = scanText(numbered(PHRASE.concat(PHRASE)), index);
/* Les 24 mots ne valident pas comme phrase de 24 — sans quoi ce cas testerait autre chose que prevu. */
check('les 24 mots colles ne sont pas une phrase de 24', checksumValid(PHRASE.concat(PHRASE), index), false);
check('deux phrases collees — un seul constat est rendu', collees.length, 1);
check('deux phrases collees — il porte la PREMIERE, lignes 1-12',
  [collees[0].line, collees[0].endLine], [1, 12]);
check('deux phrases collees — le run de 24 est divulgue', collees[0].runWords, 24);
check('deux phrases collees — et l\'omission de la seconde est DITE', CAVEAT.test(collees[0].note), true);

// ── 6. Separees par un mot hors-liste: deux runs, donc deux constats. Le temoin oppose du cas 5. ─────
const separees = scanText(numbered(PHRASE) + '\n13. xylophone\n'
  + PHRASE.map((w, i) => (i + 14) + '. ' + w).join('\n'), index);
check('separees — deux constats distincts', separees.length, 2);
check('separees — le second commence ligne 14', separees[1].line, 14);
check('separees — aucune mise en garde des deux cotes',
  [CAVEAT.test(separees[0].note), CAVEAT.test(separees[1].note)], [false, false]);

// ── 7. La branche sans checksum: la position du run y est la bonne reponse, elle ne bouge pas. ───────
const sansSomme = scanText(numbered(Array(14).fill('zoo')), index);
check('run sans checksum — verdict wordlist_run', sansSomme[0].verdict, 'wordlist_run');
check('run sans checksum — couvre tout le run, lignes 1-14',
  [sansSomme[0].line, sansSomme[0].endLine], [1, 14]);
check('run sans checksum — words vaut la longueur du run', sansSomme[0].words, 14);

// ── 8. Un run vide n'a pas de position: il se refuse, il ne jette pas un TypeError anonyme. ──────────
for (const [nom, entree] of [['tableau vide', []], ['null', null], ['non-tableau', 'abandon']]) {
  let msg = null;
  try { judgeRun(entree, index); } catch (e) { msg = e.message; }
  check('judgeRun refuse ' + nom + ' en disant pourquoi',
    msg !== null && /non-empty run/.test(msg), true);
}

/* Un fichier de garde qui n'examine rien sort vert. On exige donc un plancher de cas executes. */
if (lances < 30) { failed++; process.stdout.write(`  FAIL seuls ${lances} cas ont tourne, minimum 30\n`); }

process.stdout.write(`\n${lances - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
