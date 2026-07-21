#!/usr/bin/env node
'use strict';
/**
 * biii-rwa-registry.js — source the VERIFIED tokenized-asset registry from RWA.xyz (v4 API).
 * ==================================================================================================
 * lib/asset.js decides genuine vs impersonation against a registry of REAL issuer contracts. A wrong
 * "genuine" address would BLESS a fake, so the registry is never hand-guessed — it is sourced from
 * RWA.xyz ("the only verified API for tokenized securities", 100+ issuers contributing data). Same
 * discipline as the sanctions denylist: an authoritative external source, ingested, validated, fail-safe.
 *
 * The v4 API (docs.rwa.xyz/api) splits it: /v4/assets has name/issuer_name/ticker but NO addresses;
 * /v4/tokens has the per-chain deployment { address, network_name, asset_id }. So we fetch BOTH and
 * JOIN by asset_id. Auth: `Authorization: Bearer <key>`. Query: GET /v4/<endpoint>?query=<url-encoded
 * JSON {sort?, pagination:{page,perPage}}>, page 1-based.
 *
 * FAIL-SAFE: every entry must validate (0x-40hex address · integer chainId · non-empty symbol · wanted
 * chain) or it is dropped, so a schema drift yields an EMPTY registry — never a wrong address. Get a key:
 * app.rwa.xyz/login → API Tools ▸ API Keys. Run: RWA_XYZ_API_KEY=… node scripts/biii-rwa-registry.js
 */

const ADDR_RE = /^0x[0-9a-f]{40}$/;
// network name/id → chainId. asset.js compares on the numeric id. Names come from RWA.xyz network_name.
const CHAIN_IDS = { ethereum: 1, eth: 1, mainnet: 1, base: 8453, arbitrum: 42161, optimism: 10, op: 10,
  polygon: 137, matic: 137, gnosis: 100, avalanche: 43114, avax: 43114, plume: 98865, bnb: 56, bsc: 56, solana: null };
const DEFAULT_CHAINS = [8453, 1, 42161];   // Base first — that's where our till settles

const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const toChainId = (v) => {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (CHAIN_IDS[s] != null) return CHAIN_IDS[s];
  for (const key of Object.keys(CHAIN_IDS)) if (CHAIN_IDS[key] && s.includes(key)) return CHAIN_IDS[key]; // "Ethereum Mainnet","Arbitrum One"
  return null;
};

/**
 * buildRegistry — JOIN tokens (address · network · asset_id) with assets (name · issuer_name · ticker),
 * validate strictly, map to the lib/asset.js registry shape. Returns { entries, seen, dropped }.
 */
function buildRegistry(tokens, assets, { chains = DEFAULT_CHAINS } = {}) {
  const want = new Set(chains);
  const byId = new Map();
  for (const a of Array.isArray(assets) ? assets : []) { const id = pick(a, ['id', 'asset_id', 'assetId']); if (id != null) byId.set(String(id), a); }
  const entries = []; let seen = 0, dropped = 0; const seenKey = new Set();
  for (const tk of Array.isArray(tokens) ? tokens : []) {
    if (!tk || typeof tk !== 'object') { dropped++; continue; }
    seen++;
    const address = String(pick(tk, ['address', 'contract_address', 'contractAddress', 'token_address']) || '').trim().toLowerCase();
    const chainId = toChainId(pick(tk, ['network_name', 'network', 'chain_id', 'chainId', 'chain']));
    const asset = byId.get(String(pick(tk, ['asset_id', 'assetId'])));
    const symbol = String(pick(tk, ['ticker', 'symbol']) || (asset && pick(asset, ['ticker', 'symbol'])) || '').trim();
    const issuer = (asset && pick(asset, ['issuer_name', 'issuer', 'platform_name', 'platform'])) || pick(tk, ['issuer_name', 'issuer']);
    const name = (asset && pick(asset, ['name', 'asset_name'])) || pick(tk, ['name', 'asset_name']);
    if (!ADDR_RE.test(address) || !Number.isInteger(chainId) || !symbol) { dropped++; continue; }  // FAIL-SAFE drop
    if (want.size && !want.has(chainId)) { dropped++; continue; }
    const key = chainId + ':' + address; if (seenKey.has(key)) continue; seenKey.add(key);
    entries.push({ issuer: issuer ? String(issuer).trim() : null, symbol,
      name: name ? String(name).trim() : null, chainId, address, source: 'rwa.xyz' });
  }
  return { entries, seen, dropped };
}

/** Fetch every page of a v4 endpoint (assets | tokens) with the operator's Bearer key. */
async function fetchAll(endpoint, { apiKey, fetchImpl, baseUrl = 'https://api.rwa.xyz', perPage = 100, maxPages = 60, timeoutMs = 20000, sort } = {}) {
  if (!apiKey) throw new Error('RWA_XYZ_API_KEY required (RWA.xyz API is the authoritative source)');
  const f = fetchImpl || fetch;
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = JSON.stringify({ ...(sort ? { sort } : {}), pagination: { page, perPage } });
    const url = `${baseUrl}/v4/${endpoint}?query=${encodeURIComponent(query)}`;
    const res = await Promise.race([
      f(url, { headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (!res || res.ok === false) throw new Error(`rwa.xyz /${endpoint} HTTP ` + (res && res.status));
    const j = await res.json();
    const batch = Array.isArray(j) ? j : (j.data || j.results || j[endpoint] || []);
    all.push(...batch);
    if (batch.length < perPage) break;   // last page
  }
  return all;
}

/** Fetch tokens + assets and build the registry. */
async function ingestRegistry(opts = {}) {
  const tokens = await fetchAll('tokens', opts);
  const assets = await fetchAll('assets', { ...opts, sort: { field: 'circulating_market_value_dollar', direction: 'desc' } });
  return buildRegistry(tokens, assets, opts);
}

module.exports = { buildRegistry, fetchAll, ingestRegistry, toChainId, CHAIN_IDS, DEFAULT_CHAINS };

// ── run as a script ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const fs = require('node:fs'), path = require('node:path');
    try {
      const { entries, seen, dropped } = await ingestRegistry({ apiKey: process.env.RWA_XYZ_API_KEY });
      const dir = path.join(__dirname, '..', 'data'); fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'rwa-registry.json');
      fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'rwa.xyz/v4 (tokens⋈assets)', count: entries.length, entries }, null, 2) + '\n');
      console.log(`[rwa-registry] ${entries.length} verified contracts written to ${out} (${seen} tokens seen, ${dropped} dropped as off-chain/unvalidated)`);
      if (entries.length) console.log('[rwa-registry] sample:', JSON.stringify(entries.slice(0, 3)));
      else console.warn('[rwa-registry] EMPTY — confirm the /v4/tokens field mapping (address/network_name/asset_id) against the live response.');
      process.exit(0);
    } catch (e) { console.error('[rwa-registry] failed:', e.message); process.exit(1); }
  })();
}
