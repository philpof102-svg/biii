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

/**
 * Fetch every page of a v4 endpoint (assets | tokens) with the operator's Bearer key.
 *
 * ⚠️ RETURNS { rows, pages, hitPageCap } — deliberately NOT a bare array. Falling out of the loop at
 * `maxPages` and reaching a genuinely short last page used to return the same flat array, so a
 * TRUNCATED ingest was indistinguishable from a complete one. Measured 2026-07-29: 300 rows stopped at
 * the cap and 107 rows at a real last page came back identically shaped, and the caller then published
 * a count as though the source had been exhausted. `hitPageCap` starts TRUE and is only cleared by a
 * short page — the one thing that actually proves exhaustion.
 */
async function fetchAll(endpoint, { apiKey, fetchImpl, baseUrl = 'https://api.rwa.xyz', perPage = 100, maxPages = 60, timeoutMs = 20000, sort } = {}) {
  if (!apiKey) throw new Error('RWA_XYZ_API_KEY required (RWA.xyz API is the authoritative source)');
  const f = fetchImpl || fetch;
  const all = [];
  let pages = 0, hitPageCap = true;   // assume truncation until a short page PROVES the source is spent
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
    pages++;
    all.push(...batch);
    if (batch.length < perPage) { hitPageCap = false; break; }   // short page = source exhausted
  }
  return { rows: all, pages, hitPageCap };
}

/**
 * Fetch tokens + assets and build the registry.
 * Reports its own COMPLETENESS: a registry that lost pages is not a smaller registry, it is a registry
 * whose absences no longer mean anything (see the warning on assessAsset's symbol-collision branch).
 */
async function ingestRegistry(opts = {}) {
  const tokens = await fetchAll('tokens', opts);
  const assets = await fetchAll('assets', { ...opts, sort: { field: 'circulating_market_value_dollar', direction: 'desc' } });
  const built = buildRegistry(tokens.rows, assets.rows, opts);
  const truncated = [];
  if (tokens.hitPageCap) truncated.push({ endpoint: 'tokens', stoppedAtPage: tokens.pages });
  if (assets.hitPageCap) truncated.push({ endpoint: 'assets', stoppedAtPage: assets.pages });
  return { ...built, failed: [], truncated, complete: truncated.length === 0 };
}

// ── FREE alternative source: Coingecko (no API key) ──────────────────────────────────────────────
// RWA.xyz's API key is gated; Coingecko's public API exposes the same thing for free: tokenized-stock /
// RWA coins (by category) each carry a `platforms` map {chain-slug: contract address}. Aggregator-
// authoritative (industry standard) — good enough for the genuine/impersonation verdict, and free.
// Coingecko platform SLUGS → chainId (exact — do NOT fuzzy-match, "optimistic-ethereum" must be 10 not 1).
const CG_PLATFORM = { ethereum: 1, base: 8453, 'arbitrum-one': 42161, 'optimistic-ethereum': 10,
  'polygon-pos': 137, 'binance-smart-chain': 56, gnosis: 100, avalanche: 43114 };
// tokenized/RWA category id → issuer/platform label (from the category; null = mixed, use the coin name).
// Full set verified live via /coins/categories/list — issuer-specific ecosystems + the tokenized-* families.
const CG_CATEGORIES = {
  'xstocks-ecosystem': 'Backed (xStocks)', 'bstocks-ecosystem': 'Backed', 'dinari-ecosystem': 'Dinari',
  'ondo-tokenized-assets': 'Ondo', 'robinhood-chain-stocks-ecosystem': 'Robinhood',
  'remona-tokenized-stocks': 'Remona', 'openstock-ecosystem': 'Openstock',
  'republic-tokenized-pre-ipo-assets': 'Republic',
  'real-world-assets-rwa': null, 'tokenized-stock': null, 'tokenized-products': null,
  'tokenized-treasuries': null, 'tokenized-t-bills': null, 'tokenized-treasury-bonds-t-bonds': null,
  'tokenized-money-market-fund-mmfs': null, 'tokenized-exchange-traded-funds-etfs': null,
  'tokenized-commodities': null, 'tokenized-gold': null, 'tokenized-pre-ipo-stocks': null,
  'asset-backed-tokens': null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cg(path, { fetchImpl, baseUrl = 'https://api.coingecko.com/api/v3', apiKey, timeoutMs = 20000, retries = 3 } = {}) {
  const f = fetchImpl || fetch;
  const headers = apiKey ? { 'x-cg-demo-api-key': apiKey, accept: 'application/json' } : { accept: 'application/json' };
  for (let attempt = 0; ; attempt++) {
    const res = await Promise.race([
      f(baseUrl + path, { headers }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (res && res.status === 429 && attempt < retries) { await sleep(15000 * (attempt + 1)); continue; }  // free-tier throttle → back off
    if (!res || res.ok === false) throw new Error('coingecko HTTP ' + (res && res.status));
    return res.json();
  }
}

/**
 * buildRegistryFromCoingecko — join category membership (coinId → issuer) with the platform map
 * (coinId → {chain-slug: address}) into validated registry entries. Fail-safe: same strict validation.
 * members: Map<coinId, {issuer, category, name?}>. platformList: [{ id, symbol, name, platforms }].
 */
function buildRegistryFromCoingecko(members, platformList, { chains = DEFAULT_CHAINS } = {}) {
  const want = new Set(chains);
  const entries = []; let seen = 0, dropped = 0; const seenKey = new Set();
  for (const coin of Array.isArray(platformList) ? platformList : []) {
    const meta = members instanceof Map ? members.get(coin && coin.id) : (members && members[coin && coin.id]);
    if (!meta || !coin) continue;                                  // not a tokenized/RWA coin
    const symbol = String(coin.symbol || '').trim().toUpperCase();
    const name = coin.name || meta.name || null;
    for (const [slug, addr] of Object.entries(coin.platforms || {})) {
      seen++;
      const chainId = CG_PLATFORM[slug] != null ? CG_PLATFORM[slug] : null;
      const address = String(addr || '').trim().toLowerCase();
      if (!ADDR_RE.test(address) || !Number.isInteger(chainId) || !symbol) { dropped++; continue; }  // FAIL-SAFE
      if (want.size && !want.has(chainId)) { dropped++; continue; }
      const key = chainId + ':' + address; if (seenKey.has(key)) continue; seenKey.add(key);
      entries.push({ issuer: meta.issuer || null, symbol, name, chainId, address, source: 'coingecko:' + (meta.category || 'rwa') });
    }
  }
  return { entries, seen, dropped };
}

/**
 * Ingest the registry from Coingecko (free, no key needed — a demo key just raises the rate limit).
 *
 * ⚠️ A CATEGORY THAT FAILS IS NOT A CATEGORY THAT IS EMPTY. The old `catch { break }` swallowed the
 * error whole: the coins never reached `members`, so `buildRegistryFromCoingecko` skipped them before
 * ever incrementing `seen` or `dropped`. Measured 2026-07-29 on this exact code — one ECONNRESET turned
 * `entries=2 seen=2 dropped=0` into `entries=0 seen=0 dropped=0`, byte-for-byte what a legitimately
 * empty category produces. The script then printed that count as a finished ingest.
 * The failure is now CARRIED OUT of the function, because the caller's registry is what pays for it.
 */
async function ingestFromCoingecko(opts = {}) {
  const cats = opts.categories || CG_CATEGORIES;
  const members = new Map();
  const catEntries = Object.entries(cats);
  const catMax = opts.catMaxPages || 4;
  const failed = [], truncated = [];
  let firstCall = true;
  for (const [catId, issuer] of catEntries) {
    for (let page = 1; page <= catMax; page++) {                   // paginate — real-world-assets-rwa exceeds 250
      if (!firstCall && !opts.fetchImpl) await sleep(2500);        // space real calls under the free-tier limit
      firstCall = false;
      let coins;
      try { coins = await cg(`/coins/markets?vs_currency=usd&category=${encodeURIComponent(catId)}&per_page=250&page=${page}`, opts); }
      catch (e) { failed.push({ category: catId, page, error: e.message }); break; }
      // A non-array body is SCHEMA DRIFT, not an empty category — the same two cases again, one line apart.
      if (!Array.isArray(coins)) { failed.push({ category: catId, page, error: 'response was not an array (schema drift?)' }); break; }
      if (!coins.length) break;                                    // genuinely empty — nothing to report
      for (const c of coins) {
        if (!c || !c.id) continue;
        const prev = members.get(c.id);
        if (!prev || (!prev.issuer && issuer)) members.set(c.id, { issuer, category: catId, name: c.name });  // specific issuer wins
      }
      if (coins.length < 250) break;                               // last page for this category
      if (page === catMax) truncated.push({ category: catId, stoppedAtPage: page });  // full page AT the cap
    }
  }
  if (!opts.fetchImpl) await sleep(2500);
  const platformList = await cg('/coins/list?include_platform=true', opts);  // ~one big call, all coins+platforms
  const built = buildRegistryFromCoingecko(members, platformList, opts);
  return { ...built, failed, truncated, complete: !failed.length && !truncated.length };
}

module.exports = { buildRegistry, fetchAll, ingestRegistry, toChainId, CHAIN_IDS, DEFAULT_CHAINS,
  buildRegistryFromCoingecko, ingestFromCoingecko, cg, CG_PLATFORM, CG_CATEGORIES };

// ── run as a script ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const fs = require('node:fs'), path = require('node:path');
    try {
      // Coingecko (free, no key) is the DEFAULT source — RWA.xyz's API is gated. Set RWA_XYZ_API_KEY to
      // use the RWA.xyz v4 API instead; COINGECKO_API_KEY (optional demo key) just raises the rate limit.
      const useRwaxyz = !!process.env.RWA_XYZ_API_KEY;
      const src = useRwaxyz ? 'rwa.xyz/v4 (tokens⋈assets)' : 'coingecko (free)';
      console.log(`[rwa-registry] sourcing from ${src}…`);
      const { entries, seen, dropped, complete, failed = [], truncated = [] } = useRwaxyz
        ? await ingestRegistry({ apiKey: process.env.RWA_XYZ_API_KEY })
        : await ingestFromCoingecko({ apiKey: process.env.COINGECKO_API_KEY });
      const dir = path.join(__dirname, '..', 'data'); fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'rwa-registry.json');
      // `complete` is WRITTEN INTO THE FILE, not just logged: the consumer that decides genuine vs
      // impersonation reads the file, never this console. An absence in an incomplete registry is not
      // evidence — and only this flag lets the reader tell the two apart.
      fs.writeFileSync(out, JSON.stringify({ generatedFrom: src, complete, count: entries.length,
        incomplete: complete ? null : { failed, truncated,
          note: 'Rows are MISSING from this registry. A contract absent here may be perfectly genuine and '
              + 'merely un-ingested: absence is NOT evidence of impersonation.' },
        entries }, null, 2) + '\n');
      console.log(`[rwa-registry] ${entries.length} verified contracts written to ${out} (${seen} seen, ${dropped} dropped as off-chain/unvalidated)`);
      if (entries.length) console.log('[rwa-registry] sample:', JSON.stringify(entries.slice(0, 3)));
      else console.warn('[rwa-registry] EMPTY — confirm the source response shape.');
      if (!complete) {
        for (const f of failed) console.warn(`[rwa-registry] ⚠️ category "${f.category}" p${f.page} FAILED: ${f.error} — its contracts are missing, not absent`);
        for (const t of truncated) console.warn(`[rwa-registry] ⚠️ ${t.category || t.endpoint} stopped at the page cap (p${t.stoppedAtPage}) — more rows exist upstream`);
        console.warn('[rwa-registry] registry marked INCOMPLETE. Downstream must not read a missing contract as an impersonator.');
        process.exit(3);        // a third outcome: we wrote a file, and it is knowingly partial
      }
      process.exit(0);
    } catch (e) { console.error('[rwa-registry] failed:', e.message); process.exit(1); }
  })();
}
