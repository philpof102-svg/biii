'use strict';
/* survey-mcp-registry — le recensement d'auditabilité, destiné à être PUBLIÉ.
 *
 * ⚠️ IL N'AVAIT AUCUN TEST, et c'est le seul artefact de ce dépôt qu'on veut mettre dehors: « X % des
 * endpoints MCP publics ne peuvent pas être audités avant qu'on s'y connecte ». Un chiffre public sans
 * lecteur est un chiffre qu'on croit sur parole.
 *
 * Deux défauts mesurés le 2026-07-28:
 *
 *   1. `if (v)` supprimait les catégories à ZÉRO. Sur un recensement, « refuse: 0/79 » EST une mesure —
 *      elle dit qu'on a regardé et qu'on n'a rien trouvé. La faire disparaître rend le zéro
 *      indiscernable d'un contrôle qui n'a pas tourné.
 *   2. Un `vetAgent` qui JETTE de notre côté (DNS, débit, socket) était compté `unreachable` — le seau
 *      qui veut dire « LEUR endpoint ne répond pas ». Publier notre panne sous le nom d'un tiers est la
 *      même faute que toutes les accusations corrigées le même jour, sur un chiffre destiné à sortir.
 *
 * Run: node test/survey-census.test.js
 */
const assert = require('node:assert');
/* Requérir ce script ne doit PAS lancer le balayage réseau de 79 endpoints. */
const { distribution, classerReponse } = require('../scripts/survey-mcp-registry.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const TALLY = { unreachable: 8, unauditable: 41, answers: 29, high_risk: 1, refuse: 0,
  noToolList: 0, surveyFailed: 0 };

console.log('recensement MCP — un zéro publié doit être une mesure, pas une absence:');

t('★ une catégorie à ZÉRO est IMPRIMÉE, et dite mesurée', () => {
  const l = distribution(TALLY, 79, 412).join('\n');
  assert.match(l, /refuse\s+0\/79/, 'un 0 supprimé se lit « pas mesuré »');
  assert.match(l, /\(mesuré, aucun\)/, 'et il doit dire lequel des deux il est');
});

t('★ TOUTES les cases du décompte apparaissent — aucune ne disparaît', () => {
  const l = distribution(TALLY, 79, 412);
  for (const k of Object.keys(TALLY)) {
    assert.ok(l.some((x) => x.includes(k)), k + ' a disparu du recensement');
  }
});

t('★ nos propres échecs sont SÉPARÉS de leurs endpoints', () => {
  /* `surveyFailed` ne dit rien sur le service visé: c est notre instrument qui a lâché. */
  const l = distribution({ ...TALLY, surveyFailed: 5 }, 79, 412).join('\n');
  assert.match(l, /surveyFailed\s+5\/79/);
  assert.match(l, /NOS échecs/);
  assert.match(l, /ne disent rien sur les services concernés/);
});

t('LES DEUX BORNES: sans échec de notre côté, aucune réserve parasite', () => {
  /* Une réserve permanente se lit comme du décor et cesse d être lue. */
  const l = distribution(TALLY, 79, 412).join('\n');
  assert.doesNotMatch(l, /NOS échecs/, 'la mise en garde ne doit apparaître que si elle est vraie');
});

t('LES DEUX BORNES: les chiffres RÉELS restent intacts', () => {
  const l = distribution(TALLY, 79, 412).join('\n');
  assert.match(l, /unauditable\s+41\/79/, 'le chiffre publiable ne doit pas bouger');
  assert.match(l, /answers\s+29\/79/);
  assert.match(l, /tools seen in total: 412/);
});

t('un dénominateur de zéro ne casse pas le rapport', () => {
  /* Le cas du registre injoignable: 0 endpoint recensé. Le rapport doit sortir, pas jeter. */
  const vide = Object.fromEntries(Object.keys(TALLY).map((k) => [k, 0]));
  const l = distribution(vide, 0, 0);
  assert.ok(l.length > 0);
  assert.match(l.join('\n'), /0\/0/);
});

/* ── LA CLASSIFICATION, et pourquoi ce bloc existe ─────────────────────────────────────────────────
 * La mutation « compter notre panne comme la leur » est revenue MUETTE: la ligne vivait dans la boucle
 * réseau, donc aucun test ne pouvait l'atteindre — le correctif le plus important du fichier n'avait
 * pas de lecteur. Extraite en fonction pure, elle en a un. */

t('★ notre appel qui JETTE ne devient pas « leur endpoint est injoignable »', () => {
  assert.strictEqual(classerReponse(null).cle, 'surveyFailed');
  assert.notStrictEqual(classerReponse(null).cle, 'unreachable',
    'unreachable est un verdict SUR leur service; publier notre panne dessous est une affirmation fausse');
});

t('★ LES DEUX BORNES: un endpoint réellement muet reste unreachable', () => {
  /* Le durcissement ne doit pas vider le seau qu il protège. */
  assert.strictEqual(classerReponse({ verdict: 'unreachable' }).cle, 'unreachable');
  assert.strictEqual(classerReponse({ verdict: 'unauditable' }).cle, 'unauditable');
});

t('un endpoint GARDÉ n est pas compté deux fois', () => {
  /* Il n a pas de surface PARCE QU il nous a refusés — c est déjà son verdict. */
  assert.strictEqual(classerReponse({ verdict: 'unauditable' }).noToolList, false);
  assert.strictEqual(classerReponse({ verdict: 'answers' }).noToolList, true, 'là, la liste manque vraiment');
  assert.strictEqual(classerReponse({ verdict: 'answers', surface: { toolCount: 7 } }).noToolList, false);
});

t('les outils d une réponse sans surface comptent pour zéro, pas pour NaN', () => {
  assert.strictEqual(classerReponse(null).tools, 0);
  assert.strictEqual(classerReponse({ verdict: 'unauditable' }).tools, 0);
  assert.strictEqual(classerReponse({ verdict: 'answers', surface: {} }).tools, 0);
  assert.strictEqual(classerReponse({ verdict: 'answers', surface: { toolCount: 7 } }).tools, 7);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
