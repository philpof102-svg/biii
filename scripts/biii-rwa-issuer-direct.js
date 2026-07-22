#!/usr/bin/env node
'use strict';
/**
 * biii-rwa-issuer-direct — build the ISSUER-OFFICIAL tokenized-asset registry from ISSUER-DIRECT, on-chain,
 * no-key, commercially-usable sources (unlike the CoinGecko path, whose free tier is non-commercial).
 * ================================================================================================
 * PRIMARY source: Dinari dShares FACTORY on Base. The factory emits `DShareAdded(address indexed dShare, …)`
 * once per official dShare — membership in that event set IS the issuer's declaration. We enumerate the
 * events, then FAIL-CLOSED re-verify each candidate ON-CHAIN (its own `symbol()` / `name()` must read as a
 * real ERC-20 whose name carries "Dinari") before admitting it. An unverified log is DROPPED — never
 * blessed. Output entries carry provenance 'issuer-official' (→ lib/asset.provenanceOf → the green badge).
 *
 * Base factory:     0xBCE6410A175a1C9B1a25D38d7e1A900F8393BC4D
 * DShareAdded topic: 0xfc5890ef646a4c681cf9479ed23b38d3d92fe3b32166aee1e9ebd394a45a0824 (dShare = topic[1])
 *
 * The CORE (buildRegistryFromDinari) is pure + offline-testable (given logs + a verified map). The CLI does
 * the live enumeration (chunked eth_getLogs) + throttled on-chain verification, and writes
 * data/issuer-verified.json (the COMMITTED, shippable green registry — merged over the aggregator by
 * lib/asset-registry). A dedicated RPC (BASE_RPC_URL) avoids the public node's 10k-range + rate limits.
 *
 * Run:  node scripts/biii-rwa-issuer-direct.js [--out=data/issuer-verified.json] [--birth=15625958]
 */
const fs = require('node:fs'), path = require('node:path');

const FACTORY = '0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d';
const DSHARE_ADDED_TOPIC = '0xfc5890ef646a4c681cf9479ed23b38d3d92fe3b32166aee1e9ebd394a45a0824';
const BASE_CHAIN_ID = 8453;
const AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';   // ground-truth anchors (must appear in the output)
const TSLA = '0x74ed07d83999bc5db0ffd850da0a6bd782abd39c';
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(String(a || '').toLowerCase());

/**
 * buildRegistryFromDinari — PURE. Turn factory logs + an on-chain-verified map into issuer-official entries.
 *   logs:     eth_getLogs results from the factory.
 *   verified: { [address]: { symbol, name } } — the on-chain reads. FAIL-CLOSED: an address absent from
 *             `verified`, or whose name does not carry "Dinari", is DROPPED (never admitted on the log alone).
 * Returns [{ issuer, symbol, name, chainId, address, source }].
 */
function buildRegistryFromDinari(logs, verified = {}, { factory = FACTORY } = {}) {
  const out = [], seen = new Set();
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 2) continue;
    if (String(log.topics[0]).toLowerCase() !== DSHARE_ADDED_TOPIC) continue;   // only DShareAdded
    const addr = ('0x' + String(log.topics[1]).slice(26)).toLowerCase();
    if (!isAddr(addr) || seen.has(addr)) continue;
    const v = verified[addr] || verified[String(addr).toLowerCase()];
    // FAIL-CLOSED: require the on-chain re-verification, and the name must self-identify as Dinari's.
    if (!v || !v.symbol || !v.name || !/dinari/i.test(v.name)) continue;
    seen.add(addr);
    out.push({ issuer: 'Dinari', symbol: v.symbol, name: v.name, chainId: BASE_CHAIN_ID, address: addr,
      source: 'issuer: Dinari dShares factory ' + factory + ' (DShareAdded event, on-chain verified) — docs.dinari.com' });
  }
  return out;
}

// ── live helpers (CLI only) ───────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexNum = (n) => '0x' + BigInt(n).toString(16);
const decodeAbiString = (h) => { if (!h || h === '0x') return null; try { const b = h.slice(2); const len = parseInt(b.slice(64, 128), 16); return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return null; } };

async function rpc(rpcUrl, method, params, fetchImpl, tries = 5) {
  const f = fetchImpl || fetch;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) { if (/rate/i.test(j.error.message)) { await sleep(2000); continue; } throw new Error(j.error.message); }
      return j.result;
    } catch (e) { if (i === tries - 1) return null; await sleep(1500); }
  }
}

/** fetchDinariLive — enumerate the factory + verify on-chain. Slow on a public RPC (10k range + rate limits). */
async function fetchDinariLive({ rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org', fetchImpl, birth = 15625958n, window = 130000n, step = 9999n, throttle = 250 } = {}) {
  birth = BigInt(birth); let logs = [];
  for (let from = birth - 40000n; from < birth + window; from += step) {
    const to = from + step;
    const l = await rpc(rpcUrl, 'eth_getLogs', [{ address: FACTORY, fromBlock: hexNum(from < 0n ? 0n : from), toBlock: hexNum(to) }], fetchImpl);
    if (Array.isArray(l)) logs = logs.concat(l);
    await sleep(throttle);
  }
  const addrs = [...new Set(logs.filter((l) => l && l.topics && String(l.topics[0]).toLowerCase() === DSHARE_ADDED_TOPIC && l.topics[1]).map((l) => ('0x' + l.topics[1].slice(26)).toLowerCase()))];
  const verified = {};
  for (const a of addrs) {
    const symbol = decodeAbiString(await rpc(rpcUrl, 'eth_call', [{ to: a, data: '0x95d89b41' }, 'latest'], fetchImpl)); await sleep(throttle);
    const name = decodeAbiString(await rpc(rpcUrl, 'eth_call', [{ to: a, data: '0x06fdde03' }, 'latest'], fetchImpl)); await sleep(throttle);
    if (symbol && name) verified[a] = { symbol, name };
  }
  return { logs, verified };
}

async function main() {
  const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1] || path.join(__dirname, '..', 'data', 'issuer-verified.json');
  const birthArg = (process.argv.find((a) => a.startsWith('--birth=')) || '').split('=')[1];
  console.log('enumerating Dinari dShares from the Base factory (this is slow on the public RPC)…');
  const { logs, verified } = await fetchDinariLive(birthArg ? { birth: BigInt(birthArg) } : {});
  const entries = buildRegistryFromDinari(logs, verified);
  // ground-truth guard: AAPL + TSLA MUST come out (else the enumeration missed the window).
  const has = (a) => entries.some((e) => e.address === a);
  if (!has(AAPL) || !has(TSLA)) { console.error('⚠ ground-truth check FAILED (AAPL ' + has(AAPL) + ', TSLA ' + has(TSLA) + ') — refusing to overwrite; widen the window / use BASE_RPC_URL.'); process.exit(1); }
  const out = { generatedFrom: 'issuer-official (verified)', generatedAt: new Date().toISOString().slice(0, 10), count: entries.length, entries };
  fs.writeFileSync(outArg, JSON.stringify(out, null, 2) + '\n');
  console.log('wrote ' + entries.length + ' issuer-official Dinari dShares → ' + outArg + ' (AAPL + TSLA present ✓)');
}

if (require.main === module) main();
module.exports = { buildRegistryFromDinari, fetchDinariLive, FACTORY, DSHARE_ADDED_TOPIC, AAPL, TSLA };
