'use strict';
/**
 * coupe-quartiles.test.js — le garde qui a MENTI, et la preuve qu'il mord maintenant.
 * ================================================================================================
 * `replay-basis-fields.js` refusait une coupe quand `q1 === q3`. Sur `lpLockedPct` les bornes reelles
 * etaient q1=0 et q3=3.1622e-14: l'egalite exacte est FAUSSE, le garde s'est tu, et un ecart entre
 * seaux extremes a ete publie sur un decoupage dont le deuxieme seau contenait zero token.
 *
 * ⛔ UN GARDE DE SEUIL DOIT REPROUVER QU'IL MORD. Ce fichier tient les deux bouts, parce qu'un garde
 * qui attrape tout est aussi inutile qu'un garde qui n'attrape rien:
 *   · il ATTRAPE les bornes reelles de `lpLockedPct` (le cas qui lui a echappe) ;
 *   · il LAISSE PASSER les bornes reelles de `holders`, `topWalletPct` et `unreadable`, dont les
 *     coupes repartissent honnetement la population.
 *
 * Les vecteurs sont reconstruits pour reproduire les quartiles MESURES le 2026-08-05 par
 * hermes/economy/probe-quartile-degenerate.js sur les 1859 tokens du radar. Chaque cas porte les
 * chiffres observes, pour qu'un lecteur puisse contester la reconstruction et pas seulement le verdict.
 */

const assert = require('node:assert/strict');
const { coupeQuartiles } = require('../lib/prequential');

const cas = [];
const t = (nom, fn) => cas.push([nom, fn]);

/* ── LE CAS QUI A ECHAPPE ─────────────────────────────────────────────────────────────────────
 * Mesure: n=235, distincts=13, min=0, max=1, q1=0, median=0, q3=3.1622e-14,
 *         seaux 144 · 0 · 33 · 58. Le deuxieme seau est vide parce que q1 et median valent 0. */
const LP_LOCKED_PCT = [
  ...Array(144).fill(0),
  ...Array(33).fill(3.1622e-14),
  ...Array(29).fill(0.5),
  ...Array(29).fill(1),
];

t('lpLockedPct : la coupe est REFUSEE, et la raison nomme le seau vide', () => {
  const c = coupeQuartiles(LP_LOCKED_PCT);
  assert.equal(c.n, 235, 'le vecteur doit reproduire les 235 valeurs lues');
  assert.equal(c.q1, 0);
  assert.equal(c.q3, 3.1622e-14);
  assert.equal(c.seaux[1], 0, 'le deuxieme seau doit etre vide — c est le fait a attraper');
  assert.equal(typeof c.degeneree, 'string', 'la coupe doit etre refusee');
  assert.ok(c.degeneree.includes('2'), 'la raison doit nommer QUEL seau est vide');
});

t('lpLockedPct : l ANCIEN garde (q1 === q3) laissait passer — la preuve du defaut', () => {
  const c = coupeQuartiles(LP_LOCKED_PCT);
  assert.equal(c.q1 === c.q3, false,
    'q1 et q3 sont numeriquement differents: l ancien garde ne pouvait pas mordre');
  assert.notEqual(c.degeneree, null,
    'le nouveau garde mord la ou l ancien se taisait — sinon ce correctif ne corrige rien');
});

/* ── LES CAS QUI DOIVENT PASSER ───────────────────────────────────────────────────────────────
 * Un garde qui refuse tout ne mesure rien. Ces trois coupes ont reparti la population et doivent
 * rester acceptees. `holders` est le controle le plus utile: son ecart interquartile rapporte a
 * l etendue vaut 1,1e-6 — un critere sur l ecart RELATIF l aurait tue a tort. */
t('holders : coupe SAINE malgre un ecart relatif de 1,1e-6 (le piege du critere relatif)', () => {
  const v = [
    ...Array(169).fill(4), ...Array(160).fill(10), ...Array(184).fill(15),
    ...Array(140).fill(500), 10305861,
  ];
  const c = coupeQuartiles(v);
  assert.equal(c.q1, 4); assert.equal(c.q2, 10); assert.equal(c.q3, 15);
  assert.ok((c.q3 - c.q1) / (10305861 - 4) < 1e-5, 'l ecart relatif est bien minuscule ici');
  assert.equal(c.degeneree, null, 'et pourtant les quatre seaux sont peuples — la coupe est valide');
  assert.ok(c.seaux.every((n) => n > 0));
});

t('unreadable : 8 valeurs distinctes pour 1638 lignes, et la coupe reste valide', () => {
  const v = [
    ...Array(419).fill(2), ...Array(709).fill(4), ...Array(172).fill(5), ...Array(338).fill(7),
  ];
  const c = coupeQuartiles(v);
  assert.equal(c.degeneree, null, 'peu de valeurs distinctes n est PAS une distribution ecrasee');
  assert.deepEqual(c.seaux, [419, 709, 172, 338]);
});

t('topWalletPct : n=40, quatre seaux peuples, coupe acceptee', () => {
  const v = [
    ...Array(12).fill(0), ...Array(8).fill(0.01), ...Array(10).fill(0.0447), ...Array(10).fill(1),
  ];
  assert.equal(coupeQuartiles(v).degeneree, null);
});

/* ── LES BORNES DU HELPER LUI-MEME ────────────────────────────────────────────────────────────── */
t('une serie constante est refusee — trois seaux vides, pas un chiffre', () => {
  const c = coupeQuartiles(Array(100).fill(7));
  assert.notEqual(c.degeneree, null);
  assert.deepEqual(c.seaux, [100, 0, 0, 0]);
});

t('trop peu de valeurs : refuse, et la raison le dit au lieu de rendre un seuil', () => {
  const c = coupeQuartiles([1, 2, 3]);
  assert.equal(c.q1, null, 'aucune borne ne doit etre publiee sur trois valeurs');
  assert.ok(c.degeneree.includes('3 valeur'));
});

t('les non-nombres sont ECARTES, pas convertis — NaN traverserait toute comparaison', () => {
  const c = coupeQuartiles([1, 2, 3, 4, 5, 6, 7, 8, NaN, null, undefined, '4', Infinity]);
  assert.equal(c.n, 8, 'seules les huit valeurs finies comptent');
  assert.equal(c.degeneree, null);
});

t('une entree qui n est pas un tableau ne jette pas et ne rend pas de bornes', () => {
  const c = coupeQuartiles(null);
  assert.equal(c.n, 0);
  assert.equal(c.q1, null);
  assert.notEqual(c.degeneree, null);
});

/* ── HARNAIS ─────────────────────────────────────────────────────────────────────────────────────
 * L appel est DANS le try: un echec synchrone hors du try sortait du processus et la suite perdait
 * silencieusement les cas suivants. */
let passed = 0, failed = 0;
for (const [nom, fn] of cas) {
  try { fn(); passed++; console.log(`  ok   ${nom}`); }
  catch (e) { failed++; console.log(`  FAIL ${nom}\n       ${e.message}`); }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
