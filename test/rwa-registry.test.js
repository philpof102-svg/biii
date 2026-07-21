'use strict';
// BIII RWA registry ingest — joins RWA.xyz /v4/tokens ⋈ /v4/assets, fail-safe.
// Run: node test/rwa-registry.test.js
const assert = require('node:assert');
const { buildRegistry, fetchAll, toChainId, buildRegistryFromCoingecko } = require('../scripts/biii-rwa-registry');
const { assessAsset } = require('../lib/asset');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const BUIDL_ETH = '0x' + '11'.repeat(20);
const BUIDL_BASE = '0x' + '22'.repeat(20);
const USDY_BASE = '0x' + '33'.repeat(20);
const ORPHAN = '0x' + '44'.repeat(20);
// real v4 shapes: tokens carry the address+network+asset_id; assets carry name+issuer_name+ticker
const TOKENS = [
  { address: BUIDL_ETH, network_name: 'Ethereum', asset_id: 'a1', ticker: 'BUIDL' },
  { address: BUIDL_BASE, network_name: 'Base', asset_id: 'a1' },              // ticker falls back to the asset's
  { address: USDY_BASE, network_name: 'Base', asset_id: 'a2', ticker: 'USDY' },
  { address: 'NotAnEvmAddress', network_name: 'Solana', asset_id: 'a3' },     // dropped: bad addr + off-chain
  { address: '0xshort', network_name: 'Base', asset_id: 'a4' },               // dropped: malformed addr
  { address: ORPHAN, network_name: 'Base', asset_id: 'zz' },                  // dropped: no asset → no symbol
];
const ASSETS = [
  { id: 'a1', name: 'BlackRock USD Institutional Digital Liquidity', issuer_name: 'BlackRock', ticker: 'BUIDL' },
  { id: 'a2', name: 'Ondo US Dollar Yield', issuer_name: 'Ondo', ticker: 'USDY' },
];

console.log('BIII RWA registry ingest — tokens⋈assets join, validated, fail-safe:');

t('buildRegistry JOINS tokens→assets, mapping address · chain (network_name) · symbol · issuer', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [1, 8453, 42161] });
  assert.equal(entries.length, 3);
  const usdy = entries.find((e) => e.address === USDY_BASE);
  assert.equal(usdy.issuer, 'Ondo'); assert.equal(usdy.symbol, 'USDY'); assert.equal(usdy.chainId, 8453);
  const bxBase = entries.find((e) => e.address === BUIDL_BASE);
  assert.equal(bxBase.symbol, 'BUIDL');   // token had no ticker → fell back to the joined asset's
  assert.equal(bxBase.issuer, 'BlackRock'); assert.equal(bxBase.source, 'rwa.xyz');
});

t('FAIL-SAFE: off-chain (Solana), malformed-address, and unjoinable (no symbol) tokens are dropped', () => {
  const { entries, dropped } = buildRegistry(TOKENS, ASSETS, { chains: [1, 8453, 42161] });
  assert.ok(!entries.some((e) => e.address === '0xshort' || e.address === ORPHAN));
  assert.ok(dropped >= 3);
});

t('FAIL-SAFE: a schema mismatch yields an EMPTY registry — never a wrong address', () => {
  assert.equal(buildRegistry([{ foo: 'bar' }], []).entries.length, 0);
  assert.equal(buildRegistry(null, null).entries.length, 0);
  assert.equal(buildRegistry([{ address: BUIDL_ETH, network_name: 'Ethereum', asset_id: 'x' }], []).entries.length, 0); // no asset → no symbol → dropped
});

t('chain filter narrows to the wanted chains (Base-only)', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [8453] });
  assert.ok(entries.every((e) => e.chainId === 8453));
  assert.equal(entries.length, 2);   // BUIDL-base + USDY-base
});

t('toChainId maps network_name strings and ids, rejects off-chain/unknown', () => {
  assert.equal(toChainId('Base'), 8453);
  assert.equal(toChainId('Ethereum'), 1);
  assert.equal(toChainId('Ethereum Mainnet'), 1);
  assert.equal(toChainId('Arbitrum One'), 42161);
  assert.equal(toChainId(8453), 8453);
  assert.equal(toChainId('Solana'), null);
  assert.equal(toChainId('bogus'), null);
});

t('a built registry composes with assessAsset — genuine + impersonation', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [8453] });
  const g = assessAsset({ token: USDY_BASE, claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(g.status, 'genuine'); assert.equal(g.issuer, 'Ondo');
  const imp = assessAsset({ token: '0x' + 'ff'.repeat(20), claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(imp.status, 'impersonation'); assert.equal(imp.genuineAddress, USDY_BASE);
});

t('buildRegistryFromCoingecko (FREE source): maps platforms→chainId exactly, joins issuer, drops off-chain', () => {
  const members = new Map([
    ['ondo-google', { issuer: 'Ondo', category: 'ondo-tokenized-assets' }],
    ['dinari-aapl', { issuer: 'Dinari', category: 'dinari' }],
  ]);
  const platformList = [
    { id: 'ondo-google', symbol: 'googlon', name: 'Google (Ondo)', platforms: { ethereum: BUIDL_ETH, solana: 'SoLaNaAddr', 'optimistic-ethereum': USDY_BASE } },
    { id: 'dinari-aapl', symbol: 'daapl', name: 'Apple dShare', platforms: { base: BUIDL_BASE } },
    { id: 'not-rwa', symbol: 'x', name: 'x', platforms: { ethereum: ORPHAN } },   // not in members → ignored
  ];
  const { entries } = buildRegistryFromCoingecko(members, platformList, { chains: [1, 8453, 42161, 10] });
  const eth = entries.find((e) => e.address === BUIDL_ETH);
  assert.equal(eth.chainId, 1); assert.equal(eth.issuer, 'Ondo'); assert.equal(eth.symbol, 'GOOGLON');  // uppercased
  const opt = entries.find((e) => e.address === USDY_BASE);
  assert.equal(opt.chainId, 10, 'optimistic-ethereum must map to 10, NOT 1 (no fuzzy-match)');
  assert.equal(entries.find((e) => e.address === BUIDL_BASE).chainId, 8453);  // base
  assert.ok(!entries.some((e) => e.address === ORPHAN), 'a coin not in the RWA categories is ignored');
  assert.ok(!entries.some((e) => String(e.address).includes('sol')), 'Solana platform dropped');
});

tA('fetchAll sends the Bearer key, uses the v4 query= param, paginates, returns the flattened array', async () => {
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization });
    const q = JSON.parse(decodeURIComponent((url.match(/query=([^&]+)/) || [])[1] || '{}'));
    const page = q.pagination && q.pagination.page;
    const full = { data: Array.from({ length: 100 }, (_, i) => ({ address: '0x' + String(i).padStart(40, '0') })) };
    const last = { data: [{ address: '0xlast' }] };
    return { ok: true, json: async () => (page === 1 ? full : last) };
  };
  const all = await fetchAll('tokens', { apiKey: 'KEY123', fetchImpl: fakeFetch });
  assert.equal(all.length, 101);
  assert.equal(calls.length, 2, 'stopped after the short page');
  assert.match(calls[0].auth, /Bearer KEY123/);
  assert.match(calls[0].url, /\/v4\/tokens\?query=.*pagination/i, 'uses /v4/<endpoint> with the query= param');
  await assert.rejects(() => fetchAll('assets', { apiKey: '', fetchImpl: fakeFetch }), /API_KEY required/);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
