'use strict';
// prepare-buy — non-custodial, vetted, capped buy intent. Offline. Run: node test/prepare-buy.test.js
const assert = require('node:assert');
const { prepareBuy } = require('../lib/prepare-buy');
const { loadFloor } = require('../lib/vet');
const { loadAssetRegistry } = require('../lib/asset-registry');

const floor = loadFloor();
const registry = loadAssetRegistry().entries || [];
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII prepare-buy — non-custodial, vetted, capped (agent prepares, the operator wallet executes):');

const clean = '0x' + 'a1'.repeat(20);
const daapl = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';           // Dinari dAAPL (issuer-verified)
const knownBad = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';        // on the OFAC/known-bad floor

t('clean recipient + genuine token → ok: a capped EIP-681 intent, BIII signs nothing', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', maxUsd: '10', token: daapl, claimedIssuer: 'Dinari', registry, floor });
  assert.equal(r.ok, true);
  assert.match(r.intent.paymentURI, /^ethereum:.*@8453\/transfer\?address=.*uint256=5000000$/);
  assert.equal(r.intent.capUsd, 10);
  assert.equal(r.assetVerdict.status, 'genuine');
  assert.match(r.disclosure, /signs nothing/);
});

t('recipient is KNOWN-BAD → hard refuse, no intent offered', () => {
  const r = prepareBuy({ to: knownBad, amountUsd: '5', floor, registry });
  assert.equal(r.ok, false);
  assert.equal(r.recipientVerdict, 'known-bad');
  assert.ok(!r.intent, 'no intent is built for a known-bad recipient');
});

t('token is an IMPERSONATION (dAAPL claimed BlackRock) → hard refuse', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', token: daapl, claimedIssuer: 'BlackRock', registry, floor });
  assert.equal(r.ok, false);
  assert.equal(r.assetVerdict, 'impersonation');
});

t('over the cap → refuse (never prepare a buy above the cap)', () => {
  assert.equal(prepareBuy({ to: clean, amountUsd: '50', maxUsd: '10', floor, registry }).ok, false);
});

t('malformed recipient / non-positive amount → refuse', () => {
  assert.equal(prepareBuy({ to: 'nope', amountUsd: '5', floor }).ok, false);
  assert.equal(prepareBuy({ to: clean, amountUsd: '0', floor }).ok, false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
