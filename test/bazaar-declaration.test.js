'use strict';
/* bazaar-declaration.test.js — la declaration qui rend BIII catalogable.
 * Run: node test/bazaar-declaration.test.js
 *
 * Ce que ces cas protegent, et pourquoi ils existent : le 2026-08-15, une mesure
 * du catalogue reel du facilitateur CDP (1200 ressources, 2119 entrees
 * `accepts` — c'est ce catalogue qu'agentic.market indexe) a montre que BIII n'y
 * figure pas, et surtout POURQUOI. Deux defauts, dont un qui depasse le listing :
 *
 *   1. `extra: {name, version}` absent. C'est le domaine EIP-712 de l'USDC ;
 *      sans lui un client x402 standard ne peut pas signer une autorisation
 *      EIP-3009. Present sur 1659/1665 des entrees EVM du catalogue (99,6 %).
 *      Son absence rendait BIII impayable par un client generique — un defaut
 *      d'interoperabilite, pas un detail de vitrine.
 *   2. `network: "base"` au lieu du CAIP-2 `"eip155:8453"` : 7 entrees sur 2119
 *      utilisent la forme de BIII.
 *
 * Le gabarit vise n'est pas deduit de la doc mais releve sur un service
 * REELLEMENT catalogue (Tavily) : en-tete `payment-required` = base64 d'un JSON
 * `{x402Version: 2, error, resource, accepts, extensions}`, corps minimal.
 *
 * La regle non negociable ici : la v2 s'AJOUTE, elle ne remplace pas. Le corps
 * v1 doit rester byte-compatible pour les clients existants.
 */
const assert = require('node:assert');
const { challenge402, bazaarHeaderValue, BAZAAR_ROUTES } = require('../lib/openapi.js');

let pass = 0, fail = 0;
const cas = [];
const t = (nom, fn) => cas.push([nom, fn]);

const MARCHAND = '0x1234567890abcdef1234567890abcdef12345678';
const ORIGIN = 'https://biii.example';
const defi = (o = {}) => challenge402({ origin: ORIGIN, merchant: MARCHAND, priceUsd: '0.25', ...o });
const declaration = (o = {}) => JSON.parse(Buffer.from(defi(o).headers['payment-required'], 'base64').toString('utf8'));

console.log('bazaar: la declaration s AJOUTE au defi v1, elle ne le remplace pas');

t('l en-tete payment-required est du base64 de JSON', () => {
  const brut = defi().headers['payment-required'];
  assert.ok(typeof brut === 'string' && brut.length > 0, 'en-tete absent');
  assert.doesNotMatch(brut, /[^A-Za-z0-9+/=]/, 'un en-tete HTTP ne doit pas porter de caractere hors base64');
  const j = JSON.parse(Buffer.from(brut, 'base64').toString('utf8'));
  assert.deepStrictEqual(Object.keys(j).sort(), ['accepts', 'error', 'extensions', 'resource', 'x402Version'],
    'la forme releve sur un service catalogue porte exactement ces cinq cles');
});

t('la declaration est en v2 avec `resource` en OBJET', () => {
  const j = declaration();
  assert.strictEqual(j.x402Version, 2);
  assert.strictEqual(typeof j.resource, 'object', 'en v2 `resource` est un objet, pas une chaine dans accepts[]');
  assert.ok(/^https?:\/\//.test(j.resource.url), 'une `resource.url` RELATIVE est rejetee au catalogage');
  assert.strictEqual(j.resource.mimeType, 'application/json');
});

t('`network` est en CAIP-2 dans la declaration', () => {
  // 100% du catalogue utilise CAIP-2 ; la forme "base" de BIII n apparait que
  // 7 fois sur 2119. Corrige ICI seulement — le corps v1 est un autre contrat.
  assert.strictEqual(declaration().accepts[0].network, 'eip155:8453');
});

t('`extra` porte le domaine EIP-712 de l USDC — sans lui, personne ne peut signer', () => {
  const a = declaration().accepts[0];
  assert.strictEqual(a.extra.name, 'USD Coin');
  assert.strictEqual(a.extra.version, '2');
});

t('`amount` reste en unites atomiques, en CHAINE', () => {
  const a = declaration().accepts[0];
  assert.strictEqual(typeof a.amount, 'string', 'un montant numerique perd la precision en JSON');
  assert.match(a.amount, /^\d+$/, 'pas de decimal, pas de signe : des unites atomiques');
  assert.strictEqual(a.amount, '250000', '0,25 USDC = 250000 unites a 6 decimales');
});

t('`asset` est une CHAINE, pas un objet', () => {
  assert.strictEqual(typeof declaration().accepts[0].asset, 'string');
});

t('l extension bazaar declare le type d entree ET de sortie', () => {
  // La spec liste « missing info.input.type / info.output.type » parmi les
  // causes de rejet les plus frequentes.
  const info = declaration().extensions.bazaar.info;
  assert.strictEqual(info.input.type, 'http');
  assert.strictEqual(info.input.method, 'POST');
  assert.strictEqual(info.input.bodyType, 'json');
  assert.strictEqual(info.output.type, 'json');
  assert.ok(info.input.body && typeof info.input.body === 'object', 'un exemple d entree est attendu');
  assert.ok(info.output.example && typeof info.output.example === 'object', 'un exemple de sortie est attendu');
});

t('chaque route declare SA propre ressource — le catalogue indexe par route', () => {
  for (const route of Object.keys(BAZAAR_ROUTES)) {
    const j = declaration({ route });
    assert.strictEqual(j.resource.url, ORIGIN + route, 'route ' + route);
  }
});

t('une route inconnue retombe sur une route qui EXISTE', () => {
  // Publier une URL qui ne repond pas est pire que ne rien publier : un agent
  // qui la paie n obtient rien.
  const j = declaration({ route: '/x402/route-qui-nexiste-pas' });
  assert.ok(Object.keys(BAZAAR_ROUTES).some((r) => j.resource.url === ORIGIN + r),
    'la ressource publiee doit pointer vers une route declaree');
});

t('aucune reference externe dans la declaration — garde SSRF/LFI (CWE-918)', () => {
  // La spec rejette tout `$ref`/`$id` qui n est pas un pointeur interne `#/...`.
  // Le plus sur est de n en produire aucun.
  const brut = JSON.stringify(declaration());
  assert.ok(!/"\$ref"/.test(brut), 'aucun $ref ne doit etre publie');
  assert.ok(!/"\$id"/.test(brut), 'aucun $id ne doit etre publie');
});

t('LE CAS QUI COMPTE : le corps v1 n a pas bouge de forme', () => {
  // Une declaration v2 qui casserait les clients v1 existants serait un recul,
  // pas un progres. Le corps garde sa version, sa forme, et son `network`.
  const { body } = defi();
  assert.strictEqual(body.x402Version, 1, 'le corps reste en v1');
  assert.strictEqual(body.error, 'payment required');
  assert.ok(Array.isArray(body.accepts) && body.accepts.length === 1);
  const a = body.accepts[0];
  assert.strictEqual(a.network, 'base', 'changer le network du CORPS est une rupture de contrat, decidee a part');
  assert.strictEqual(a.scheme, 'exact');
  assert.strictEqual(a.amount, '250000');
  assert.strictEqual(typeof a.resource, 'string', 'la forme v1 garde `resource` en chaine dans accepts[]');
});

t('`extra` est ajoute AUSSI au corps v1 — additif, et necessaire pour signer', () => {
  const a = defi().body.accepts[0];
  assert.strictEqual(a.extra.name, 'USD Coin');
  assert.strictEqual(a.extra.version, '2');
});

t('les en-tetes existants survivent', () => {
  const h = defi().headers;
  assert.match(h['www-authenticate'], /^MPP realm=/, 'le defi MPP existant ne doit pas disparaitre');
  assert.strictEqual(h['content-type'], 'application/json');
  assert.strictEqual(h['access-control-allow-origin'], '*');
});

t('un marchand invalide fait toujours JETER, en-tete ou pas', () => {
  // La garde existante ne doit pas etre contournee par le nouveau chemin.
  assert.throws(() => challenge402({ origin: ORIGIN, merchant: '', priceUsd: '0.25' }), /payTo|merchant/i);
  assert.throws(() => challenge402({ origin: ORIGIN, merchant: 'pas-une-adresse', priceUsd: '0.25' }), /payTo|merchant/i);
});

t('le payTo de la declaration est le MEME que celui du corps', () => {
  // Deux destinataires differents dans un meme defi, c est un piege a paiement.
  const d = defi();
  const j = JSON.parse(Buffer.from(d.headers['payment-required'], 'base64').toString('utf8'));
  assert.strictEqual(j.accepts[0].payTo, d.body.accepts[0].payTo);
  assert.strictEqual(j.accepts[0].payTo, MARCHAND.toLowerCase());
});

t('le prix de la declaration suit le prix demande', () => {
  const j = declaration({ priceUsd: '0.03' });
  assert.strictEqual(j.accepts[0].amount, '30000', 'un seul prix, une seule source');
});

(async () => {
  for (const [nom, fn] of cas) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== cas.length) {
    console.log('✗ ' + cas.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
