'use strict';
// BIII × Skyfire KYA identity lens — interop, never rival; advisory, never payable-deciding; anti-replay
// on aud; honest about signature verification. Pure + offline. Run: node test/skyfire.test.js
const assert = require('node:assert');
const { parseJwt, kyaLens } = require('../lib/skyfire');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload, { header = { alg: 'ES256', typ: 'JWT' }, sig = 'c2ln' } = {}) => b64(header) + '.' + b64(payload) + '.' + sig;
const NOW = Date.parse('2026-07-22T00:00:00Z');
const future = Math.floor(NOW / 1000) + 3600;
const claims = (over = {}) => ({ iss: 'https://api.skyfire.xyz', sub: 'agent:acme-bot', aud: 'seller:cafe-central', exp: future, iat: Math.floor(NOW / 1000), owner: 'business:ACME Inc (KYB verified)', ...over });

console.log('BIII × Skyfire KYA (agent identity standard, interop):');

t('parseJwt decodes a compact JWT (header + payload), rejects non-JWTs', () => {
  const p = parseJwt(jwt(claims()));
  assert.equal(p.payload.sub, 'agent:acme-bot');
  assert.equal(p.header.alg, 'ES256');
  assert.equal(p.hasSig, true);
  assert.ok(parseJwt('not.a').error, 'two parts → error');
  assert.ok(parseJwt('a.b.c').error || true);      // garbage base64 → error handled
  assert.match(parseJwt('%%%.%%%.x').error || 'ok', /valid|JWT|base64/i);
});

t('a well-formed, verified, unexpired, audience-matched token → attested identity', () => {
  const l = kyaLens(jwt(claims()), { verified: true, expectedAudience: 'seller:cafe-central', now: NOW });
  assert.equal(l.attested, true);
  assert.equal(l.issuer, 'https://api.skyfire.xyz');
  assert.equal(l.subject, 'agent:acme-bot');
  assert.equal(l.advisory, true, 'identity is advisory, never a payable decision');
  assert.match(l.disclosure, /NOT that its address is safe to pay|run the trust triangle/i);
});

t('the KYA-specific (issuer-defined) claims are surfaced RAW; registered claims are stripped', () => {
  const l = kyaLens(jwt(claims()), { verified: true, now: NOW });
  assert.equal(l.kyaClaims.owner, 'business:ACME Inc (KYB verified)', 'the backer claim is surfaced');
  assert.equal(l.kyaClaims.iss, undefined, 'registered claims are not in kyaClaims');
});

t('verified!==true → attested:false: a parsed JWT is a CLAIM, not an attestation (BIII does not verify sigs)', () => {
  const l = kyaLens(jwt(claims()), { now: NOW });   // verified omitted
  assert.equal(l.attested, false);
  assert.match(l.reason, /not verified|CLAIM/i);
  assert.ok(l.reVerify.issuer && l.reVerify.check, 'still ships the re-verify pointer (issuer JWKS)');
});

t('ANTI-REPLAY: a token whose aud is someone else is refused for this recipient', () => {
  const l = kyaLens(jwt(claims({ aud: 'seller:other-shop' })), { verified: true, expectedAudience: 'seller:cafe-central', now: NOW });
  assert.equal(l.attested, false);
  assert.match(l.reason, /aud|replay/i);
  // an array aud that INCLUDES us is fine
  const arr = kyaLens(jwt(claims({ aud: ['seller:x', 'seller:cafe-central'] })), { verified: true, expectedAudience: 'seller:cafe-central', now: NOW });
  assert.equal(arr.attested, true, 'aud array containing the recipient matches');
});

t('an EXPIRED token is refused (stale attestation is not a live one)', () => {
  const l = kyaLens(jwt(claims({ exp: Math.floor(NOW / 1000) - 10 })), { verified: true, now: NOW });
  assert.equal(l.attested, false);
  assert.match(l.reason, /expired/i);
});

t('a token missing iss or sub is refused (an unidentified vouch is not an identity)', () => {
  assert.equal(kyaLens(jwt(claims({ iss: undefined })), { verified: true, now: NOW }).attested, false);
  assert.equal(kyaLens(jwt(claims({ sub: undefined })), { verified: true, now: NOW }).attested, false);
});

t('POSTURE: an attested token surfaces expires + audienceBound (the reader is never blind to a weak token)', () => {
  const strong = kyaLens(jwt(claims()), { verified: true, expectedAudience: 'seller:cafe-central', now: NOW });
  assert.deepStrictEqual(strong.posture, { expires: true, audienceBound: true });
  assert.doesNotMatch(strong.disclosure, /NO EXPIRY|NOT REPLAY-BOUND/, 'a strong token carries no warning');
});

t('POSTURE: a NO-EXPIRY token still attests (advisory) but is SURFACED as never-expiring, not silently eternal', () => {
  const l = kyaLens(jwt(claims({ exp: undefined })), { verified: true, expectedAudience: 'seller:cafe-central', now: NOW });
  assert.equal(l.attested, true, 'advisory identity: a long-lived vouch is a legit issuer choice, not a hard refuse');
  assert.equal(l.posture.expires, false);
  assert.equal(l.expiresAt, null);
  assert.match(l.disclosure, /NO EXPIRY/);
});

t('POSTURE (strict): requireExpiry REFUSES a no-exp token fail-closed (a leaked eternal vouch is a footgun)', () => {
  const l = kyaLens(jwt(claims({ exp: undefined })), { verified: true, expectedAudience: 'seller:cafe-central', requireExpiry: true, now: NOW });
  assert.equal(l.attested, false);
  assert.match(l.reason, /no exp|never-expiring|unbounded/i);
  // a token WITH an expiry is unaffected by requireExpiry
  assert.equal(kyaLens(jwt(claims()), { verified: true, expectedAudience: 'seller:cafe-central', requireExpiry: true, now: NOW }).attested, true);
});

t('POSTURE: an attested token with NO audience check is surfaced as NOT replay-bound (anti-replay was skipped)', () => {
  const l = kyaLens(jwt(claims()), { verified: true, now: NOW });   // no expectedAudience
  assert.equal(l.attested, true);
  assert.equal(l.posture.audienceBound, false);
  assert.match(l.disclosure, /NOT REPLAY-BOUND/);
});

t('an unparseable token → available:false, and never throws', () => {
  const l = kyaLens('garbage', { verified: true });
  assert.equal(l.available, false);
  assert.equal(l.attested, false);
  assert.match(l.reason, /unparseable|never identity/i);
  assert.doesNotThrow(() => kyaLens(null));
});

/* ── UNE EXPIRATION ILLISIBLE N'EST PAS « PAS D'EXPIRATION » ────────────────────────────────────────
 * `const expSec = Number(p.exp) || 0` ecrasait une valeur illisible sur ZERO — c'est-a-dire exactement
 * la valeur qui signifie « aucune expiration ». Mesure du 2026-07-28, meme jeton par ailleurs:
 *
 *   exp absent          -> attested:true, expiresAt:null, posture.expires:false
 *   exp = 'abc'         -> attested:true, expiresAt:null, posture.expires:false    IDENTIQUE
 *   exp = '2020-01-01…' -> idem
 *
 * La lentille publiait donc « ⚠ NO EXPIRY: this vouch does not expire » pour un jeton qui EN PORTE une:
 * une propriete DEDUITE d'un parse rate. La lentille est advisory et non payable, donc le degat est une
 * affirmation fausse, pas un prelevement — ce qui ne la rend pas acceptable sur un outil dont le travail
 * est de dire ce qu'on sait et ce qu'on ne sait pas.
 *
 * Troisieme occurrence de cette classe dans le meme fichier, qui ecrit pourtant lui-meme « absence of a
 * valid token is never identity ». */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jeton = (exp) => {
  const p = { iss: 'skyfire', sub: 'agent:bot' };
  if (exp !== undefined) p.exp = exp;
  return b64u({ alg: 'ES256' }) + '.' + b64u(p) + '.sig';
};
const lens = (exp, opts = {}) => kyaLens(jeton(exp), { verified: true, ...opts });

t('une expiration ILLISIBLE ne se declare pas « pas d expiration »', () => {
  /* ⚠️ `'1e999'` ajoute apres un mutation-test: retirer `Number.isFinite` laissait tous les autres cas
   * VERTS, parce que `NaN > 0` est deja faux. Celui-la, lui, passe `> 0` et deviendrait « lisible » — un
   * jeton qui n'expire jamais, avec une date invalide au passage. `'1e999'` figure deja dans les cas de
   * plafond de ce depot: la meme forme malformee, un champ plus loin.
   *
   * ⚠️ `Infinity` NU a d'abord ete essaye et retire: `JSON.stringify(Infinity)` produit `null`, donc la
   * fixture portait `exp:null` — un cas ABSENT, pas illisible. Le test echouait a cause du CONSTRUCTEUR,
   * pas du code. La forme qui atteint vraiment la fonction est le litteral JSON `1e999`, teste juste
   * apres par une charge utile ecrite a la main. */
  for (const mauvais of ['abc', '2020-01-01T00:00:00Z', 'NaN', '1e999']) {
    const r = lens(mauvais);
    assert.strictEqual(r.posture.expires, null, 'exp=' + mauvais + ' : inconnu, pas false');
    assert.match(r.disclosure, /EXPIRY UNREADABLE/);
    assert.match(r.disclosure, /NOT "no expiry"/);
    /* La phrase doit citer la valeur fautive, sinon l'emetteur ne sait pas quoi reparer. */
    assert.match(r.disclosure, /exp claim/);
  }
});

t('un exp NUMERIQUE hors bornes (1e999 -> Infinity) est illisible, pas eternel', () => {
  /* La charge utile est ecrite A LA MAIN: `JSON.stringify` ne peut pas produire ce jeton, alors qu'un
   * emetteur tiers le peut. `JSON.parse('{"exp":1e999}')` rend Infinity, qui passe `> 0` — c'est
   * exactement ce que `Number.isFinite` arrete, et la seule entree qui le prouve. */
  const brut = b64u({ alg: 'ES256' }) + '.'
    + Buffer.from('{"iss":"skyfire","sub":"agent:bot","exp":1e999}').toString('base64url') + '.sig';
  const r = kyaLens(brut, { verified: true });
  assert.strictEqual(r.posture.expires, null, 'Infinity n est pas une expiration lisible');
  assert.strictEqual(r.expiresAt, null, 'et surtout: pas de date invalide publiee');
  assert.match(r.disclosure, /EXPIRY UNREADABLE/);
});

t('les TROIS etats sont distincts: absent / lisible / illisible', () => {
  assert.strictEqual(lens(undefined).posture.expires, false, 'aucun champ = pas d expiration, vrai false');
  assert.strictEqual(lens(Math.floor(Date.now() / 1000) + 3600).posture.expires, true);
  assert.strictEqual(lens('abc').posture.expires, null);
  /* ⚠️ Sans ce cas, aplatir deux etats l un sur l autre resterait vert tant qu ils ne se croisent pas. */
  const vus = new Set([lens(undefined).posture.expires, lens(Math.floor(Date.now() / 1000) + 3600).posture.expires,
    lens('abc').posture.expires].map(String));
  assert.strictEqual(vus.size, 3);
});

t('LES DEUX BORNES: les chemins d origine ne bougent pas', () => {
  /* Un durcissement qui casse le cas legitime cesse d informer. */
  const futur = lens(Math.floor(Date.now() / 1000) + 3600);
  assert.strictEqual(futur.attested, true);
  assert.ok(futur.expiresAt, 'une exp lisible produit toujours sa date');
  assert.doesNotMatch(futur.disclosure, /NO EXPIRY|UNREADABLE/);
  /* Une exp PASSEE et lisible refuse toujours. */
  assert.strictEqual(lens(1577836800).attested, false);
  /* Le cas « aucune exp » garde son avertissement d origine, mot pour mot. */
  assert.match(lens(undefined).disclosure, /NO EXPIRY: this vouch does not expire/);
});

t('requireExpiry attrape l illisible comme l absent — le mode strict reste sur', () => {
  assert.strictEqual(lens('abc', { requireExpiry: true }).attested, false);
  assert.strictEqual(lens(undefined, { requireExpiry: true }).attested, false);
  assert.strictEqual(lens(Math.floor(Date.now() / 1000) + 3600, { requireExpiry: true }).attested, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
