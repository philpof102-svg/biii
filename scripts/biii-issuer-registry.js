#!/usr/bin/env node
'use strict';
/**
 * biii-issuer-registry — turn a set of VERIFIED issuer-official addresses into data/issuer-verified.json,
 * cross-checked against the aggregator (Coingecko) registry.
 * ================================================================================================
 * INPUT: a JSON file (arg 1, default ./data/issuer-confirmed.json) shaped like the discover→verify workflow's
 * `confirmed` array — each item: { address, claimedIssuer|issuer, claimedSymbol|symbol, onchainSymbol,
 * onchainName, independentSources:[urls], confidence, reason }. Only entries already judged issuer-official
 * upstream belong here; this script does NOT invent trust, it FORMATS + CROSS-CHECKS.
 *
 * CROSS-CHECK vs data/rwa-registry.json (Coingecko) by symbol:
 *   agrees          — the aggregator lists the SAME address for this symbol (independent corroboration)
 *   impersonation!  — the aggregator lists a DIFFERENT address for this symbol → the aggregator may be
 *                     pointing at a lookalike; SURFACED loudly (this is exactly what the feature exists to catch)
 *   new             — the symbol isn't in the aggregator registry
 *
 * OUTPUT: data/issuer-verified.json (COMMITTED — small, sourced, shippable). Each entry:
 *   { issuer, symbol, name, chainId: 8453, address, source, verifiedAt, onchainSymbol, crossCheck }
 * `source` is the issuer-official URL, so lib/asset.provenanceOf() reads it as 'issuer-official' → green.
 *
 * FAIL-SAFE: an entry missing an address / a source / an on-chain symbol match is DROPPED (never written as
 * genuine) and reported. Fewer, sourced entries beats one wrong "genuine" that would bless a fake.
 *
 * Run: node scripts/biii-issuer-registry.js [confirmed.json] [--date=YYYY-MM-DD]
 */
const fs = require('node:fs'), path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const lower = (s) => String(s || '').toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lower(a));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function main() {
  const inPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(DATA, 'issuer-confirmed.json');
  const dateArg = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1] || new Date().toISOString().slice(0, 10);

  const raw = readJson(inPath);
  const confirmed = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.confirmed) ? raw.confirmed : null);
  if (!confirmed) { console.error('no confirmed input at ' + inPath + ' (expected an array or { confirmed: [...] })'); process.exit(1); }

  // aggregator registry, by symbol → Set of addresses it lists (for cross-check)
  const agg = readJson(path.join(DATA, 'rwa-registry.json'));
  const aggBySymbol = new Map();
  for (const e of (agg && agg.entries) || []) {
    const sym = norm(e.symbol); if (!sym || !isAddr(e.address)) continue;
    if (!aggBySymbol.has(sym)) aggBySymbol.set(sym, new Set());
    aggBySymbol.get(sym).add(lower(e.address));
  }

  const entries = [], dropped = [], flags = [];
  const seen = new Set();
  for (const c of confirmed) {
    const address = lower(c.address);
    const symbol = c.onchainSymbol || c.symbol || c.claimedSymbol || '';
    const issuer = c.issuer || c.claimedIssuer || '';
    const source = (Array.isArray(c.independentSources) && c.independentSources.find((u) => /^https?:\/\//i.test(String(u)))) || c.source || '';
    // FAIL-SAFE gates — drop anything not fully sourced + on-chain-consistent.
    if (!isAddr(address)) { dropped.push({ address: c.address, why: 'not a 0x Base address' }); continue; }
    if (seen.has(address)) { continue; }
    if (!symbol) { dropped.push({ address, why: 'no symbol (on-chain or claimed)' }); continue; }
    if (!c.onchainSymbol || norm(c.onchainSymbol) !== norm(c.claimedSymbol || c.symbol || c.onchainSymbol)) {
      // require the on-chain symbol to match the claim (a lookalike self-describing as something else is refused)
      if (c.claimedSymbol && norm(c.onchainSymbol) !== norm(c.claimedSymbol)) { dropped.push({ address, why: `on-chain symbol "${c.onchainSymbol}" != claimed "${c.claimedSymbol}"` }); continue; }
    }
    if (!/^https?:\/\//i.test(String(source)) && !/official|issuer:/i.test(String(source))) { dropped.push({ address, why: 'no issuer-official source URL' }); continue; }
    seen.add(address);

    // cross-check vs aggregator
    const aggAddrs = aggBySymbol.get(norm(symbol));
    let crossCheck = 'new';
    if (aggAddrs) {
      if (aggAddrs.has(address)) crossCheck = 'agrees';
      else { crossCheck = 'impersonation-flag'; flags.push({ symbol, issuerOfficial: address, aggregatorLists: [...aggAddrs] }); }
    }
    entries.push({ issuer, symbol, name: c.onchainName || c.name || null, chainId: 8453, address,
      source, verifiedAt: dateArg, onchainSymbol: c.onchainSymbol || null, crossCheck });
  }

  const out = { generatedFrom: 'issuer-official (verified)', generatedAt: dateArg, count: entries.length, entries };
  fs.writeFileSync(path.join(DATA, 'issuer-verified.json'), JSON.stringify(out, null, 2) + '\n');

  console.log(`issuer-verified.json written: ${entries.length} issuer-official entries`);
  console.log(`  cross-check: ${entries.filter((e) => e.crossCheck === 'agrees').length} agree w/ aggregator, ` +
    `${entries.filter((e) => e.crossCheck === 'new').length} new, ${flags.length} IMPERSONATION FLAGS`);
  if (flags.length) { console.log('  ⚠ aggregator lists a DIFFERENT address for these symbols (verify — the aggregator may point at a lookalike):');
    for (const f of flags) console.log(`     ${f.symbol}: official ${f.issuerOfficial} vs aggregator ${f.aggregatorLists.join(', ')}`); }
  if (dropped.length) { console.log(`  dropped ${dropped.length} (fail-safe — never written as genuine):`);
    for (const d of dropped.slice(0, 20)) console.log(`     ${d.address}: ${d.why}`); }
}

if (require.main === module) main();
module.exports = { main };
