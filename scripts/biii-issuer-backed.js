#!/usr/bin/env node
'use strict';
/**
 * biii-issuer-backed — ingest Backed Finance / xStocks tokenized equities from their OFFICIAL, OPEN, no-key
 * public API into issuer-official registry entries.
 * ================================================================================================
 * Source: https://api.backed.fi/api/v2/public/assets — Backed's OWN public API (issuer-authoritative; a fake
 * token cannot get into Backed's API). Each asset has `deployments[]` = {network, address} per chain. We keep
 * only EVM 0x deployments on chains we can name, tag the real chainId (NEVER force Base — Backed does not
 * deploy on Base), and stamp provenance 'issuer-official' via the source URL (→ lib/asset.provenanceOf → green).
 *
 * The CORE (buildFromBacked) is pure + offline-testable. The CLI fetches live and writes/merges the output.
 * Run: node scripts/biii-issuer-backed.js [--out=data/backed-verified.json]
 */
const fs = require('node:fs'), path = require('node:path');

const API = 'https://api.backed.fi/api/v2/public/assets';
const NET2CHAIN = { Ethereum: 1, Optimism: 10, BinanceSmartChain: 56, Gnosis: 100, Polygon: 137, XLayer: 196,
  Fantom: 250, Base: 8453, Mantle: 5000, Arbitrum: 42161, Avalanche: 43114, Ink: 57073 };
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(String(a || '').toLowerCase());

/**
 * buildFromBacked — PURE. Turn the Backed public-API response into issuer-official entries.
 *   api: the parsed { nodes: [{ symbol, name, deployments: [{ network, address }] }] } response.
 * FAIL-SAFE: a deployment on an unknown network, or a non-0x address, is DROPPED (never a wrong chainId, never
 * a bad address). Dedupes by address. net2chain injectable for tests.
 */
function buildFromBacked(api, { net2chain = NET2CHAIN } = {}) {
  const nodes = (api && Array.isArray(api.nodes)) ? api.nodes : [];
  const out = [], seen = new Set();
  for (const n of nodes) {
    for (const d of (Array.isArray(n.deployments) ? n.deployments : [])) {
      const chainId = net2chain[d.network];
      const address = String(d.address || '').toLowerCase();
      if (!chainId || !isAddr(address) || seen.has(address)) continue;   // fail-safe: unknown chain / bad addr → drop
      seen.add(address);
      out.push({ issuer: 'Backed (xStocks)', symbol: n.symbol, name: n.name, chainId, address,
        source: API + ' (Backed official public API)' });
    }
  }
  return out;
}

async function main() {
  const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1] || path.join(__dirname, '..', 'data', 'backed-verified.json');
  const api = await (await fetch(API, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) })).json();
  const entries = buildFromBacked(api);
  const byChain = {}; entries.forEach((e) => { byChain[e.chainId] = (byChain[e.chainId] || 0) + 1; });
  fs.writeFileSync(outArg, JSON.stringify({ generatedFrom: 'issuer-official (Backed API)', generatedAt: new Date().toISOString().slice(0, 10), count: entries.length, entries }, null, 2) + '\n');
  console.log('wrote ' + entries.length + ' Backed issuer-official entries → ' + outArg + ' | chains: ' + JSON.stringify(byChain));
}

if (require.main === module) main();
module.exports = { buildFromBacked, API, NET2CHAIN };
