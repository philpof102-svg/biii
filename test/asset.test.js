'use strict';
// BIII asset — tokenized-asset authenticity, composed into the trust triangle.
// Run: node test/asset.test.js
const assert = require('node:assert');
const { assessAsset, assetVertex } = require('../lib/asset');
const { assessTriangle } = require('../lib/trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// a synthetic verified-issuer registry (the LOGIC is what we test — real addresses come from issuer docs)
const BUIDL = '0x' + '11'.repeat(20);
const USDY  = '0x' + '22'.repeat(20);
const REGISTRY = [
  { issuer: 'BlackRock', symbol: 'BUIDL', name: 'BUIDL', chainId: 8453, address: BUIDL, source: 'official' },
  { issuer: 'Ondo', symbol: 'USDY', name: 'Ondo US Dollar Yield', chainId: 8453, address: USDY, source: 'official' },
];
const FAKE = '0x' + 'ff'.repeat(20);         // an impersonator / lookalike
const DENYLISTED = '0x' + 'ba'.repeat(20);

console.log('BIII asset — genuine vs impersonation, fail-closed, composed into the triangle:');

t('GENUINE: a verified issuer contract is genuine + safe to acquire', () => {
  const r = assessAsset({ token: BUIDL }, { registry: REGISTRY });
  assert.equal(r.status, 'genuine'); assert.equal(r.safeToAcquire, true);
  assert.equal(r.issuer, 'BlackRock'); assert.equal(r.symbol, 'BUIDL');
});

t('PROVENANCE: the green is calibrated to the source — issuer-official vs aggregator vs seed', () => {
  const off = assessAsset({ token: BUIDL }, { registry: [{ issuer: 'BlackRock', symbol: 'BUIDL', address: BUIDL, source: 'issuer:securitize.io official' }] });
  assert.equal(off.provenance, 'issuer-official');
  assert.equal(assetVertex(off).score, 80, 'issuer-official scores full');
  assert.match(assetVertex(off).note, /issuer-verified/);

  const agg = assessAsset({ token: BUIDL }, { registry: [{ issuer: 'BlackRock', symbol: 'BUIDL', address: BUIDL, source: 'coingecko:tokenized-treasuries' }] });
  assert.equal(agg.provenance, 'aggregator', 'a Coingecko listing is the WEAKER aggregator provenance');
  assert.equal(assetVertex(agg).score, 55, 'aggregator scores lower — not the same as issuer-verified');
  assert.match(assetVertex(agg).note, /not issuer-verified/);

  const seed = assessAsset({ token: BUIDL }, { registry: [{ issuer: 'BlackRock', symbol: 'BUIDL', address: BUIDL, source: 'BlackRock official — RE-VERIFY at securitize.io' }] });
  assert.equal(seed.provenance, 'seed', 'a RE-VERIFY example is not yet authoritative');

  // FAIL-SAFE: an unrecognized/empty source is the WEAKER aggregator, NEVER issuer-official (no over-stating)
  const blank = assessAsset({ token: BUIDL }, { registry: [{ issuer: 'X', symbol: 'X', address: BUIDL, source: '' }] });
  assert.equal(blank.provenance, 'aggregator');
});

t('IMPERSONATION (claim mismatch): a real contract labelled as the WRONG asset is refused', () => {
  const r = assessAsset({ token: BUIDL, claimedSymbol: 'AAPLx' }, { registry: REGISTRY });
  assert.equal(r.status, 'impersonation'); assert.equal(r.safeToAcquire, false);
  assert.match(r.reason, /BUIDL, not AAPLx/);
});

t('IMPERSONATION (the FBI lookalike): an unknown address CLAIMING to be BUIDL points back to the genuine one', () => {
  const r = assessAsset({ token: FAKE, claimedSymbol: 'BUIDL' }, { registry: REGISTRY });
  assert.equal(r.status, 'impersonation'); assert.equal(r.safeToAcquire, false);
  assert.equal(r.genuineAddress, BUIDL, 'names the real contract so a human/agent can compare');
  assert.match(r.reason, /genuine BlackRock BUIDL is/);
});

t('UNSAFE: a denylisted contract overrides everything (scam / known-bad)', () => {
  const r = assessAsset({ token: DENYLISTED, claimedSymbol: 'BUIDL' }, { registry: REGISTRY, denylist: new Set([DENYLISTED]) });
  assert.equal(r.status, 'unsafe'); assert.equal(r.safeToAcquire, false);
});

t('UNKNOWN (fail-closed): an unlabelled unknown contract is NOT genuine — unverified', () => {
  const r = assessAsset({ token: FAKE }, { registry: REGISTRY });
  assert.equal(r.status, 'unknown'); assert.equal(r.safeToAcquire, false);
});

t('INVALID: garbage in → invalid, never safe', () => {
  assert.equal(assessAsset({ token: 'not-an-address' }, { registry: REGISTRY }).safeToAcquire, false);
  assert.equal(assessAsset({ token: 'not-an-address' }, { registry: REGISTRY }).status, 'invalid');
});

t('COMPOSES into the trust triangle: a genuine asset + a settled payment → the whole trade is trusted/settled', () => {
  const asset = assessAsset({ token: BUIDL }, { registry: REGISTRY });
  const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };
  const tri = assessTriangle({ reputation: assetVertex(asset), settlement: PAID });
  assert.equal(tri.trust, 'settled');           // genuine token + real on-chain settlement
  assert.equal(tri.payable, true);
});

t('COMPOSES: an impersonation asset flags the whole trade UNSAFE even if a payment settled', () => {
  const asset = assessAsset({ token: FAKE, claimedSymbol: 'BUIDL' }, { registry: REGISTRY });
  const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };
  const tri = assessTriangle({ reputation: assetVertex(asset), settlement: PAID });
  assert.equal(tri.trust, 'unsafe');            // buying a fake and "paying" for it is still unsafe
  assert.equal(tri.payable, false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
