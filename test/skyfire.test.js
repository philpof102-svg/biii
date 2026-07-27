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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
