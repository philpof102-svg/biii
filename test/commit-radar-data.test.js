'use strict';
/* commit-radar-data — le committeur non attendu de la base d'observations, sur un ARBRE PARTAGÉ.
 *
 * ⚠️ IL N'AVAIT AUCUN TEST, ET IL ÉTAIT BLOQUÉ. Mesure du 2026-07-28: il refusait en disant
 *
 *   « REFUSED — modified files outside the data paths — that is code, and code gets reviewed, not
 *     swept:  M data/token-radar/blackouts.json »
 *
 * Or ce fichier n'est ni du code ni hors de `data/`. C'est un QUATRIÈME fichier de données que le radar
 * s'est mis à écrire, absent de la liste blanche explicite. Le garde avait RAISON de refuser — une liste
 * sans joker est précisément ce qui empêche un fichier que personne n'a voulu publier de partir avec le
 * lot. C'est le MESSAGE qui était faux, et le coût était réel:
 *
 *   609 lignes en base, 437 dans le dernier commit — 172 observations bloquées,
 *   et le blocage était PERMANENT tant que la liste n'était pas mise à jour.
 *
 * Un seul message couvrait deux situations opposées, et la différence est exactement ce qu'il faut
 * faire: ajouter le fichier délibérément, ou relire du code.
 *
 * Run: node test/commit-radar-data.test.js
 */
const assert = require('node:assert');
/* Requérir ce fichier ne doit lancer AUCUNE commande git — c'est la seule façon de tester un committeur
 * sans en devenir un. Si ce require avait un effet de bord, le test le déclencherait à chaque suite. */
const { classer, DATA_PATHS } = require('../scripts/commit-radar-data.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const m = (file, code = ' M') => ({ code, file });

console.log('commit-radar-data — un arbre partagé se commite par pathspec, jamais par balayage:');

t('★ un fichier de DONNÉES hors liste n est pas classé « du code »', () => {
  const r = classer([m('data/token-radar/NOUVEAU.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 0, 'c est une donnée, pas du code — le geste à faire est différent');
  assert.strictEqual(r.nouvellesDonnees.length, 1);
  assert.strictEqual(r.nouvellesDonnees[0].file, 'data/token-radar/NOUVEAU.json');
});

t('★ un fichier hors de data/ reste du CODE', () => {
  const r = classer([m('lib/asset.js'), m('scripts/quoi.js')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 2);
  assert.strictEqual(r.nouvellesDonnees.length, 0);
});

t('★ les deux situations sont SÉPARÉES quand elles arrivent ensemble', () => {
  /* Le cas qui compte pour un opérateur: il doit voir les deux gestes, pas un seul message qui en
   * mélange deux. */
  const r = classer([m('lib/asset.js'), m('data/token-radar/NOUVEAU.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 1);
  assert.strictEqual(r.nouvellesDonnees.length, 1);
});

t('★ blackouts.json est DANS la liste — c est ce qui débloquait le committeur', () => {
  /* Ajouté après lecture du contenu: 631 octets, deux enregistrements de trous d observation, aucun
   * secret. Il appartient au même lot que tokens.json — un chiffre tiré d observations ne veut rien dire
   * sans la trace des périodes où l on ne regardait pas. */
  assert.ok(DATA_PATHS.includes('data/token-radar/blackouts.json'));
  const r = classer([m('data/token-radar/blackouts.json'), m('data/token-radar/tokens.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 0);
  assert.strictEqual(r.nouvellesDonnees.length, 0, 'plus rien ne bloque');
  assert.deepStrictEqual(r.aCommiter.sort(),
    ['data/token-radar/blackouts.json', 'data/token-radar/tokens.json']);
});

t('LES DEUX BORNES: la liste reste EXPLICITE — aucun joker, aucun préfixe qui grandit', () => {
  /* La règle qui empêche un secret de voyager: `data/` n est PAS un laissez-passer. Un fichier sous
   * data/ qui n est pas nommé doit rester hors du lot, meme s il est classé comme donnée. */
  const r = classer([m('data/secrets.env.json')], DATA_PATHS);
  assert.strictEqual(r.aCommiter.length, 0, 'être sous data/ ne suffit JAMAIS à être commité');
  assert.strictEqual(r.nouvellesDonnees.length, 1, 'il est signalé, pas balayé');
  for (const p of DATA_PATHS) assert.ok(!/[*?]/.test(p), 'aucun joker dans la liste: ' + p);
});

t('LES DEUX BORNES: un arbre où seuls les fichiers listés bougent ne refuse rien', () => {
  const r = classer(DATA_PATHS.map((f) => m(f)), DATA_PATHS);
  assert.strictEqual(r.duCode.length + r.nouvellesDonnees.length, 0);
  assert.strictEqual(r.aCommiter.length, DATA_PATHS.length);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
