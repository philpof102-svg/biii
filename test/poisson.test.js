#!/usr/bin/env node
'use strict';
/**
 * Un intervalle de confiance se teste sur sa DEFINITION, pas sur des valeurs de table recopiees.
 *
 * La tentation est d'ecrire `assert(bornes[1] === 5.572)` pour k = 1 en piochant le nombre dans une
 * table. Ce test-la ne prouve rien de plus que ma memoire, et la regle de ce depot est qu'un nombre ne
 * se rappelle jamais, il se resout. Deux familles d'assertions le remplacent:
 *
 *   1. LES ANCRES ANALYTIQUES — celles qu'on derive a la main en trois lignes, donc verifiables sans
 *      table: pour k = 0 la borne haute resout e^-L = 0,025 donc L = -ln(0,025); pour k = 1 la borne
 *      basse resout 1 - e^-L = 0,025 donc L = -ln(0,975).
 *   2. LA PROPRIETE DEFINISSANTE — pour n'importe quel k, P(X >= k | basse) et P(X <= k | haute) valent
 *      exactement alpha/2. Si la bissection derive, cette assertion tombe, quelle que soit la valeur.
 *
 * ⚠️ Et les DEUX SENS sont testes: qu'un intervalle contienne k ne prouve rien (l'intervalle [0, +inf)
 * le fait aussi). Il faut aussi qu'un alpha plus large RETRECISSE l'intervalle — sinon `alpha` pourrait
 * n'etre lu par personne et la sortie serait constante.
 */
const assert = require('node:assert');
const { cdfPoisson, intervallePoisson, tauxAvecBornes } = require('../lib/poisson');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const proche = (a, b, eps, quoi) => assert.ok(Math.abs(a - b) < eps,
  quoi + ': attendu ' + b + ', obtenu ' + a + ' (ecart ' + Math.abs(a - b) + ' > ' + eps + ')');

console.log('poisson: un taux rare et ses deux bornes');

/* ── 1. LES ANCRES ANALYTIQUES ────────────────────────────────────────────────────────────────────── */

t('★ k=0: la borne haute resout e^-L = 0,025, soit -ln(0,025) — derivable a la main', () => {
  const [lo, hi] = intervallePoisson(0);
  assert.strictEqual(lo, 0, 'zero evenement n exclut aucun taux faible: la borne basse est exactement 0');
  proche(hi, -Math.log(0.025), 1e-9, 'borne haute k=0');
});

t('★ k=1: la borne basse resout 1 - e^-L = 0,025, soit -ln(0,975)', () => {
  const [lo] = intervallePoisson(1);
  proche(lo, -Math.log(0.975), 1e-9, 'borne basse k=1');
});

t('★ k=2: la borne basse resout e^-L (1+L) = 0,975 — verifiee par la CDF elle-meme', () => {
  const [lo] = intervallePoisson(2);
  proche(Math.exp(-lo) * (1 + lo), 0.975, 1e-9, 'P(X <= 1 | basse)');
});

/* ── 2. LA PROPRIETE DEFINISSANTE, sur toute une plage ────────────────────────────────────────────── */

t('★ pour tout k, P(X >= k | basse) = 2,5 % et P(X <= k | haute) = 2,5 %', () => {
  for (const k of [1, 2, 3, 5, 10, 25, 100]) {
    const [lo, hi] = intervallePoisson(k);
    proche(1 - cdfPoisson(k - 1, lo), 0.025, 1e-9, 'P(X >= ' + k + ' | basse)');
    proche(cdfPoisson(k, hi), 0.025, 1e-9, 'P(X <= ' + k + ' | haute)');
  }
});

t('l intervalle encadre k, et il est ORDONNE — une borne inversee passerait tout le reste', () => {
  for (const k of [0, 1, 2, 5, 20, 100]) {
    const [lo, hi] = intervallePoisson(k);
    assert.ok(lo < hi, 'k=' + k + ': basse ' + lo + ' doit etre < haute ' + hi);
    assert.ok(lo <= k && k <= hi, 'k=' + k + ' doit tomber dans [' + lo + ', ' + hi + ']');
  }
});

t('les deux bornes CROISSENT avec k — un intervalle fige se lirait comme une mesure', () => {
  let precLo = -1, precHi = -1;
  for (const k of [0, 1, 2, 5, 10, 50]) {
    const [lo, hi] = intervallePoisson(k);
    assert.ok(lo >= precLo, 'borne basse doit croitre: k=' + k + ' rend ' + lo + ' apres ' + precLo);
    assert.ok(hi > precHi, 'borne haute doit croitre: k=' + k + ' rend ' + hi + ' apres ' + precHi);
    precLo = lo; precHi = hi;
  }
});

/* ── 3. LE CAS OPPOSE: alpha est-il seulement LU ? ────────────────────────────────────────────────── */

t('★ un alpha plus large RETRECIT l intervalle — sinon alpha ne serait lu par personne', () => {
  const [lo95, hi95] = intervallePoisson(5, 0.05);
  const [lo50, hi50] = intervallePoisson(5, 0.50);
  assert.ok(lo50 > lo95, 'alpha 0,50 doit remonter la borne basse: ' + lo50 + ' vs ' + lo95);
  assert.ok(hi50 < hi95, 'alpha 0,50 doit descendre la borne haute: ' + hi50 + ' vs ' + hi95);
});

/* ── 4. LA CDF, dans les deux sens ────────────────────────────────────────────────────────────────── */

t('CDF(k, 0) = 1: a taux nul toute la masse est en zero', () => {
  for (const k of [0, 1, 7]) proche(cdfPoisson(k, 0), 1, 1e-12, 'CDF(' + k + ', 0)');
});

t('CDF DECROIT quand lambda monte, et CROIT quand k monte', () => {
  assert.ok(cdfPoisson(3, 1) > cdfPoisson(3, 5), 'lambda qui monte doit faire baisser P(X <= 3)');
  assert.ok(cdfPoisson(5, 3) > cdfPoisson(2, 3), 'k qui monte doit faire monter la CDF');
});

/* ── 5. LES ENTREES QUI N EN SONT PAS — trois etats, pas deux ─────────────────────────────────────── */

t('★ une entree invalide rend NaN, pas un intervalle rassurant', () => {
  for (const mauvais of [-1, 1.5, NaN, 'trois']) {
    const [lo, hi] = intervallePoisson(mauvais);
    assert.ok(Number.isNaN(lo) && Number.isNaN(hi), 'k=' + String(mauvais) + ' doit rendre [NaN, NaN]');
  }
});

t('★ une exposition nulle ne rend PAS un taux de zero: elle ne rend aucun taux', () => {
  for (const rien of [0, -3, NaN, null, undefined]) {
    const r = tauxAvecBornes(4, rien);
    assert.strictEqual(r.taux, null, 'exposition ' + String(rien) + ': `taux` doit etre null, pas 0');
    assert.strictEqual(r.basse, null);
    assert.strictEqual(r.haute, null);
    assert.ok(typeof r.raison === 'string' && r.raison.length > 0, 'le refus doit DIRE pourquoi');
  }
});

t('★ avec une exposition reelle, le taux et ses bornes sont l intervalle divise — et la raison est null', () => {
  const heures = 24.8;
  const r = tauxAvecBornes(1, heures);
  const [lo, hi] = intervallePoisson(1);
  assert.strictEqual(r.raison, null, 'un calcul reussi ne porte pas de raison de refus');
  proche(r.taux, 1 / heures, 1e-12, 'taux ponctuel');
  proche(r.basse, lo / heures, 1e-12, 'borne basse ramenee au taux');
  proche(r.haute, hi / heures, 1e-12, 'borne haute ramenee au taux');
  /* Le fait qui justifie tout ce module: sur UN evenement, l intervalle couvre plus de deux ordres de
   * grandeur. Publier le point seul serait une affirmation. */
  assert.ok(r.haute / r.basse > 100, 'sur k=1 le rapport haute/basse doit depasser 100, obtenu '
    + (r.haute / r.basse));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
