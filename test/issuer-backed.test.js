'use strict';
// Backed issuer ingest — the PURE core (buildFromBacked) turns Backed's official API response into
// issuer-official entries, fail-safe on unknown chains / bad addresses. Offline. Run: node test/issuer-backed.test.js
const assert = require('node:assert');
const { buildFromBacked } = require('../scripts/biii-issuer-backed');
const { assessAsset } = require('../lib/asset');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const A = '0x' + '1a'.repeat(20), B = '0x' + '2b'.repeat(20);
const api = { nodes: [
  { symbol: 'TSLAx', name: 'Tesla', deployments: [
    { network: 'Arbitrum', address: A }, { network: 'Ethereum', address: B },
    { network: 'Solana', address: 'XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU' },   // non-EVM → dropped
    { network: 'UnknownChain', address: '0x' + '3c'.repeat(20) },                      // unknown → dropped
    { network: 'Ethereum', address: 'not-an-address' },                                // bad addr → dropped
  ] },
] };

console.log('BIII Backed issuer ingest (pure, fail-safe):');

t('EVM deployments become issuer-official entries with the RIGHT chainId (never forced to Base)', () => {
  const reg = buildFromBacked(api);
  assert.equal(reg.length, 2, 'only the 2 known-EVM deployments; Solana/unknown/bad dropped');
  const arb = reg.find((e) => e.address === A);
  assert.equal(arb.chainId, 42161, 'Arbitrum → 42161, not Base');
  assert.equal(reg.find((e) => e.address === B).chainId, 1, 'Ethereum → 1');
  assert.equal(arb.issuer, 'Backed (xStocks)');
  assert.match(arb.source, /api\.backed\.fi.*official/i);
});

t('FAIL-SAFE: unknown network / non-0x address are dropped (never a wrong chainId, never a bad address)', () => {
  const reg = buildFromBacked(api);
  assert.ok(!reg.some((e) => e.address === '0x' + '3c'.repeat(20)), 'unknown chain dropped');
  assert.ok(!reg.some((e) => !/^0x[0-9a-f]{40}$/.test(e.address)), 'no malformed address admitted');
  assert.doesNotThrow(() => buildFromBacked(null));
  assert.deepEqual(buildFromBacked({ nodes: 'x' }), []);
});

t('COMPOSES with assessAsset: a Backed entry reads genuine + issuer-official (green) on its own chain', () => {
  const reg = buildFromBacked(api);
  const v = assessAsset({ token: A }, { registry: reg });
  assert.equal(v.status, 'genuine');
  assert.equal(v.provenance, 'issuer-official');
  assert.equal(v.chainId, 42161, 'the verdict carries the asset\'s real chain');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
