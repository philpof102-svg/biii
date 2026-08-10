#!/usr/bin/env node
'use strict';
/**
 * openapi — le document que des AGENTS lisent pour decider quoi payer, et le defi 402 qui l'accompagne.
 *
 * Dernier des quatre modules lib/ que nul test ne chargeait, et le seul dont la sortie porte un PRIX.
 *
 * TROIS FAUTES MESUREES ET CORRIGEES LE 2026-07-27:
 *
 *   (A) LA CONVERSION DE PRIX ETAIT LACHE, ALORS QUE LA VERSION DURCIE EXISTE DANS LE MEME DEPOT.
 *       `String(Math.round(Number(usd) * 1e6))` rendait:
 *         'abc'       -> "NaN"         publie tel quel dans accepts[].amount ET x-payment-info
 *         '-5'        -> "-5000000"    un montant NEGATIF dans un defi de paiement
 *         '1e3'       -> "1000000000"  1000 $ l'appel, sur une notation exponentielle
 *         '0.0000005' -> "1" d'un cote, "0.000000" de l'autre: DEUX prix publies contradictoires
 *       Le negatif n'est pas cosmetique: x402-settle fait `BigInt(String(needMicro))`, et
 *       `BigInt("-5000000")` est valide. Le test `paidMicro < priceNeed` devient alors faux pour TOUT
 *       paiement — une coquille dans BIII_VET_PRICE_USD rendait l'endpoint payant GRATUIT, en silence.
 *       `till.usdToMicro` refusait deja les trois formes; ce module l'importait pour USDC_BASE et
 *       reimplementait la conversion a cote, la variante lache etant celle branchee sur l'argent.
 *
 *   (B) `payTo: (merchant || '').toLowerCase()` publiait un defi de paiement SANS DESTINATAIRE.
 *       ⚠️ Non atteignable depuis le serveur — la route /x402 garde deja le marchand (503 si absent).
 *       C'est de la defense en profondeur, et il faut le dire plutot que de gonfler la trouvaille.
 *
 *   (C) LE SCHEMA `chainId` DU DOCUMENT ANNONCAIT ENCORE `type:'number', e.g. 8453`. Le meme defaut avait
 *       ete corrige dans le schema du tool MCP quelques heures plus tot — et rate ici ET dans la route
 *       PAYANTE de lib/server.js, qui faisait toujours `Number(b.chainId)`. Un client qui PAYAIT pour
 *       « le vrai contrat sur Base » recevait un contrat Solana certifie « genuine ».
 *       Un correctif applique a un seul site d'appel n'est pas applique.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildOpenApi, challenge402, priceMicro } = require('../lib/openapi.js');
const { candidatesFrom } = require('../lib/meme.js');
const T = require('../lib/till.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

const MARCHAND = '0x1234567890abcdef1234567890abcdef12345678';
const ORIGIN = 'https://biii.example';
const defi = (o = {}) => challenge402({ origin: ORIGIN, merchant: MARCHAND, priceUsd: '0.25', ...o });
const doc = (o = {}) => buildOpenApi({ origin: ORIGIN, merchant: MARCHAND, priceUsd: '0.25', ...o });
const payInfo = (d) => d.paths['/x402/vet-asset'].post['x-payment-info'];

console.log('openapi: un prix qu on ne sait pas lire ne doit ni etre publie ni etre encaisse');

/* ── (A) le prix ─────────────────────────────────────────────────────────────────────────────────── */

t('★ un prix illisible est REFUSE, jamais publie en "NaN"', () => {
  assert.throws(() => priceMicro('abc'), /not a payable amount/i);
  assert.throws(() => defi({ priceUsd: 'abc' }), /not a payable amount/i);
  assert.throws(() => doc({ priceUsd: 'abc' }), /not a payable amount/i);
});

t('★ un prix NEGATIF est refuse — il rendait l endpoint payant gratuit', () => {
  /* La consequence, redite ici parce qu elle n est pas evidente: settleOnce compare
   * `paidMicro < priceNeed`. Avec priceNeed negatif, ce test est faux pour tout paiement, donc un
   * micro-USDC achetait un verdict. Le refus a la source est ce qui empeche la valeur d y arriver. */
  assert.throws(() => priceMicro('-5'), /not a payable amount/i);
  assert.throws(() => priceMicro('-0.25'), /not a payable amount/i);
  const need = priceMicro('0.25');
  assert.ok(BigInt(need) > 0n, 'un besoin positif est ce qui rend la comparaison de settleOnce utile');
});

t('la notation exponentielle est refusee — 1e3 valait 1000 $ l appel', () => {
  assert.throws(() => priceMicro('1e3'), /not a payable amount/i);
});

t('un prix sous le micro-USDC est refuse, il n est pas representable', () => {
  assert.throws(() => priceMicro('0.0000005'), /not a payable amount/i);
});

t('un prix de zero est refuse — « gratuit » n est pas un prix pour un endpoint payant', () => {
  assert.throws(() => priceMicro('0'), /not a payable amount/i);
});

t('★ les DEUX prix publies descendent de la meme valeur validee', () => {
  /* Ils sortaient de deux calculs independants et divergeaient sous le micro. Un client qui lit le
   * document et un client qui lit le defi 402 doivent voir le meme prix, toujours. */
  const d = doc(), c = defi();
  assert.strictEqual(payInfo(d).price.amountMicro, c.body.accepts[0].amount,
    'micro cote document == micro cote defi');
  assert.strictEqual(payInfo(d).price.amount, T.microToUsd(c.body.accepts[0].amount),
    'et le decimal est rendu DEPUIS le micro, jamais recalcule');
});

t('l en-tete MPP porte le meme prix que le corps', () => {
  const c = defi();
  assert.match(c.headers['www-authenticate'], /amount="0\.25"/);
  assert.strictEqual(c.body.accepts[0].amount, '250000', '0.25 USD = 250000 micro-USDC');
});

t('une ECRITURE non canonique du prix est normalisee, pas recopiee', () => {
  /* Ajoute apres une mutation qui ne mordait pas: remettre `String(priceUsd)` dans l en-tete au lieu de
   * `microToUsd(micro)` passait tous les tests, parce que '0.25' s ecrit pareil des deux facons. Il faut
   * une ecriture equivalente mais differente pour que la propriete s exerce.
   *
   * L enjeu n est pas cosmetique: un client qui compare l en-tete au corps doit voir UN prix, pas deux
   * orthographes du meme, sans quoi il doit deviner laquelle fait foi. */
  const c = challenge402({ origin: ORIGIN, merchant: MARCHAND, priceUsd: '0.250000' });
  assert.strictEqual(c.body.accepts[0].amount, '250000');
  assert.match(c.headers['www-authenticate'], /amount="0\.25"/,
    'l en-tete doit rendre la forme canonique issue du micro, pas la chaine fournie');
  assert.ok(!/0\.250000/.test(c.headers['www-authenticate']));
});

t('le prix par defaut vient de l environnement, lu a CHAQUE appel', () => {
  /* Fige au chargement du module, un changement de prix n aurait pris effet qu au redemarrage — et le
   * document publie aurait menti jusque-la. */
  const avant = process.env.BIII_VET_PRICE_USD;
  try {
    process.env.BIII_VET_PRICE_USD = '0.50';
    assert.strictEqual(defi({ priceUsd: undefined }).body.accepts[0].amount, '500000');
    process.env.BIII_VET_PRICE_USD = '0.10';
    assert.strictEqual(defi({ priceUsd: undefined }).body.accepts[0].amount, '100000');
  } finally {
    if (avant === undefined) delete process.env.BIII_VET_PRICE_USD; else process.env.BIII_VET_PRICE_USD = avant;
  }
});

/* ── (B) le destinataire ─────────────────────────────────────────────────────────────────────────── */

t('★ pas de defi de paiement SANS destinataire', () => {
  for (const m of [undefined, null, '', '0xnope', '0x' + 'a'.repeat(39), '0x' + 'a'.repeat(41)]) {
    assert.throws(() => challenge402({ origin: ORIGIN, merchant: m, priceUsd: '0.25' }),
      /valid merchant address/i, 'marchand ' + JSON.stringify(String(m)));
  }
});

t('une adresse en casse mixte est acceptee et normalisee', () => {
  const c = challenge402({ origin: ORIGIN, merchant: MARCHAND.toUpperCase().replace('0X', '0x'), priceUsd: '0.25' });
  assert.strictEqual(c.body.accepts[0].payTo, MARCHAND.toLowerCase());
});

t('le defi nomme le bon actif et le bon reseau', () => {
  const a = defi().body.accepts[0];
  assert.strictEqual(a.asset, T.USDC_BASE, 'l actif doit etre l USDC de Base, pas une autre adresse');
  assert.strictEqual(a.network, 'base');
  assert.strictEqual(a.scheme, 'exact');
  assert.ok(a.maxTimeoutSeconds > 0);
  assert.strictEqual(defi().body.x402Version, 1);
});

t('la ressource du defi porte l origine reelle', () => {
  assert.strictEqual(defi().body.accepts[0].resource, ORIGIN + '/x402');
});

/* ── (C) le document, et sa concordance avec le code ─────────────────────────────────────────────── */

t('les trois operations payantes portent toutes un prix et un 402', () => {
  const d = doc();
  const chemins = Object.keys(d.paths);
  assert.deepStrictEqual(chemins.sort(), ['/x402/vet-address', '/x402/vet-asset', '/x402/vet-meme']);
  for (const p of chemins) {
    assert.ok(d.paths[p].post['x-payment-info'], p + ' doit annoncer son prix');
    assert.ok(d.paths[p].post.responses[402], p + ' doit annoncer le defi 402');
  }
});

t('★ le schema chainId publie accepte les formes que le CODE accepte reellement', () => {
  /* Contrat entre le document et l implementation. Le document annoncait `type:'number'` avec 8453 en
   * exemple, c est-a-dire exactement la forme qui, avant correction, ecartait tous les candidats. Ici on
   * ne relit pas le texte du schema: on verifie que chaque forme annoncee FILTRE vraiment. */
  const schema = doc().paths['/x402/vet-meme'].post.requestBody.content['application/json'].schema;
  const ch = schema.properties.chainId;
  assert.deepStrictEqual(ch.type, ['string', 'number'], 'les deux formes doivent etre annoncees');

  const paires = [
    { chainId: 'base', baseToken: { address: '0xB', symbol: 'X' }, liquidity: { usd: 10 } },
    { chainId: 'solana', baseToken: { address: '0xS', symbol: 'X' }, liquidity: { usd: 99 } },
  ];
  for (const forme of ['base', 8453, '8453']) {
    const c = candidatesFrom(paires, 'X', forme);
    assert.strictEqual(c.length, 1, 'forme ' + JSON.stringify(forme) + ': doit filtrer');
    assert.strictEqual(c[0].chain, 'base', 'forme ' + JSON.stringify(forme) + ': doit rendre du Base');
  }
});

t('la description de chainId ne promet plus le comportement qui effacait tout', () => {
  const ch = doc().paths['/x402/vet-meme'].post.requestBody.content['application/json'].schema.properties.chainId;
  assert.match(ch.description, /slug/i, 'la forme slug doit etre documentee');
  assert.match(ch.description, /NO candidates/i, 'et le fail-closed sur chaine inconnue doit etre dit');
});

t('★ tout champ DECLARE par une route payante doit etre LU par son handler', () => {
  /* ⛔ LE GATE NE PORTE PAS SUR UN CHAMP, IL PORTE SUR LA CLASSE. Deux fois maintenant, un champ a ete
   * cable dans `bin/biii-mcp.js` et RATE dans `lib/server.js`, sur la MEME route payante: `chainId` le
   * 2026-07-27 (un contrat Solana certifie « genuine » a un client qui avait demande Base et paye pour
   * la reponse), puis `siblingCount` le 2026-08-09 — la retenue de `observedRisk` restait alors
   * INCONTOURNABLE pour qui PAIE, tandis que la route MCP gratuite la levait. Le palier payant
   * delivrait strictement moins que le gratuit.
   *
   * ⚠️ C'est une verification de SOURCE, et elle le dit: elle prouve que le handler NOMME le champ, pas
   * qu'il en fait le bon usage. C'est deliberement le maillon faible qu'elle couvre — l'oubli pur —
   * parce que c'est celui qui s'est produit, deux fois. */
  /* ⚠️ LA LIMITE CONNUE, ECRITE PLUTOT QUE CONTOURNEE. Ce gate exige la forme `b.<champ>` dans le
   * dispatch. Une route qui passerait le corps ENTIER a une lentille (`unLens(b)`) le ferait donc
   * echouer A TORT — c'est exactement ce qui est arrive a une sonde jumelle le 2026-08-10, qui a
   * accuse `till_resolve` d'ignorer sept champs de signature alors que son handler fait
   * `bindingLens(a, …)` et que `lib/identity.js` les lit (19, 16, 6 occurrences).
   *
   * ⛔ ET ELARGIR LA RECHERCHE AUX MODULES `lib/` NE REPARE RIEN — essaye et mesure le meme jour: les
   * lentilles n'emploient pas le prefixe `b.`, donc le champ reste introuvable et le gate crie pareil.
   * Le seul elargissement qui marcherait chercherait l'identifiant NU, et `address` ou `symbol` se
   * trouvent partout: on echangerait un faux positif contre un faux negatif silencieux, ce qui est pire.
   *
   * La conduite a tenir le jour ou ca arrive: EXEMPTER cette route explicitement, en nommant la
   * lentille qui consomme le corps. Une exemption se lit; un gate elargi se croit. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  const d = doc();
  let vus = 0;
  for (const [route, noeud] of Object.entries(d.paths)) {
    const sch = noeud.post.requestBody.content['application/json'].schema;
    for (const champ of Object.keys(sch.properties || {})) {
      vus++;
      assert.ok(src.includes('b.' + champ),
        route + ' declare `' + champ + '` mais lib/server.js ne le lit jamais — un champ documente que '
        + 'le handler ignore est une promesse que le client payant ne peut pas encaisser');
    }
  }
  /* ⛔ Un gate qui n'a RIEN examine passe en vert: il compte ce qu'il a inspecte. */
  assert.ok(vus >= 6, 'le gate doit avoir inspecte des champs, pas zero: ' + vus);
});

t('le document ne publie PAS l adresse du marchand', () => {
  /* buildOpenApi recoit `merchant` et ne s en sert pas — c est correct, le payTo appartient au defi 402
   * qui se negocie par appel. On l epingle pour qu un ajout distrait ne le fasse pas fuir dans un
   * document mis en cache par des annuaires tiers. */
  const brut = JSON.stringify(doc());
  assert.ok(!brut.toLowerCase().includes(MARCHAND.toLowerCase()),
    'l adresse du marchand n a rien a faire dans le document de decouverte');
});

t('l origine se retrouve dans servers[], et son absence n invente rien', () => {
  assert.deepStrictEqual(doc().servers, [{ url: ORIGIN }]);
  assert.strictEqual(buildOpenApi({ priceUsd: '0.25' }).servers, undefined,
    'sans origine, pas de serveur invente');
});

t('la version d OpenAPI annoncee est celle qu AgentCash lit', () => {
  assert.strictEqual(doc().openapi, '3.1.0');
});

t('le contact par defaut existe, et un contact fourni le remplace', () => {
  assert.match(doc().info.contact.email, /@/);
  assert.strictEqual(doc({ contactEmail: 'a@b.co' }).info.contact.email, 'a@b.co');
});

t('la description dit fail-closed et non-custodial — pas de survente', () => {
  const info = doc().info;
  assert.match(info.description, /fail-closed/i);
  assert.match(info.description, /holds no key and moves no funds/i);
  assert.match(info['x-guidance'], /unknown is never "safe"/i);
  assert.ok(!/guarantee|100%|always safe/i.test(info.description + info['x-guidance']),
    'aucune promesse absolue dans un document que des agents lisent pour decider de payer');
});

(async () => {
  for (const [nom, fn] of files) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== files.length) {
    console.log('✗ ' + files.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
