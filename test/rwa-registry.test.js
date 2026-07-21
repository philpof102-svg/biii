'use strict';
// BIII RWA registry ingest — sources verified issuer contracts from RWA.xyz, fail-safe.
// Run: node test/rwa-registry.test.js
const assert = require('node:assert');
const { normalizeAssets, fetchRwaAssets, toChainId } = require('../scripts/biii-rwa-registry');
const { assessAsset } = require('../lib/asset');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const BUIDL_ETH = '0x' + '11'.repeat(20);
const BUIDL_BASE = '0x' + '22'.repeat(20);
const USDY_BASE = '0x' + '33'.repeat(20);
// a representative response (field spellings vary on purpose — the parser must be defensive but strict)
const RESP = { data: [
  { name: 'BlackRock USD Institutional Digital Liquidity', issuer: 'BlackRock', symbol: 'BUIDL',
    tokens: [ { chainId: 1, address: BUIDL_ETH, symbol: 'BUIDL' },
              { network: 'base', contractAddress: BUIDL_BASE } ] },           // symbol falls back to the asset's
  { name: 'Ondo US Dollar Yield', platform: 'Ondo',
    deployments: [ { chain_id: 8453, tokenAddress: USDY_BASE, ticker: 'USDY' } ] },
  { name: 'Solana-only', issuer: 'X', tokens: [ { network: 'solana', address: 'NotAnEvmAddress', symbol: 'S' } ] }, // dropped
  { name: 'Malformed', tokens: [ { chainId: 8453, address: '0xshort', symbol: 'BAD' } ] },                          // dropped
] };

console.log('BIII RWA registry ingest — authoritative, validated, fail-safe:');

t('normalizeAssets extracts VALID contracts across the token lists, mapping issuer/symbol/chain', () => {
  const { entries } = normalizeAssets(RESP, { chains: [1, 8453, 42161] });
  assert.equal(entries.length, 3);
  const base = entries.find((e) => e.address === USDY_BASE);
  assert.equal(base.issuer, 'Ondo'); assert.equal(base.symbol, 'USDY'); assert.equal(base.chainId, 8453);
  const bx = entries.find((e) => e.address === BUIDL_BASE);
  assert.equal(bx.symbol, 'BUIDL'); assert.equal(bx.chainId, 8453);   // symbol fell back to the asset symbol
  assert.equal(bx.source, 'rwa.xyz');
});

t('FAIL-SAFE: off-chain (Solana) and malformed-address rows are dropped, never mis-mapped', () => {
  const { entries, dropped } = normalizeAssets(RESP, { chains: [1, 8453, 42161] });
  assert.ok(!entries.some((e) => e.symbol === 'S' || e.symbol === 'BAD'));
  assert.ok(dropped >= 2);
});

t('FAIL-SAFE: a schema mismatch yields an EMPTY registry — never a wrong address', () => {
  assert.equal(normalizeAssets({ garbage: 1 }).entries.length, 0);
  assert.equal(normalizeAssets({ data: [{ foo: 'bar' }] }).entries.length, 0);
  assert.equal(normalizeAssets(null).entries.length, 0);
  assert.equal(normalizeAssets([{ tokens: [{ address: BUIDL_ETH }] }]).entries.length, 0); // no chainId/symbol → dropped
});

t('chain filter narrows to the wanted chains (Base-only)', () => {
  const { entries } = normalizeAssets(RESP, { chains: [8453] });
  assert.ok(entries.every((e) => e.chainId === 8453));
  assert.equal(entries.length, 2);   // BUIDL-base + USDY-base
});

t('toChainId maps names and ids, rejects unknown/off-chain', () => {
  assert.equal(toChainId('base'), 8453);
  assert.equal(toChainId('ethereum'), 1);
  assert.equal(toChainId(42161), 42161);
  assert.equal(toChainId('solana'), null);
  assert.equal(toChainId('bogus'), null);
});

t('an INGESTED registry composes with assessAsset — the Ondo contract reads genuine', () => {
  const { entries } = normalizeAssets(RESP, { chains: [8453] });
  const r = assessAsset({ token: USDY_BASE, claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(r.status, 'genuine'); assert.equal(r.issuer, 'Ondo');
  // and an impersonator claiming USDY at a different address is caught against the ingested registry
  const imp = assessAsset({ token: '0x' + 'ff'.repeat(20), claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(imp.status, 'impersonation'); assert.equal(imp.genuineAddress, USDY_BASE);
});

tA('fetchRwaAssets sends the Bearer key, paginates, and returns the flattened asset array', async () => {
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization });
    const page0 = { data: Array.from({ length: 100 }, (_, i) => ({ name: 'a' + i })) };  // full page → paginate
    const page1 = { data: [{ name: 'last' }] };                                            // short page → stop
    return { ok: true, json: async () => (url.includes('offset=0') ? page0 : page1) };
  };
  const all = await fetchRwaAssets({ apiKey: 'KEY123', fetchImpl: fakeFetch });
  assert.equal(all.length, 101);
  assert.equal(calls.length, 2, 'stopped after the short page');
  assert.match(calls[0].auth, /Bearer KEY123/);
  await assert.rejects(() => fetchRwaAssets({ apiKey: '', fetchImpl: fakeFetch }), /API_KEY required/);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
