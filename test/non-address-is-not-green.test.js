'use strict';
/**
 * non-address-is-not-green.test.js — une entree que le crible NE PEUT PAS juger ne ressort pas VERTE.
 * ================================================================================================
 * ⛔ LE JUMEAU MANQUANT. `test/two-lens.test.js` (2026-08) a corrige exactement ce defaut sur le
 * handler MCP `till_trust`: une chaine qui n'est pas une adresse y est REFUSEE, sans triangle, et son
 * commentaire dit pourquoi — « un lecteur y lit "liste a jour, pas bloque" quand rien n'a ete crible ».
 *
 * 🚨 Le correctif n'a jamais atteint `vetLocal`/`localClassify`, qui servent `GET /trust`, `/vet` et
 * `/x402/vet-address`. Mesure du 2026-08-11, AVANT ce test:
 *
 *     entree              screen.reason          classifier.decision   allowed   color
 *     0x11...11 (TEMOIN)  not on the local...    PROCEED_LOW_VALUE     true      green
 *     alice.base.eth      not a 0x address       PROCEED_LOW_VALUE     true      green
 *     pas-une-adresse     not a 0x address       PROCEED_LOW_VALUE     true      green
 *     '' (VIDE)           not a 0x address       PROCEED_LOW_VALUE     true      green
 *
 * ⇒ Une chaine VIDE rendait le MEME verdict qu'une adresse propre. Le crible DIT correctement qu'il
 * n'a pas pu lire (`available:false`, cf. lib/screen.js:47 « fail-closed: never clean »), mais
 * `localClassify` passait `meta.available` — « la LISTE est-elle chargee » — au lieu de
 * `scr.available` — « le crible a-t-il abouti sur CETTE entree ». Le module divulgue, l'appelant
 * ignore la divulgation POUR LA DECISION.
 *
 * ⚠️ POURQUOI CA COMPTE PLUS ICI QUE SUR `till_trust`: `GET /trust` est la surface CORS-ouverte que
 * « n'importe quelle app web embarque » (README), et Base MCP (2026-08-11) manipule nativement des
 * BASENAMES — `alice.base.eth` est une entree qu'un agent produira sans y penser.
 *
 * ⛔ BORNE: ce test ne juge PAS ce que doit rendre une entree invalide (erreur ? verdict retenu ?) —
 * c'est une semantique produit. Il exige seulement que ce ne soit pas un FEU VERT.
 */
const assert = require('node:assert/strict');
const { vetLocal, localClassify, loadFloor } = require('../lib/vet');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n         ' + (e && e.message)); } };

console.log('une entree que le crible ne peut pas juger n est pas VERTE:');

const floor = loadFloor();
const ADRESSE = '0x' + '11'.repeat(20);
const NON_ADRESSES = ['alice.base.eth', 'vitalik.eth', 'pas-une-adresse', '', '0x1234', '0x' + 'g'.repeat(40)];

/* ⛔ LE TEMOIN D'ABORD. Sans lui, tout casser passerait pour un correctif — c'est la lecon du meme
 * fichier jumeau (« Sanity: le refus n'avale pas les entrees valides »). */
t('★ TEMOIN — une adresse VALIDE reste jugee, et le crible a bien tourne', () => {
  const r = vetLocal(ADRESSE, { knownBad: floor });
  assert.equal(r.screen.blocked, false, 'cette adresse temoin ne doit pas etre known-bad');
  assert.ok(r.classifier, 'trust-core doit etre cable, sinon ce test est aveugle');
  assert.equal(r.classifier.allowed, true, 'une adresse propre reste permise — le correctif ne doit rien avaler');
});

t('★ le crible DIT qu il n a pas pu lire, sur chaque non-adresse', () => {
  for (const v of NON_ADRESSES) {
    const r = vetLocal(v, { knownBad: floor });
    assert.equal(r.screen.reason, 'not a 0x address',
      JSON.stringify(v) + ' : le crible doit nommer son incapacite');
  }
});

t('★ et le VERDICT ne contredit pas le crible — aucune non-adresse ne ressort permise', () => {
  for (const v of NON_ADRESSES) {
    const r = vetLocal(v, { knownBad: floor });
    if (!r.classifier) continue;                 // trust-core absent: le temoin ci-dessus l aurait dit
    assert.notEqual(r.classifier.allowed, true,
      JSON.stringify(v) + ' ressort allowed:true — le crible n a RIEN lu et le verdict dit oui');
  }
});

t('★ ni verte: une couleur rassurante sur une entree non lue se lit comme un feu vert', () => {
  for (const v of NON_ADRESSES) {
    const r = vetLocal(v, { knownBad: floor });
    if (!r.classifier) continue;
    assert.notEqual(r.classifier.color, 'green',
      JSON.stringify(v) + ' ressort en vert alors que rien n a ete crible');
  }
});

/* Le meme defaut par la porte de derriere: `localClassify` est exporte et appele directement. */
t('★ JUMEAU — `localClassify` appele DIRECTEMENT refuse aussi de verdir une non-adresse', () => {
  const bon = localClassify(ADRESSE, { knownBad: floor });
  assert.ok(bon, 'temoin: trust-core cable');
  assert.equal(bon.allowed, true, 'temoin: une adresse propre reste permise');
  for (const v of NON_ADRESSES) {
    const c = localClassify(v, { knownBad: floor });
    if (!c) continue;
    assert.notEqual(c.allowed, true, JSON.stringify(v) + ' : allowed:true depuis localClassify direct');
  }
});

/* ⚠️ CE QUE LE CORRECTIF PRODUIT, NOMME PLUTOT QUE CELEBRE — et ce qui reste a trancher.
 * Avec `deny.available:false`, trust-core rend `BLOCK / allowed:false / red`. C'est FAIL-CLOSED, donc
 * sur — et c'est deja son comportement quand le plancher n'est pas chargé, pas une invention d'ici.
 * ⛔ MAIS `BLOCK` AFFIRME « cette adresse est mauvaise » alors que la verite est « je n'ai pas pu
 * lire ». C'est le motif « ne jamais accuser sur sa propre incompletude », qui a deja recidive trois
 * fois dans ce depot: garder le REFUS, retirer l'AFFIRMATION.
 * ⇒ Choisir entre `BLOCK` et un `UNKNOWN`/refus explicite est une SEMANTIQUE PRODUIT. Ce cas fige
 * l'etat mesuré pour que le choix soit fait en le voyant, jamais par defaut. */
t('★ le refus est fail-closed — et on NOMME qu il accuse au lieu de dire « pas lu »', () => {
  const c = localClassify('alice.base.eth', { knownBad: floor });
  if (!c) return;
  assert.equal(c.allowed, false, 'le refus doit tenir');
  assert.equal(c.decision, 'BLOCK',
    'si ce verdict change (UNKNOWN, refus explicite...), c est une DECISION PRODUIT: mettre a jour ce cas AVEC elle');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
