#!/usr/bin/env node
'use strict';
/**
 * Le badge de la console de flotte disait « clean » pour un run qu'elle n'avait PAS PU LIRE.
 * =========================================================================================
 * `hermes/fleet-console.js` affiche le journal des crons; `jrow` transforme `r.ok` en badge
 * « clean » ou « erreur ». Ce `ok` valait `!/error|traceback|failed|exception/i.test(body)` —
 * l'ABSENCE d'un mot-cle valait donc REUSSITE. Deux chemins arrivaient la avec un corps vide:
 *
 *   - `readJournal` faisait `let md = ''; try { md = fs.readFileSync(...) } catch {}` — un fichier
 *     de sortie ILLISIBLE devenait une chaine vide, aucun mot-cle ne matchait, et le run
 *     s'affichait « clean ». Un run dont on n'a pas pu lire la sortie etait presente comme propre.
 *   - une sortie reellement VIDE faisait pareil.
 *
 * C'est le motif que ce meme fichier combat quelques lignes plus bas — « L'EXECUTANT SE MESURE A CE
 * QU'IL A ECRIT, PAS A CE QUE L'ORDONNANCEUR PROMET » — non applique a son propre verdict.
 *
 * ⚖️ BORNES, ecrites dans le code et re-dites ici. `ok: true` reste « aucun echec signale », pas une
 * reussite prouvee: la preuve serait le CODE DE SORTIE, que l'ordonnanceur connait et que le fichier
 * .md ne porte pas — et `summarize` jette de toute facon le bloc d'en-tete. Le sens inverse existe
 * aussi: un corps disant « 0 errors » compte comme un echec, et ce test l'EPINGLE EN L'ETAT plutot
 * que de le corriger a coups de regex, ce qui remplacerait un faux positif par trois autres.
 * Zero reseau: on n'appelle que `summarize`, et le serveur ne demarre plus au require.
 */
const assert = require('node:assert');
const { summarize } = require('../hermes/fleet-console.js');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('fleet-console — le verdict affiche:');

const ENTETE = '# run\ndate: 2026-08-15\n\n---\n';

t('★ une sortie ILLISIBLE n est pas un run propre', () => {
  const s = summarize(null);
  assert.strictEqual(s.ok, null, 'null = « rien a juger », surtout pas true');
  assert.notStrictEqual(s.ok, true, 'le badge en tirerait « clean » pour un run jamais lu');
  assert.match(s.head, /illisible/, 'et la ligne de tete doit le dire');
});

t('★ une sortie VIDE n est pas un run propre', () => {
  for (const vide of ['', '   \n  \n', ENTETE]) {
    assert.strictEqual(summarize(vide).ok, null, 'aucun corps a juger: ' + JSON.stringify(vide.slice(0, 12)));
  }
});

t('TEMOIN: un vrai echec est toujours attrape', () => {
  /* Cas oppose: sans lui, une fonction qui rendrait TOUJOURS null passerait les deux tests ci-dessus. */
  for (const mot of ['Error: ENOENT', 'Traceback (most recent call last)', 'the job failed', 'Exception in thread']) {
    assert.strictEqual(summarize(ENTETE + mot + '\n').ok, false, 'doit rester un echec: ' + mot);
  }
});

t('TEMOIN: un run avec du contenu et sans signal reste « clean »', () => {
  /* L autre cas oppose: un correctif qui rendrait null PARTOUT rendrait la console inutile, et
   * quelqu un le retirerait — on perdrait aussi l alarme. */
  const s = summarize(ENTETE + '2700 tokens scannes, 3 nouveaux financeurs traces.\n');
  assert.strictEqual(s.ok, true);
  assert.match(s.head, /2700 tokens/);
});

t('les drapeaux sont comptes independamment du verdict', () => {
  const s = summarize(ENTETE + '🚩 adresse suspecte\n🆕 nouveau lanceur\n');
  assert.strictEqual(s.flags, 2, 'le badge affiche les flags AVANT le verdict, ils doivent etre justes');
});

t('BORNE EPINGLEE: « 0 errors » compte encore comme un echec', () => {
  /* Non corrige exprès. Si un jour ce test devient rouge, c est que quelqu un a chasse le faux
   * positif — et il faudra alors verifier qu il n en a pas cree trois autres. */
  assert.strictEqual(summarize(ENTETE + 'scan termine: 0 errors, 0 warnings\n').ok, false,
    'le mot suffit, le chiffre devant n est pas lu — limite connue et assumee du filtre par mot-cle');
});

t('le verdict a bien TROIS etats distincts, jamais deux', () => {
  const etats = new Set([
    summarize(null).ok,                                   // illisible
    summarize(ENTETE).ok,                                 // vide
    summarize(ENTETE + 'Error: x\n').ok,                  // echec
    summarize(ENTETE + 'tout va bien\n').ok,              // sans signal
  ]);
  assert.deepStrictEqual([...etats].sort((a, b) => String(a) < String(b) ? -1 : 1), [false, null, true],
    'null / false / true doivent tous les trois exister — c est ce qui separe « pas lu » de « propre »');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
