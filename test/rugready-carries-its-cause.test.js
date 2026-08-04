#!/usr/bin/env node
'use strict';
/**
 * Le verdict le plus grave du produit doit dire CE QUI l'a arme.
 *
 * Mesure du 2026-08-04 sur les 38 `rug_ready` de la base:
 *
 *     17  « proxy contract — the code you audited can be swapped »   armedAtFirstSight rempli
 *      8  honeypot simule, cooldown, mintable                        armedAtFirstSight rempli
 *     13  RIEN                                                       armedAtFirstSight VIDE
 *
 * Les treize orphelins sont les residus de la regle d'usurpation de symbole, retiree le 26/07 apres
 * avoir mesure −14 points sur sa contribution propre. Elle posait le verdict le plus grave SANS jamais
 * enregistrer de pouvoir arme — donc aujourd'hui, la seule facon de la reconnaitre est un champ VIDE.
 * Une regle morte se reconnait a une absence: c'est le contraire d'une trace.
 *
 * Les quatre sites vivants respectent tous l'invariant. Ce fichier ne repare donc rien — il EMPECHE
 * la recidive, ce qui est la seule chose qui restait a faire. Sans lui, la prochaine regle qui promeut
 * au sommet sans enregistrer sa cause produira treize nouveaux orphelins et personne ne le saura avant
 * de vouloir la noter.
 *
 * ⚠️ Reclamation de CLASSE, pas d'instance: on n'enumere pas les sites connus, on exige la propriete
 * de TOUS. C'est ce qui a trouve un cinquieme site que ma lecture avait rate ailleurs dans ce depot.
 * Les commentaires partent AVANT le scan — une regle qui matche un commentaire ne prouve rien.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const RACINE = path.join(__dirname, '..');
const FICHIERS = ['lib/rugsignals.js', 'hermes/economy/token-radar.js'];

/** Commentaires retires, numeros de ligne PRESERVES pour que le message d'erreur soit actionnable. */
function lignesSansCommentaires(rel) {
  const src = fs.readFileSync(path.join(RACINE, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ''));
}

/** Tout site qui ASSIGNE le verdict, hors annotation de type dans une JSDoc. */
const ASSIGNE = /verdict\s*[:=]\s*'rug_ready'/;
/** La cause doit etre nommee sur la meme ligne: soit on la pose, soit on est garde par elle. */
const CAUSE = /\barmed\b/;

function sites() {
  const out = [];
  for (const rel of FICHIERS) {
    const lignes = lignesSansCommentaires(rel);
    lignes.forEach((l, i) => { if (ASSIGNE.test(l)) out.push({ rel, no: i + 1, texte: l }); });
  }
  return out;
}

console.log('rug_ready: le verdict le plus grave porte sa cause');

t('★ tout site qui pose rug_ready nomme le pouvoir ARME sur la meme ligne', () => {
  const trouves = sites();
  /* Un garde qui n'a RIEN inspecte passe en vert. Quatre sites sont connus au 04/08; exiger au moins
   * trois laisse la place a une refactorisation legitime sans laisser passer une disparition totale. */
  assert.ok(trouves.length >= 3,
    'succes VIDE: seulement ' + trouves.length + ' site(s) inspecte(s). Soit les regles ont disparu, '
    + 'soit ce garde ne les reconnait plus.');
  const muets = trouves.filter((s) => !CAUSE.test(s.texte));
  assert.deepStrictEqual(muets.map((s) => s.rel + ':' + s.no), [],
    'un rug_ready sans pouvoir arme enregistre = un verdict qu\'on ne pourra plus noter par regle. '
    + 'C\'est ce qui a produit les 13 orphelins de la regle d\'usurpation de symbole.');
});

t('★ le garde mord vraiment — verifie sur le defaut reinjecte', () => {
  /* Sans ce cas, « aucune violation » et « detecteur casse » rendent le meme vert. On rejoue la faute
   * historique telle qu'elle etait ecrite: le verdict pose seul, sans cause. */
  const faute = "      if (m.status === 'impersonation') { v.verdict = 'rug_ready'; }";
  assert.ok(ASSIGNE.test(faute), 'le detecteur doit voir l assignation');
  assert.ok(!CAUSE.test(faute), 'et constater qu aucune cause n est nommee');

  // Le cas OPPOSE, sinon le detecteur pourrait simplement tout refuser.
  const correct = "  if (armed.length) verdict = 'rug_ready';";
  assert.ok(ASSIGNE.test(correct) && CAUSE.test(correct), 'une ligne conforme ne doit PAS etre accusee');
});

t('les commentaires ne comptent pas comme du code', () => {
  /* La JSDoc de rugsignals.js enumere les verdicts (« verdict: 'rug_ready' | 'high_risk' | ... ») et
   * matcherait l'assignation sans ce retrait — le garde accuserait une ligne de documentation. */
  const lignes = lignesSansCommentaires('lib/rugsignals.js');
  const doc = lignes.findIndex((l) => /'rug_ready'\s*\|\s*'high_risk'/.test(l));
  assert.strictEqual(doc, -1, 'une enumeration en commentaire ne doit plus etre visible apres nettoyage');
});

t('la base porte encore les orphelins, et le compte se dit', () => {
  /* On ne REECRIT pas l'historique: ces verdicts ont ete rendus, ils restent au registre. Mais le
   * compte doit rester visible, sinon une regle morte redevient un mystere dans six semaines. */
  const DB = path.join(RACINE, 'data', 'token-radar', 'tokens.json');
  if (!fs.existsSync(DB)) { console.log('       (base absente — cas ignore, et c est dit)'); return; }
  const rows = Object.values(JSON.parse(fs.readFileSync(DB, 'utf8')));
  const rr = rows.filter((t2) => t2.firstVerdict === 'rug_ready');
  const orphelins = rr.filter((t2) => !Array.isArray(t2.armedAtFirstSight) || !t2.armedAtFirstSight.length);
  assert.ok(rr.length > 0, 'un tier vide rendrait ce test creux');
  // Assertion de NON-REGRESSION: le nombre d'orphelins ne doit pas AUGMENTER. Il vaut 13 au 04/08.
  assert.ok(orphelins.length <= 13,
    orphelins.length + ' rug_ready sans cause enregistree (13 au 2026-08-04). Une NOUVELLE regle pose '
    + 'le verdict le plus grave sans dire pourquoi.');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
