'use strict';
// BIII identity bridge — npub ↔ Base, trustless + fail-closed. The glue between a buzz agent identity and
// a payable, trust-assessable Base address. Pure + offline. Run: node test/identity.test.js
const assert = require('node:assert');
const { bindingMessage, bindingLens, BASE_CHAIN_ID } = require('../lib/identity');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const NPUB = 'a'.repeat(64);                 // 64-hex secp256k1 pubkey (what buzz signs with)
const DID = 'did:key:z6Mku6pui7L9SVTNP7eXFgn4ni7qnRjX2G4p9FEtE7v2dxYk';   // gitlawb Ed25519 identity
const ADDR = '0x' + 'b'.repeat(40);
const ok = (over = {}) => ({ npub: NPUB, address: ADDR, nonce: 'deadbeef', chainId: 8453, expiry: 0,
  sigNostr: '0x' + '1'.repeat(128), sigBase: '0x' + '2'.repeat(130), verified: true, ...over });
const okDid = (over = {}) => ({ did: DID, address: ADDR, nonce: 'deadbeef', chainId: 8453, expiry: 0,
  sigDid: '0x' + '3'.repeat(128), sigBase: '0x' + '2'.repeat(130), verified: true, ...over });   // gitlawb-only

console.log('BIII identity bridge (npub/did ↔ Base, trustless + fail-closed):');

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

t('a ONE-SIDED binding (missing a signature) is refused — each key + the Base key must sign', () => {
  assert.equal(bindingLens(ok({ sigBase: null })).bound, false);
  assert.match(bindingLens(ok({ sigBase: null })).reason, /base signature|bidirectional/i);
  assert.equal(bindingLens(ok({ sigNostr: null })).bound, false);
  assert.match(bindingLens(ok({ sigNostr: null })).reason, /without its Nostr signature/i);
});

t('malformed identity is refused fail-closed (bad npub / bad address / bad did)', () => {
  assert.equal(bindingLens(ok({ npub: 'xyz' })).bound, false, 'npub must be 64-hex');
  assert.equal(bindingLens(ok({ address: '0x123' })).bound, false, 'address must be 0x+40hex');
  assert.equal(bindingLens(ok({ did: 'not-a-did' })).bound, false, 'a present did must be a valid did: URI');
});

// ── gitlawb DIDs are first-class: the bridge binds an npub (buzz) OR a did:key (gitlawb) OR both ──
t('a gitlawb DID-only binding (no npub) → bound (did:key ↔ Base) — the gitlawb agent resolves to a payable address', () => {
  const r = bindingLens(okDid());
  assert.equal(r.bound, true);
  assert.equal(r.identities.did, DID);
  assert.equal(r.identities.npub, null);
  assert.match(r.reason, /did ↔ Base|did/i);
});

t('a DUAL binding (npub + did both signed) → bound, both identities surfaced', () => {
  const r = bindingLens(ok({ did: DID, sigDid: '0x' + '3'.repeat(128) }));
  assert.equal(r.bound, true);
  assert.equal(r.identities.npub, NPUB);
  assert.equal(r.identities.did, DID);
});

t('an identity present WITHOUT its own signature is refused (each key signs)', () => {
  assert.equal(bindingLens(ok({ did: DID })).bound, false, 'did added but no sigDid → refuse');
  assert.match(bindingLens(ok({ did: DID })).reason, /did.*without its DID/i);
  assert.equal(bindingLens(okDid({ sigDid: null })).bound, false, 'did-only with no sigDid → refuse');
});

t('NO identity key at all (only an address + Base sig) is refused — a binding needs npub or did', () => {
  const r = bindingLens({ address: ADDR, nonce: 'n', sigBase: '0x' + '2'.repeat(130), verified: true });
  assert.equal(r.bound, false);
  assert.match(r.reason, /no identity key|npub.*or.*did/i);
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * L'UNITÉ DE `expiry` ÉCHOUAIT OUVERT — et l'erreur qui l'a révélée était dans MA sonde.
 *
 * Le champ est en secondes unix (le schéma MCP le dit) et `bindingLens` multiplie par 1000. J'ai testé
 * en passant `Date.now()`, donc des millisecondes, et j'ai cru un instant que l'expiration n'était pas
 * contrôlée du tout. Elle l'était. Mais la mesure a laissé un fait qui compte, sur une attestation
 * complète et `verified:true` :
 *
 *   expiry en secondes,      passé  ->  bound=false   ✓
 *   expiry en MILLISECONDES, passé  ->  bound=true    ⛔   ← MÊME instant, autre unité
 *
 * `Date.now()` est le geste naturel en JavaScript. Écrit ainsi, ~1,7e12 × 1000 tombe ~50 000 ans en
 * avant : la liaison ne peut PLUS JAMAIS expirer, et une liaison périmée résout vers une adresse de
 * paiement comme si elle était vivante. Une erreur d'unité plausible sur un champ de sécurité ne doit
 * pas accorder PLUS que le champ correct.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const SEC = () => Math.floor(Date.now() / 1000);
const complet = (expiry) => ({ npub: NPUB, address: '0x' + '1'.repeat(40), nonce: 'n1',
  sigNostr: 's'.repeat(128), sigBase: '0x' + 'b'.repeat(130), verified: true, expiry });

t('★ un expiry en MILLISECONDES est REFUSÉ, pas accordé pour l\'éternité', () => {
  const r = bindingLens(complet(Date.now() - 3600000));      // passé, mais en ms
  assert.strictEqual(r.bound, false, 'un instant PASSÉ ne peut pas devenir une liaison vivante');
  assert.match(r.reason, /not unix SECONDS|milliseconds/i, 'la raison doit nommer l\'unité');
});

t('★ et dans le futur non plus — l\'unité fausse ne passe dans aucun sens', () => {
  assert.strictEqual(bindingLens(complet(Date.now() + 3600000)).bound, false);
});

t('★ LES DEUX BORNES: en SECONDES, le passé expire et le futur lie', () => {
  const passe = bindingLens(complet(SEC() - 3600));
  assert.strictEqual(passe.bound, false);
  assert.match(passe.reason, /expired/i, 'et il expire pour la BONNE raison, pas pour l\'unité');
  // sans cette borne, « refuser tout expiry » satisferait les deux cas ci-dessus
  assert.strictEqual(bindingLens(complet(SEC() + 3600)).bound, true, 'un futur en secondes DOIT lier');
});

t('★ `expiry: 0` garde son sens — pas d\'expiration, pas une unité fausse', () => {
  assert.strictEqual(bindingLens(complet(0)).bound, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
