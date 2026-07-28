'use strict';
/* meme-scan — le ✓ le plus dangereux du dépôt, parce que personne ne relit une coche verte.
 *
 * ⚠️ CE QU'IL IMPRIMAIT QUAND L'API DE BOOSTS TOMBAIT:
 *
 *   ✓ meme-watch harvest: 0 boosted tokens scanned, no impersonation/ambiguity among the promoted ones.
 *
 * `getJSON` résout `null` sur erreur réseau ET sur corps non-parsable; `Array.isArray(null)` étant faux,
 * la liste retombait à `[]`. Une phrase rassurante sur une récolte qui n'a pas eu lieu. Et les tokens
 * dont la seconde requête échouait disparaissaient du dénominateur sans le dire.
 *
 * Run: node test/meme-scan.test.js
 */
const assert = require('node:assert');
const { boostedTokens, summarise } = require('../hermes/economy/meme-scan.js');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const ADR = (i) => '0x' + String(i).padStart(40, '0');
const boost = (i) => ({ chainId: 'base', tokenAddress: ADR(i) });
const paire = (sym) => ({ pairs: [{ baseToken: { symbol: sym } }] });

/** `tombe` = ce que l'API rend: null (panne) ou la liste. `symboles` = résolution par adresse. */
const api = (liste, symboles = {}) => async (url) => {
  if (/token-boosts/.test(url)) return liste;
  const a = url.split('/').pop();
  return symboles[a] === undefined ? paire('TOK' + a.slice(-2)) : symboles[a];
};

(async () => {
  console.log('meme-scan — un ✓ doit dire de combien de tokens il parle:');

  await t('★ liste de boosts NON LUE ⇒ récolte marquée non lue, jamais 0 tokens', async () => {
    const r = await boostedTokens(12, api(null));
    assert.strictEqual(r.harvestRead, false, '[] se lirait « lu, il n y a personne »');
    assert.deepStrictEqual(r.tokens, []);
  });

  await t('LES DEUX BORNES: une liste VRAIMENT vide est lue, et le dit', async () => {
    const r = await boostedTokens(12, api([]));
    assert.strictEqual(r.harvestRead, true, 'lu-et-vide est une VRAIE mesure');
    assert.strictEqual(r.picked, 0);
  });

  await t('★ un token dont le symbole ne se résout pas est COMPTÉ, pas effacé', async () => {
    const r = await boostedTokens(12, api([boost(1), boost(2)], { [ADR(2)]: null }));
    assert.strictEqual(r.picked, 2, 'deux candidats retenus dans la liste');
    assert.strictEqual(r.tokens.length, 1);
    assert.strictEqual(r.dropped, 1, 'le dénominateur affiché était plus petit que la réalité, en silence');
  });

  await t('★ LE TITRE: une récolte non lue n est PAS une coche verte', async () => {
    const s = summarise({ alerts: 0, examined: 0, harvestRead: false });
    assert.doesNotMatch(s, /^✓/, 'c est exactement la phrase qui a motivé ce test');
    assert.match(s, /could NOT be read/i);
    assert.match(s, /not the same as nothing found/i);
  });

  await t('★ LE TITRE: lu mais aucun token examinable ⇒ « No verdict », pas un ✓', async () => {
    const s = summarise({ alerts: 0, examined: 0, harvestRead: true, picked: 5, dropped: 3, skipped: 2 });
    assert.doesNotMatch(s, /^✓/);
    assert.match(s, /NOT ONE could be examined/i);
    assert.match(s, /3 had no readable symbol/);
    assert.match(s, /2 could not be vetted/);
  });

  await t('un balayage partiel garde son ✓ mais porte la réserve', async () => {
    const s = summarise({ alerts: 0, examined: 4, harvestRead: true, picked: 6, dropped: 2 });
    assert.match(s, /^✓/, 'quatre tokens ONT été examinés: le dire reste vrai');
    assert.match(s, /4 boosted token\(s\) examined/);
    assert.match(s, /PARTIAL/);
  });

  await t('LES DEUX BORNES: un balayage complet ne porte AUCUNE réserve', async () => {
    /* Une réserve permanente apprend à tout le monde à l ignorer — c est pire qu aucune réserve. */
    const s = summarise({ alerts: 0, examined: 6, harvestRead: true, picked: 6, dropped: 0, skipped: 0 });
    assert.match(s, /^✓/);
    assert.doesNotMatch(s, /PARTIAL/);
  });

  await t('une alerte compte les tokens EXAMINÉS, pas les tokens récoltés', async () => {
    const s = summarise({ alerts: 2, examined: 4, harvestRead: true, picked: 9 });
    assert.match(s, /2 FRESH trap\(s\) among 4 boosted token\(s\) examined/);
    assert.doesNotMatch(s, /9/, 'annoncer 9 laisserait croire que 9 ont été jugés');
  });

  await t('★ les trois états de récolte sont DISTINGUABLES (témoin d instrument)', async () => {
    const nonLu = summarise({ alerts: 0, examined: 0, harvestRead: false });
    const vide = summarise({ alerts: 0, examined: 0, harvestRead: true, picked: 0 });
    const plein = summarise({ alerts: 0, examined: 3, harvestRead: true, picked: 3 });
    assert.strictEqual(new Set([nonLu, vide, plein]).size, 3);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
