#!/usr/bin/env node
'use strict';
/**
 * biii-rwa-registry.js — source the VERIFIED tokenized-asset registry from an authoritative API.
 * ==================================================================================================
 * lib/asset.js decides genuine vs impersonation by matching a token contract against a registry of
 * REAL issuer contracts. A wrong "genuine" address would BLESS a fake, so the registry must never be
 * hand-guessed — it is sourced from RWA.xyz ("the only verified API for tokenized securities", 100+
 * issuers contributing token-contract data). This is the same discipline as the sanctions denylist:
 * an authoritative external source, ingested, validated, fail-closed.
 *
 * Design (mirrors mainstreet-denylist-watcher): pure, injectable fetch, offline-testable. FAIL-SAFE:
 * every entry must validate (0x-40hex address · integer chainId · non-empty symbol) or it is dropped,
 * so a schema mismatch yields an EMPTY registry — never a wrong address. The exact RWA.xyz field names
 * are read defensively (several likely spellings); confirm the mapping against a live response once a
 * key is set, but a wrong guess can only UNDER-populate (safe), never mis-map an address to an issuer.
 *
 * Run: RWA_XYZ_API_KEY=... node scripts/biii-rwa-registry.js   → writes data/rwa-registry.json
 * lib/asset.js / the MCP load that file and pass it as the injected `registry` to assessAsset().
 */

const ADDR_RE = /^0x[0-9a-f]{40}$/;
// chain name → id, so a string network field ("base", "ethereum") maps to the id asset.js compares on.
const CHAIN_IDS = { ethereum: 1, eth: 1, mainnet: 1, base: 8453, arbitrum: 42161, 'arbitrum-one': 42161, optimism: 10, polygon: 137, gnosis: 100, plume: 98865, solana: null };
const DEFAULT_CHAINS = [8453, 1, 42161];   // Base first — that's where our till settles

const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const toChainId = (v) => {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  return CHAIN_IDS[s] ?? null;
};

/**
 * normalizeAssets — flatten an RWA.xyz-style response into validated registry entries.
 * Defensive to field spelling; STRICT on validity. Returns { entries, seen, dropped }.
 */
function normalizeAssets(resp, { chains = DEFAULT_CHAINS } = {}) {
  const want = new Set(chains);
  const assets = Array.isArray(resp) ? resp : (resp && (resp.data || resp.assets || resp.results)) || [];
  const entries = []; let seen = 0, dropped = 0;
  const seenKey = new Set();
  for (const a of assets) {
    if (!a || typeof a !== 'object') { dropped++; continue; }
    const issuer = pick(a, ['issuer', 'issuerName', 'platform', 'platformName', 'manager', 'sponsor']);
    const name = pick(a, ['name', 'assetName', 'title']);
    // a token deployment list, or the asset itself if it carries an address
    const tokens = a.tokens || a.deployments || a.contracts || a.instances || (pick(a, ['address', 'contractAddress', 'tokenAddress']) ? [a] : []);
    for (const tk of Array.isArray(tokens) ? tokens : []) {
      seen++;
      const address = String(pick(tk, ['address', 'contractAddress', 'tokenAddress', 'contract']) || '').trim().toLowerCase();
      const chainId = toChainId(pick(tk, ['chainId', 'chain_id', 'chainID', 'network', 'chain']));
      const symbol = String(pick(tk, ['symbol', 'ticker', 'tokenSymbol']) || pick(a, ['symbol', 'ticker']) || '').trim();
      if (!ADDR_RE.test(address) || !Number.isInteger(chainId) || !symbol) { dropped++; continue; }  // FAIL-SAFE drop
      if (want.size && !want.has(chainId)) { dropped++; continue; }
      const key = chainId + ':' + address;
      if (seenKey.has(key)) continue; seenKey.add(key);
      entries.push({ issuer: issuer ? String(issuer).trim() : null, symbol,
        name: name ? String(name).trim() : null, chainId, address, source: 'rwa.xyz' });
    }
  }
  return { entries, seen, dropped };
}

/** Fetch every page of /v4/assets with the operator's API key. Returns the raw asset array. */
async function fetchRwaAssets({ apiKey, fetchImpl, baseUrl = 'https://api.rwa.xyz', pageLimit = 100, maxPages = 20, timeoutMs = 20000 } = {}) {
  if (!apiKey) throw new Error('RWA_XYZ_API_KEY required (RWA.xyz API is the authoritative source)');
  const f = fetchImpl || fetch;
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${baseUrl}/v4/assets?limit=${pageLimit}&offset=${page * pageLimit}`;
    const res = await Promise.race([
      f(url, { headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (!res || res.ok === false) throw new Error('rwa.xyz HTTP ' + (res && res.status));
    const j = await res.json();
    const batch = Array.isArray(j) ? j : (j.data || j.assets || j.results || []);
    all.push(...batch);
    if (batch.length < pageLimit) break;   // last page
  }
  return all;
}

module.exports = { normalizeAssets, fetchRwaAssets, toChainId, CHAIN_IDS, DEFAULT_CHAINS };

// ── run as a script ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const fs = require('node:fs'), path = require('node:path');
    try {
      const raw = await fetchRwaAssets({ apiKey: process.env.RWA_XYZ_API_KEY });
      const { entries, seen, dropped } = normalizeAssets(raw);
      const dir = path.join(__dirname, '..', 'data'); fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'rwa-registry.json');
      fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'rwa.xyz/v4/assets', count: entries.length, entries }, null, 2) + '\n');
      console.log(`[rwa-registry] ${entries.length} verified contracts written to ${out} (${seen} seen, ${dropped} dropped as unvalidated/off-chain)`);
      if (!entries.length) console.warn('[rwa-registry] EMPTY — confirm the RWA.xyz response field mapping (address/chainId/symbol) against the live schema.');
      process.exit(0);
    } catch (e) { console.error('[rwa-registry] failed:', e.message); process.exit(1); }
  })();
}
