#!/usr/bin/env node
'use strict';
/**
 * Une proportion se teste sur sa DEFINITION et sur ce qu'elle REFUSE de dire.
 *
 * Comme pour `lib/poisson.js`, aucune valeur de table n'est recopiee: les ancres sont celles qu'on
 * derive a la main en deux lignes (n=1, k=0 -> haute = 0,975 parce que (1-p)^1 >= 0,025; n=10, k=0 ->
 * haute = 1 - 0,025^(1/10)), et le reste est la propriete definissante verifiee par la CDF elle-meme.
 *
 * ⚠️ ET LE CAS QUI COMPTE LE PLUS N'EST PAS NUMERIQUE. `proportionAvecBornes` doit calculer sur la
 * TAILLE EFFECTIVE quand les observations sont groupees, pas sur leur nombre. Un intervalle etroit
 * calcule sur des tirages correles est plus dangereux qu'aucun intervalle — c'est le motif exact
 * qui a produit « 3,2 % de rugs » sur 31 tokens portes par 2 financeurs.
 */
const assert = require('node:assert');
const { cdfBinomial, intervalleProportion, proportionAvecBornes } = require('../lib/binomial');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const proche = (a, b, eps, quoi) => assert.ok(Math.abs(a - b) < eps,
  quoi + ': attendu ' + b + ', obtenu ' + a + ' (ecart ' + Math.abs(a - b) + ' > ' + eps + ')');

console.log('binomial: une proportion, ses deux bornes, et le compte qui les rend honnetes');

/* ── LES ANCRES DERIVABLES A LA MAIN ──────────────────────────────────────────────────────────────── */

t('★ n=1 k=0: la borne haute resout (1-p) = 0,025, donc p = 0,975', () => {
  const [lo, hi] = intervalleProportion(0, 1);
  assert.strictEqual(lo, 0, 'zero succes n exclut aucune proportion faible: la borne basse est 0');
  proche(hi, 0.975, 1e-9, 'borne haute n=1 k=0');
});

t('★ n=1 k=1: la borne basse resout p = 0,025, et la haute vaut exactement 1', () => {
  const [lo, hi] = intervalleProportion(1, 1);
  proche(lo, 0.025, 1e-9, 'borne basse n=1 k=1');
  assert.strictEqual(hi, 1, 'un succes sur un n exclut pas la certitude');
});

t('★ n=10 k=0: la borne haute resout (1-p)^10 = 0,025, donc 1 - 0,025^(1/10)', () => {
  const [, hi] = intervalleProportion(0, 10);
  proche(hi, 1 - Math.pow(0.025, 1 / 10), 1e-9, 'borne haute n=10 k=0');
});

t('★ n=2 k=1: les deux bornes se resolvent en une ligne chacune', () => {
  const [lo, hi] = intervalleProportion(1, 2);
  proche(lo, 1 - Math.sqrt(0.975), 1e-9, 'basse: 1-(1-p)^2 = 0,025');
  proche(hi, Math.sqrt(0.975), 1e-9, 'haute: 1-p^2 = 0,025');
});

/* ── LA PROPRIETE DEFINISSANTE ────────────────────────────────────────────────────────────────────── */

t('★ pour tout (k,n) non degenere, P(X>=k|basse) = P(X<=k|haute) = 2,5 %', () => {
  for (const [k, n] of [[1, 2], [1, 31], [4, 7], [51, 54], [25, 100], [500, 1000]]) {
    const [lo, hi] = intervalleProportion(k, n);
    proche(1 - cdfBinomial(k - 1, n, lo), 0.025, 1e-8, 'P(X >= ' + k + ' | ' + n + ', basse)');
    proche(cdfBinomial(k, n, hi), 0.025, 1e-8, 'P(X <= ' + k + ' | ' + n + ', haute)');
  }
});

t('l intervalle encadre k/n et reste dans [0,1]', () => {
  for (const [k, n] of [[0, 5], [1, 2], [3, 3], [7, 9], [1, 1000]]) {
    const [lo, hi] = intervalleProportion(k, n);
    assert.ok(lo >= 0 && hi <= 1, 'k=' + k + '/n=' + n + ': bornes hors [0,1]');
    assert.ok(lo <= k / n && k / n <= hi, 'k=' + k + '/n=' + n + ': ' + (k / n) + ' hors de [' + lo + ', ' + hi + ']');
  }
});

t('★ plus de tirages RETRECIT l intervalle a proportion egale — sinon n ne serait lu par personne', () => {
  const [lo2, hi2] = intervalleProportion(1, 2);
  const [lo50, hi50] = intervalleProportion(25, 50);
  assert.ok((hi50 - lo50) < (hi2 - lo2) / 2,
    'a 50 % observe, 50 tirages doivent donner un intervalle bien plus etroit que 2: '
    + (hi50 - lo50).toFixed(3) + ' vs ' + (hi2 - lo2).toFixed(3));
});

/* ── LA CDF, DANS LES DEUX SENS ET AUX EXTREMES ───────────────────────────────────────────────────── */

t('CDF aux extremes: p=0 rend 1, p=1 rend 0 sauf si k >= n', () => {
  proche(cdfBinomial(0, 10, 0), 1, 1e-12, 'CDF(0,10,0)');
  assert.strictEqual(cdfBinomial(3, 10, 1), 0, 'a p=1 on ne voit jamais 3 succes sur 10');
  assert.strictEqual(cdfBinomial(10, 10, 1), 1, 'mais k >= n est certain');
});

t('CDF DECROIT quand p monte, CROIT quand k monte, et reste exacte sur un p minuscule', () => {
  assert.ok(cdfBinomial(3, 20, 0.1) > cdfBinomial(3, 20, 0.5), 'p qui monte doit faire baisser P(X<=3)');
  assert.ok(cdfBinomial(5, 20, 0.3) > cdfBinomial(2, 20, 0.3), 'k qui monte doit faire monter la CDF');
  /* log1p: sans lui, (1-1e-12)^1000 perd ses chiffres significatifs. */
  proche(cdfBinomial(0, 1000, 1e-12), Math.exp(-1e-9), 1e-15, 'CDF(0,1000,1e-12)');
});

/* ── LES ENTREES QUI N EN SONT PAS ────────────────────────────────────────────────────────────────── */

t('★ une entree invalide rend NaN, jamais un intervalle rassurant', () => {
  for (const [k, n] of [[-1, 5], [6, 5], [1.5, 5], [1, 0], [1, -2]]) {
    const [lo, hi] = intervalleProportion(k, n);
    assert.ok(Number.isNaN(lo) && Number.isNaN(hi), 'k=' + k + ' n=' + n + ' doit rendre [NaN, NaN]');
  }
});

/* ── LE CONTROLE D INDEPENDANCE: LA RAISON D ETRE DE CE MODULE ────────────────────────────────────── */

t('★ LE CAS REEL: 1 rug sur 31 tokens portes par 2 financeurs se calcule sur 2, pas sur 31', () => {
  const brut = proportionAvecBornes(1, 31);
  const vrai = proportionAvecBornes(1, 31, { effectif: 2 });
  assert.strictEqual(brut.effectif, 31, 'sans effectif declare, on calcule sur les observations');
  assert.strictEqual(vrai.effectif, 2, 'avec un effectif de 2, c est lui qui gouverne');
  assert.ok((vrai.haute - vrai.basse) > (brut.haute - brut.basse) * 3,
    'l intervalle honnete doit etre BEAUCOUP plus large: ' + (vrai.haute - vrai.basse).toFixed(3)
    + ' vs ' + (brut.haute - brut.basse).toFixed(3));
  assert.ok(typeof vrai.raison === 'string' && vrai.raison.length > 0,
    'le regroupement doit etre DIT, pas seulement applique');
  assert.strictEqual(brut.raison, null, 'et un calcul non groupe ne porte pas de raison');
});

t('★ un effectif sous le plancher RETIENT le taux et garde le compte', () => {
  const r = proportionAvecBornes(1, 31, { effectif: 2, plancher: 20 });
  assert.strictEqual(r.taux, null, 'le taux ne se publie pas sous le plancher');
  assert.strictEqual(r.basse, null);
  assert.strictEqual(r.haute, null);
  assert.strictEqual(r.retenu, true, 'et l etat « retenu » se distingue d une entree invalide');
  assert.strictEqual(r.k, 1, 'le COMPTE, lui, reste lisible');
  assert.strictEqual(r.n, 31);
  /* Trois etats, pas deux: retenu par plancher n est pas la meme chose qu invalide. */
  const invalide = proportionAvecBornes(1, 0);
  assert.strictEqual(invalide.retenu, false, 'une entree invalide n est PAS « retenue par plancher »');
});

t('un effectif superieur ou egal a n est ignore — on ne fabrique pas des tirages', () => {
  for (const eff of [31, 99, null, undefined]) {
    const r = proportionAvecBornes(1, 31, { effectif: eff });
    assert.strictEqual(r.effectif, 31, 'effectif=' + String(eff) + ' ne doit pas elargir l echantillon');
    assert.ok(r.taux !== null, 'effectif=' + String(eff) + ' doit tout de meme publier');
  }
});

t('★ un effectif de ZERO REFUSE — il ne retombe pas sur n, qui est l estimation la plus rassurante', () => {
  /* Le defaut reel: une sonde affichait « 0 financeur(s) » et, deux lignes plus bas, un intervalle
   * calcule sur 10 tokens. Zero tirage identifie n est pas « pas d information de groupement ». */
  for (const eff of [0, -2, 1.5, NaN]) {
    const r = proportionAvecBornes(9, 10, { effectif: eff });
    assert.strictEqual(r.taux, null, 'effectif=' + String(eff) + ': aucun taux ne doit sortir');
    assert.strictEqual(r.basse, null);
    assert.strictEqual(r.haute, null);
    assert.ok(typeof r.raison === 'string' && r.raison.length > 0, 'le refus doit DIRE pourquoi');
    /* Trois etats, encore: ce refus n est PAS « retenu par plancher ». */
    assert.strictEqual(r.retenu, false, 'un effectif absurde n est pas un plancher non atteint');
  }
  /* Et le cas OPPOSE: sans le champ, on publie toujours. */
  assert.ok(proportionAvecBornes(9, 10).taux !== null, 'sans effectif declare, le calcul se fait sur n');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
