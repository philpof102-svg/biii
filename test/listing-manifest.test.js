#!/usr/bin/env node
'use strict';
/**
 * npmExists — « ce paquet n'est pas publié » et « je n'ai pas pu joindre le registre » étaient la même phrase.
 * ============================================================================================================
 * ⚠️ LE DÉFAUT, mesuré le 2026-07-29 contre le vrai registre npm :
 *
 *     paquet publié          -> ok:true,  200
 *     paquet inexistant      -> ok:false, 404
 *     registre INJOIGNABLE   -> ok:false, "getaddrinfo ENOTFOUND"      <- la MÊME réponse
 *
 * Et le consommateur en tirait, mot pour mot :
 *
 *     PHANTOM  biii-mcp  <-- HTTP getaddrinfo ENOTFOUND: this manifest points at nothing
 *
 * Une affirmation catégorique fabriquée par une panne DNS, sur un script dont l'en-tête promet
 * « resolved against registry.npmjs.org, not remembered » — ce qui la rend d'autant plus crédible — et
 * dont la dernière ligne précise que ces chiffres sont ceux qu'une annonce a le droit de citer.
 *
 * Ce dépôt s'est déjà trompé une fois sur un état de publication, dans l'autre sens (toshi-companion
 * annoncé publié alors que npm rendait E404). Les deux directions coûtent la même chose : une affirmation
 * publique sur ce qui existe, tirée d'une lecture qui n'a pas eu lieu.
 *
 * ⚠️ LES BORNES. Tout ceci serait satisfait par une fonction qui répond « non vérifié » à tout : un 200
 * doit rester `published` et un 404 doit rester `absent`, sinon le script ne détecte plus aucun fantôme
 * et la vérification devient décorative.
 *
 * ⚠️ HARNAIS asynchrone dès le départ. `npmExists` est une promesse ; un harnais synchrone la laisserait
 * passer sans rien vérifier — piège déjà payé dans ce dépôt.
 *
 * Run: node test/listing-manifest.test.js
 */
const assert = require('node:assert');
const { npmExists } = require('../scripts/listing-manifest');

let pass = 0, fail = 0;
const t = async (n, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + n); }
  catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e && e.message)); }
};

/* ⚠️ CE FICHIER DOIT SE COMPTER LUI-MÊME, et il y a une raison précise, découverte en mutant.
 * Retirer le gestionnaire de délai de `npmExists` laisse une promesse qui ne se résout JAMAIS. Le `await`
 * ne rend pas la main, le bilan n'est jamais imprimé, la boucle d'événements se vide — et Node sort
 * avec le code **0**. La mutation survivait donc en faisant croire à un succès, alors que la moitié des
 * cas n'avaient pas tourné. Un succès vide est une panne, pas un résultat.
 *
 * Deux gardes, parce qu'une seule ne suffit pas : le chien de garde attrape le blocage, et le compte
 * attendu attrape un fichier qui s'arrêterait en silence pour une autre raison. */
const ATTENDUS = 9;
/* PAS de `unref()` ici : un timer déréférencé laisse Node sortir, ce qui est précisément la panne qu'on
 * veut attraper. Le chemin normal appelle `process.exit` avant les 15 s, donc il ne coûte rien. */
setTimeout(() => {
  console.log('\n  FAIL le fichier ne s\'est pas terminé — une promesse ne s\'est jamais résolue.');
  console.log('  ' + pass + ' cas exécutés sur ' + ATTENDUS + ' attendus.');
  process.exit(1);
}, 15000);

/** Un faux `https.get` : (url, opts, cb) -> req, où `req.on('error'|'timeout')` est honoré. */
function fauxGet(scenario) {
  return (url, opts, cb) => {
    const handlers = {};
    const req = { on: (ev, h) => { handlers[ev] = h; return req; }, destroy: () => {} };
    setImmediate(() => {
      if (scenario === 'error') handlers.error && handlers.error(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'));
      else if (scenario === 'timeout') handlers.timeout && handlers.timeout();
      else cb({ statusCode: scenario, resume: () => {} });
    });
    return req;
  };
}
const etat = (scenario) => npmExists('un-paquet', { get: fauxGet(scenario), timeoutMs: 50 });

(async () => {
  console.log('npmExists — trois états, jamais deux :\n');

  await t('★ BORNE: 200 reste « publié » (sinon plus rien n\'est jamais confirmé)', async () => {
    const r = await etat(200);
    assert.equal(r.state, 'published');
    assert.equal(r.ok, true);
  });
  await t('★ BORNE: 404 reste « absent » — c\'est le SEUL code qui dit « ce paquet n\'est pas là »', async () => {
    const r = await etat(404);
    assert.equal(r.state, 'absent');
    assert.equal(r.ok, false);
  });

  await t('★ un registre injoignable est NON VÉRIFIÉ, pas absent', async () => {
    const r = await etat('error');
    assert.equal(r.state, 'unchecked', 'une panne DNS ne dit rien sur le paquet');
    assert.equal(r.ok, false, 'ok reste faux — on ne confirme pas non plus');
    assert.match(String(r.status), /ENOTFOUND/, 'et la cause est conservée, pas résumée en booléen');
  });
  await t('★ un délai dépassé est NON VÉRIFIÉ (et ne fait plus attendre indéfiniment)', async () => {
    const r = await etat('timeout');
    assert.equal(r.state, 'unchecked');
    assert.match(String(r.status), /timeout/);
  });
  for (const code of [429, 500, 503]) {
    await t('★ HTTP ' + code + ' est NON VÉRIFIÉ — le registre a refusé de répondre, il n\'a pas dit « absent »', async () => {
      const r = await etat(code);
      assert.equal(r.state, 'unchecked', code + ' ne doit jamais compter comme un fantôme');
    });
  }

  await t('les trois états sont mutuellement exclusifs et couvrent tout', async () => {
    const vus = new Set();
    for (const s of [200, 404, 429, 'error', 'timeout']) vus.add((await etat(s)).state);
    assert.deepStrictEqual([...vus].sort(), ['absent', 'published', 'unchecked']);
  });
  await t('`ok` reste un raccourci de « publié », jamais de « pas absent »', async () => {
    for (const s of [404, 429, 'error', 'timeout']) assert.equal((await etat(s)).ok, false);
    assert.equal((await etat(200)).ok, true);
  });

  /* La suite se compte elle-même : un fichier qui s'arrêterait en silence à mi-chemin sortirait sinon
   * en « 0 failed », ce qui se lit exactement comme un succès. */
  const manquants = ATTENDUS - (pass + fail);
  if (manquants !== 0) {
    fail++;
    console.log('  FAIL le compte ne tombe pas : ' + (pass + fail - 1) + ' cas exécutés, ' + ATTENDUS + ' attendus');
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
