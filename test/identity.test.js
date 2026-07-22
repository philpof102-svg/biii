'use strict';
// BIII identity bridge — npub ↔ Base, trustless + fail-closed. The glue between a buzz agent identity and
// a payable, trust-assessable Base address. Pure + offline. Run: node test/identity.test.js
const assert = require('node:assert');
const { bindingMessage, bindingLens, BASE_CHAIN_ID } = require('../lib/identity');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const NPUB = 'a'.repeat(64);                 // 64-hex secp256k1 pubkey (what buzz signs with)
const ADDR = '0x' + 'b'.repeat(40);
const ok = (over = {}) => ({ npub: NPUB, address: ADDR, nonce: 'deadbeef', chainId: 8453, expiry: 0,
  sigNostr: '0x' + '1'.repeat(128), sigBase: '0x' + '2'.repeat(130), verified: true, ...over });

console.log('BIII identity bridge (npub ↔ Base, trustless + fail-closed):');

t('the canonical message is deterministic + versioned (both keys sign the SAME bytes)', () => {
  const m1 = bindingMessage({ npub: NPUB, address: ADDR, nonce: 'x', chainId: 8453 });
  const m2 = bindingMessage({ npub: NPUB.toUpperCase(), address: ADDR.toUpperCase(), nonce: 'x', chainId: 8453 });
  assert.equal(m1, m2, 'case-normalized → identical bytes to sign');
  assert.match(m1, /^BIII-IDENTITY-BINDING-v1\n/);
  assert.match(m1, /npub: /); assert.match(m1, /base: 0x/);
});

t('a fully-signed, verified, bidirectional binding → bound:true (resolve npub→address)', () => {
  const r = bindingLens(ok());
  assert.equal(r.bound, true);
  assert.equal(r.address, ADDR);
  assert.match(r.disclosure, /re-verify|does NOT make it safe/i, 'resolving is not trusting — still run the triangle');
});

t('verified!==true → bound:false: a claim is NOT a binding (BIII does not verify secp256k1 itself)', () => {
  const r = bindingLens(ok({ verified: false }));
  assert.equal(r.bound, false);
  assert.match(r.reason, /not verified|CLAIM/i);
  assert.ok(r.reVerify.message && r.reVerify.check, 'still ships the re-verify pointer + the exact message');
});

t('a ONE-SIDED binding (missing a signature) is refused — needs BOTH keys', () => {
  assert.equal(bindingLens(ok({ sigBase: null })).bound, false);
  assert.equal(bindingLens(ok({ sigNostr: null })).bound, false);
  assert.match(bindingLens(ok({ sigBase: null })).reason, /one-sided|both/i);
});

t('malformed identity is refused fail-closed (bad npub / bad address / bad did)', () => {
  assert.equal(bindingLens(ok({ npub: 'xyz' })).bound, false, 'npub must be 64-hex');
  assert.equal(bindingLens(ok({ address: '0x123' })).bound, false, 'address must be 0x+40hex');
  assert.equal(bindingLens(ok({ did: 'not-a-did' })).bound, false, 'a present did must be a valid did: URI');
  assert.equal(bindingLens(ok({ did: 'did:key:z6Mk123' })).bound, true, 'a valid did is accepted');
});

t('an un-nonced binding is refused (replay), and an expired binding is refused (staleness)', () => {
  assert.equal(bindingLens(ok({ nonce: '' })).bound, false);
  assert.match(bindingLens(ok({ nonce: '' })).reason, /nonce|replay/i);
  const expired = ok({ expiry: 1000 });   // unix 1000s = long past
  assert.equal(bindingLens(expired, { now: 2_000_000 * 1000 }).bound, false);
  assert.match(bindingLens(expired, { now: 2_000_000 * 1000 }).reason, /expired/i);
  // a future expiry is fine
  assert.equal(bindingLens(ok({ expiry: 9_999_999_999 }), { now: 1_000_000_000 * 1000 }).bound, true);
});

t('BASE_CHAIN_ID default is Base mainnet, and a wrong-typed attestation never throws', () => {
  assert.equal(BASE_CHAIN_ID, 8453);
  assert.equal(bindingLens(null).bound, false);
  assert.equal(bindingLens('nope').bound, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
