'use strict';
/**
 * POST /charge — UN REFUS DOIT NOMMER SA CAUSE, ET LE CHAMP QUI EXISTE VRAIMENT.
 * Run: node test/charge-refusal.test.js
 *
 * ⚠️ CE QUI A ETE MESURE (2026-08-15, parcours commercant joue en entier sur un noeud local).
 * Cinq POST /charge avec `amountUsd` valant 0, -5, "abc", 999999999999 et 4.5555555. Cinq causes
 * distinctes cote `lib/till.js` — zero, forme illisible, plafond, trop de decimales — et UNE SEULE
 * phrase rendue au commercant:
 *
 *     { "error": "could not create the charge — check amount/label" }
 *
 * Elle nommait `amount`: ce champ N'EXISTE PAS, l'API lit `amountUsd`. Et `label`, qui n'etait en
 * cause dans AUCUN des cinq cas. Un commercant devant sa caisse ne pouvait ni savoir lequel de ses
 * gestes etait refuse, ni quoi corriger. C'est le genre de defaut qui ne casse aucun test et rend le
 * produit inutilisable pour qui n'a pas le source sous les yeux.
 *
 * ⚖️ POURQUOI CE N'EST PAS UNE REGRESSION DE SECURITE. `oops()` ecrase l'erreur reelle par une
 * categorie stable, DELIBEREMENT (CWE-209): un `e.message` brut peut porter une URL de RPC, un chemin
 * de fichier, des internes de bibliotheque. Cette posture est juste et elle reste. Ce qui change: un
 * refus de VALIDATION ne parle que de ce que l'appelant VIENT D'ENVOYER — le lui rendre ne lui apprend
 * rien qu'il ne sache. `lib/till.js` marque cette classe A LA SOURCE (`refus()` pose `.caller = true`),
 * `oops()` ne laisse passer que `=== true`, et TOUT LE RESTE reste couvert par la categorie.
 *
 * 🔬 CE QUE CE FICHIER PROUVE — ET CE QU'IL NE PROUVE PAS.
 * Il prouve (a) que les cinq causes ressortent DISTINCTES, (b) qu'elles nomment `amountUsd`, (c)
 * qu'aucune ne nomme un champ que l'API n'accepte pas, et (d) que le marqueur est BORNE: les erreurs
 * de validation le portent, les autres erreurs de `till.js` ne le portent pas.
 * ⛔ Il NE prouve PAS le repli de `oops()` a travers HTTP sur cette route: `/charge` n'a aucun `throw`
 * NON marque atteignable une fois `createCharge` passe (`paymentURI` ne jette que sur une adresse
 * invalide, que `createCharge` a deja refusee). La borne du repli est donc asserte au niveau unitaire
 * en (d), pas au niveau reseau. Le dire plutot que de laisser croire que la route entiere est couverte.
 */
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const T = require('../lib/till');

const M = '0x' + 'ab'.repeat(20);
let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓ ' + n); },
  (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, path, body) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { j = null; } resolve({ status: res.statusCode, body: j }); }); });
    // ⚠️ SANS CE HANDLER L'INSTRUMENT SE TUE. `readBody` coupe a 4096 octets en detruisant la requete;
    // le client leve alors ECONNRESET en 'error', non gere = crash du process de test. Mesure du
    // 2026-08-15: mon premier corps de 5000 caracteres a tue la suite AU MILIEU, apres quatre resultats
    // deja imprimes — un instrument qui meurt en route rend un bilan partiel qui a l'air d'un bilan.
    r.on('error', (e) => resolve({ status: 0, body: null, transport: e.code || e.message }));
    if (data) r.write(data); r.end();
  });
}

// LES CINQ ENTREES DE LA MESURE, telles quelles. Chacune emprunte une branche differente de till.js.
const CINQ = [
  ['0', 'zero'],
  ['-5', 'negatif — refuse par la FORME, le signe ne passe pas la regex'],
  ['abc', 'pas un nombre'],
  ['999999999999', 'au-dessus du plafond de 1 000 000 000 USDC'],
  ['4.5555555', 'sept decimales — USDC en compte six'],
];
// Ce que POST /charge lit reellement dans le corps, releve dans lib/server.js. Un message de refus qui
// nomme autre chose envoie le commercant corriger un champ qui n'existe pas — le defaut d'origine.
const CHAMPS_ACCEPTES = new Set(['amountUsd', 'orderId']); // `to` et `label` ne sont pas camelCase

(async () => {
  console.log('POST /charge — un refus nomme sa cause:');
  const server = build({ merchant: M, findPayment: async () => null });
  await new Promise((r) => server.listen(0, r));

  const refus = [];
  for (const [montant] of CINQ) {
    const r = await req(server, 'POST', '/charge', { amountUsd: montant, label: 'cafe' });
    refus.push({ montant, status: r.status, error: r.body && r.body.error });
  }

  await t('les cinq montants aberrants sont tous refuses en 400', () => {
    for (const r of refus) assert.equal(r.status, 400, `${JSON.stringify(r.montant)} aurait du etre refuse`);
  });

  await t('les cinq causes ressortent DISTINCTES — c est le defaut mesure', () => {
    const vus = new Map();
    for (const r of refus) {
      assert.ok(r.error, `${JSON.stringify(r.montant)} n a rendu aucun message`);
      if (vus.has(r.error)) {
        assert.fail(`deux causes differentes rendent la MEME phrase: ${JSON.stringify(r.montant)} et `
          + `${JSON.stringify(vus.get(r.error))} disent tous deux « ${r.error} »`);
      }
      vus.set(r.error, r.montant);
    }
    assert.equal(vus.size, CINQ.length, 'cinq entrees, cinq messages');
  });

  await t('chaque refus nomme amountUsd — le champ que l API accepte vraiment', () => {
    for (const r of refus) {
      assert.ok(/\bamountUsd\b/.test(r.error),
        `${JSON.stringify(r.montant)} rend « ${r.error} » sans nommer amountUsd`);
    }
  });

  /* 🔬 NOTE D'INSTRUMENT — CE RECENSEMENT A UN ANGLE MORT, ET LE DEFAUT VIVAIT DEDANS.
   * Au premier tour, `createCharge` ne passait pas son nom de champ et les cinq refus disaient
   * « amount … ». Ce test-ci est passe AU VERT: `amount` n'est pas camelCase, donc aucun jeton a
   * recenser. Seule l'assertion POSITIVE d'au-dessus — « chaque refus nomme amountUsd » — a rougi.
   * Un recensement ne prouve que l'absence de ce qu'il sait reconnaitre; c'est l'affirmation de ce
   * qu'on VEUT voir qui attrape le nom qu'on n'avait pas prevu. Garder les deux. */
  await t('aucun refus ne nomme un champ que l API n accepte pas', () => {
    for (const r of refus) {
      // recensement des identifiants camelCase du message: chacun doit etre un champ REEL du corps.
      for (const jeton of String(r.error).match(/\b[a-z]+[A-Z][A-Za-z]*\b/g) || []) {
        assert.ok(CHAMPS_ACCEPTES.has(jeton),
          `« ${r.error} » nomme « ${jeton} », que POST /charge ne lit pas`);
      }
      // le defaut d origine, epingle nommement: il nommait `amount` et `label`.
      assert.ok(!/check amount\/label/.test(r.error), 'la phrase fourre-tout est revenue');
      assert.ok(!/\blabel\b/.test(r.error),
        `« ${r.error} » accuse label, qui n est en cause dans aucun des cinq cas`);
    }
  });

  await t('TEMOIN — un montant valide passe toujours, avec son URI de paiement', async () => {
    const ok = await req(server, 'POST', '/charge', { amountUsd: '4.50', label: 'cafe' });
    assert.equal(ok.status, 200, 'un montant correct doit etre accepte');
    assert.equal(ok.body.charge.amountMicro, '4500000');
    assert.ok(String(ok.body.paymentURI).startsWith('ethereum:'), 'l URI EIP-681 doit etre servie');
  });

  await t('le message rendu reste BORNE — l appelant ne dimensionne pas notre reponse', async () => {
    // 500 caracteres: SOUS le plafond de corps de readBody (4096), donc la valeur atteint vraiment
    // usdToMicro et c'est bien la borne du MESSAGE qu'on mesure, pas celle du corps.
    const r = await req(server, 'POST', '/charge', { amountUsd: 'x'.repeat(500) });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.length <= 200, `un refus ne doit pas renvoyer 500 caracteres d appelant (${r.body.error.length})`);
  });

  await t('un corps surdimensionne n est jamais ACCEPTE (autre borne, autre couche)', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: 'x'.repeat(5000) });
    // readBody coupe a 4096 en detruisant la requete: selon la course, l appelant voit un 400 ou une
    // coupure de transport. Les deux sont acceptables; ce qui ne l est pas, c est un 200.
    assert.notEqual(r.status, 200, 'un corps surdimensionne ne doit jamais creer de charge');
  });

  // (d) LA BORNE DU MARQUEUR, au niveau unitaire. C est la propriete de surete: seul ce qui est marque
  // peut atteindre l appelant, donc il faut prouver que le marquage ne deborde pas de la validation.
  await t('le marqueur .caller est BORNE — validation oui, reste non', () => {
    const marque = (fn) => { try { fn(); return 'pas jete'; } catch (e) { return e.caller === true; } };
    for (const [quoi, fn] of [
      ['usdToMicro("abc")', () => T.usdToMicro('abc')],
      ['usdToMicro("0")', () => T.usdToMicro('0')],
      ['createCharge sans adresse', () => T.createCharge({ to: 'pas-une-adresse', amountUsd: '1' })],
      ['createCharge amountMicro nul', () => T.createCharge({ to: M, amountMicro: '0' })],
    ]) assert.equal(marque(fn), true, `${quoi} doit porter .caller`);

    for (const [quoi, fn] of [
      ['paymentURI sur une charge invalide', () => T.paymentURI({ to: 'nope' })],
      ['verifyPayment sans charge', () => T.verifyPayment(null, {})],
      ['receipt sans paiement verifie', () => T.receipt({ to: M }, { paid: false })],
    ]) assert.equal(marque(fn), false, `${quoi} ne doit PAS porter .caller — le repli doit le couvrir`);
  });

  server.close();
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
