#!/usr/bin/env node
'use strict';
/**
 * biii-known-bad-ingest — build data/known-bad.json from PUBLIC, open-licensed known-bad lists, so the
 * local screen (lib/screen.js) becomes the real ~3k-address floor instead of the OFAC-only seed. Every
 * node can run this ITSELF → the safety floor is decentralized by construction, with zero dependency on
 * any hosted service (that is the whole point: MainStreet going down can never remove the block).
 *
 * LICENSE DISCIPLINE (bundled output must be redistributable):
 *   • OFAC SDN (0xB10C, MIT) + dawsbot/eth-labels (MIT) — bundled by DEFAULT.
 *   • ScamSniffer (GPL-3.0) — opt-in via --include-gpl. A GPL list must NOT be redistributed inside a
 *     permissive package, so the CLI refuses to write it into data/known-bad.json unless you also pass
 *     --gpl-out=<file>; treat that file as a runtime self-ingest artifact, never committed/shipped.
 *
 * Ports the hardened filter core proven in avisradar/scripts/mainstreet-denylist-watcher.js — the
 * eth-labels malicious taxonomy + co-occurrence guard + KNOWN_SAFE allowlist + partial caps + strict
 * address validation — SELF-CONTAINED here so biii has no cross-repo dependency. Pure core is exported.
 *
 * Run:  node scripts/biii-known-bad-ingest.js                       # MIT sources → data/known-bad.json
 *       node scripts/biii-known-bad-ingest.js --include-gpl --gpl-out=data/known-bad.local.json
 */

const fs = require('node:fs');
const path = require('node:path');

// ── eth-labels malicious taxonomy (from the real 144k-row file; 'blocked' deliberately EXCLUDED — it is
//    a mixed legit bucket that would denylist SushiSwap/Yearn/Binance-deposit addresses). ─────────────
const MAL_EXACT = new Set([
  'phish-hack', 'ofac-sanctions-lists', 'ofac-sanctioned', 'heist', 'exploit',
  'tornado-cash', 'mixer', 'ethereum-mixer', 'scam', 'compromised',
]);
const MAL_PATTERN = /-exploit$|^exploit$|(^|-)(hack|heist|drain|launder|phish|scam|rug|sanction)(-|$)/;
const LEGIT_LABELS = new Set([
  'exchange', 'token-contract', 'bridged-token', 'contract-deployer', 'old-contract', 'deposit',
  'cex', 'proposer-fee-recipient', 'mev-bot', 'avs-operator', 'erc-4337-bundler', 'bridge',
  'genesis-address', 'maker-vault-owner', 'bitget', 'deribit', 'bilaxy', 'bancor', 'sushiswap',
  'yearn', 'synthetix', 'pendle', 'the-graph', 'balancer', 'pimlico', 'burgerswap', 'endaoment',
]);
const LEGIT_NAMETAG = /\b(token|stablecoin|deposit|exchange|bridge|vault|router|staking)\b|dep(osit)?[:.]/i;

function maliciousReason(labels, nameTags) {
  for (const l of labels) { if (MAL_EXACT.has(l) || MAL_PATTERN.test(l)) return l; }
  for (const nt of nameTags) { if (/fake[_\s-]?phishing/i.test(nt)) return 'Fake_Phishing nameTag'; }
  return null;
}
function hasLegitContext(labels, nameTags) {
  for (const l of labels) { if (LEGIT_LABELS.has(l)) return true; }
  for (const nt of nameTags) { if (LEGIT_NAMETAG.test(nt) || /token$|stablecoin$/i.test(nt.trim())) return true; }
  return false;
}

// Canonical asset contracts a source may mislabel — NEVER denylist (verified false positives).
const KNOWN_SAFE_CONTRACTS = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // BSC-USDT (mislabeled Fake_Phishing on Etherscan)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT (ETH)
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI (ETH)
  '0x4200000000000000000000000000000000000006', // WETH (Base)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH (ETH)
]);

const ADDR_RE = /^0x[0-9a-f]{40}$/;

function cleanAddr(raw) {
  return String(raw == null ? '' : raw).normalize('NFKC')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .trim().toLowerCase();
}

// Minimal RFC-4180-ish CSV tokenizer (quoted fields with embedded commas/newlines/"").
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false; const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ── source parsers (pure) ───────────────────────────────────────────────────────────────────────
function parseOfac(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((address) => ({ address }));
}
function parseEthLabels(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const ai = header.indexOf('address'), li = header.indexOf('label'), ni = header.indexOf('nametag');
  if (ai < 0 || li < 0) return [];
  const agg = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]; if (!row || row.length <= li) continue;
    const addr = String(row[ai] || '').trim().toLowerCase(); if (!addr) continue;
    const label = String(row[li] || '').trim().toLowerCase();
    const nameTag = ni >= 0 ? String(row[ni] || '').trim() : '';
    let a = agg.get(addr); if (!a) { a = { labels: new Set(), nameTags: [] }; agg.set(addr, a); }
    if (label) a.labels.add(label); if (nameTag) a.nameTags.push(nameTag);
  }
  const out = [];
  for (const [address, a] of agg) {
    const reason = maliciousReason(a.labels, a.nameTags);
    if (!reason) continue;                                // no malicious label → skip
    if (hasLegitContext(a.labels, a.nameTags)) continue;  // co-occurring legit entity → skip (avoid FP)
    out.push({ address });
  }
  return out;
}

const MIT_SOURCES = [
  { id: 'OFAC SDN — github.com/0xB10C/ofac-sanctioned-digital-currency-addresses (MIT)', cap: 20000, license: 'MIT',
    url: 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt', parse: parseOfac },
  { id: 'dawsbot/eth-labels malicious subset (MIT)', cap: 50000, license: 'MIT',
    url: 'https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv', parse: parseEthLabels },
];
const GPL_SOURCE = { id: 'ScamSniffer scam-database (GPL-3.0) — runtime self-ingest only, not redistributed', cap: 60000, license: 'GPL-3.0',
  url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json', parse: (t) => (JSON.parse(t) || []).map((address) => ({ address })) };

/** normalize + KNOWN_SAFE guard + validate. Returns { kept:[0x…], rejected:n } so drops are observable. */
function normalize(items) {
  const kept = []; let rejected = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const address = cleanAddr(typeof it === 'string' ? it : (it && it.address));
    if (!ADDR_RE.test(address)) { rejected++; continue; }
    if (KNOWN_SAFE_CONTRACTS.has(address)) continue;
    kept.push(address);
  }
  return { kept, rejected };
}

/** PURE core: fold one-or-more source pulls into the known-bad.json shape. Dedup, partial cap, sorted. */
function buildKnownBad(pulls, { asOf, sources }) {
  const set = new Set(); let rejectedTotal = 0;
  for (const p of pulls) {
    const { kept, rejected } = normalize(p.items);
    rejectedTotal += rejected;
    const capped = kept.length > p.cap ? kept.slice(0, p.cap) : kept;   // PARTIAL, never zero
    for (const a of capped) set.add(a);
  }
  return {
    asOf: asOf || null,
    note: 'Bundled snapshot of PUBLIC known-bad addresses, built by scripts/biii-known-bad-ingest.js. The node screens against this LOCALLY — no hosted oracle needed for the hard block. Re-verifiable against the named sources. Absence of an entry is NOT a clean verdict.',
    sources: sources || [],
    addresses: [...set].sort(),
    _rejected: rejectedTotal,
  };
}

/**
 * OWN_FINDINGS — addresses THIS project proved itself, and the only source here with no network and no URL.
 *
 * Every other source is somebody else's list. This one is the reason a local floor beats a copy of third-party
 * feeds: on the drainer below, Blockscout returns `is_scam: false` to this day. The explorer does not know. We
 * do, because we traced it.
 *
 * It lives in code rather than being hand-added to data/known-bad.json for a specific reason: that file is
 * REPLACED on every ingest, never merged, so a hand-edit would be silently erased the next time anyone ran the
 * script. A finding that disappears on the next run is not in the floor.
 *
 * The bar for adding a row is deliberately high, and it is the same bar this codebase applies everywhere:
 *   - proven by a TRANSACTION whose `tx.from` is the claimed sender, never by an event log;
 *   - the tx hash recorded, so anyone can refute it;
 *   - structure only. An address that RECEIVED stolen funds is what is recorded. Who controls it is not stated.
 *
 * What is deliberately NOT here matters as much. The stolen funds moved through MetaMask's Meta Bridge, a
 * swap adapter and Bridgers SSwap on the way out. All three are legitimate infrastructure with hundreds of
 * thousands of users, and the first was very nearly published as "the thief's wallet". Being on a stolen
 * fund's path is not evidence — a floor that blocked those would break every honest bridge user.
 *
 * Coverage boundary, stated because silence here would read as coverage: this screen is EVM-only
 * (`^0x[0-9a-f]{40}$`). The money left via TRON, so the relay and terminus addresses that actually hold it
 * CANNOT be represented in this floor at all. The trail is in the case file; the block stops at the bridge.
 */
const OWN_FINDINGS = {
  id: 'MainStreet own forensic findings (first-party, tx-verified)',
  cap: 5000,
  license: 'first-party',
  items: [
    { address: '0x7239C278139Ea353C0375d5b8c67b33123026a71',
      reason: 'received a wallet drain on Base — a disposable collector with no prior history. Proven by ' +
        'transaction, not by an event log: tx.from is the victim key, 2026-07-23T04:42:03Z, after TOSHI and ' +
        'MOTO were swept in the preceding 34 seconds. Blockscout still reports is_scam:false for it.',
      provenAt: '2026-07-23' },
  ],
};

/** ingest (I/O): fetch each source, build, return {data, report}. fetchImpl injectable for tests. */
async function ingest(fetchImpl, { includeGpl = false, timeoutMs = 25000 } = {}) {
  const chosen = includeGpl ? [...MIT_SOURCES, GPL_SOURCE] : MIT_SOURCES;
  const pulls = []; const report = {};
  for (const src of chosen) {
    const r = { seen: 0, rejected: 0, error: null };
    try {
      const res = await Promise.race([
        fetchImpl(src.url, { headers: { accept: '*/*' } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      if (!res || res.ok === false) throw new Error('HTTP ' + (res && res.status));
      const items = src.parse(await res.text());
      pulls.push({ items, cap: src.cap });
      r.seen = Array.isArray(items) ? items.length : 0;
    } catch (e) { r.error = e.message; }   // a failed source leaves the others intact (never zero the floor)
    report[src.id] = r;
  }
  // First-party findings last, and unconditionally. No fetch means nothing to time out and nothing to fail,
  // so these are the one part of the floor that cannot be removed by a network problem — which is exactly the
  // property the hard block needs most.
  pulls.push({ items: OWN_FINDINGS.items, cap: OWN_FINDINGS.cap });
  report[OWN_FINDINGS.id] = { seen: OWN_FINDINGS.items.length, rejected: 0, error: null };

  const okSources = chosen.filter((s) => !report[s.id].error).map((s) => s.id).concat(OWN_FINDINGS.id);
  return { data: buildKnownBad(pulls, { asOf: isoDay(), sources: okSources }), report };
}

function isoDay() { return new Date().toISOString().slice(0, 10); }

module.exports = { buildKnownBad, normalize, parseOfac, parseEthLabels, parseCsv, cleanAddr, maliciousReason, hasLegitContext, ingest, MIT_SOURCES, GPL_SOURCE, OWN_FINDINGS, KNOWN_SAFE_CONTRACTS };

// ── run as a maintainer script ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const includeGpl = args.includes('--include-gpl');
  const gplOut = (args.find((a) => a.startsWith('--gpl-out=')) || '').split('=')[1] || null;
  if (includeGpl && !gplOut) {
    console.error('Refusing to write a GPL-3.0 list into the bundled data/known-bad.json. Pass --gpl-out=<file>\n' +
      '(that file is a RUNTIME self-ingest artifact — do NOT commit or redistribute it).');
    process.exit(2);
  }
  (async () => {
    const { data, report } = await ingest(fetch, { includeGpl });
    for (const [id, r] of Object.entries(report)) console.log(`[known-bad] ${id}: ${r.error ? 'FAILED ' + r.error : r.seen + ' rows'}`);
    if (!data.addresses.length) { console.error('[known-bad] every source failed — leaving the existing file intact'); process.exit(1); }
    const outPath = includeGpl && gplOut ? path.resolve(gplOut) : path.join(__dirname, '..', 'data', 'known-bad.json');
    const rejected = data._rejected; delete data._rejected;

    // What CHANGED, before overwriting. This ingest REPLACES the file rather than accumulating, and that is
    // the right call: when an upstream removes an address because it was a false positive — a Binance deposit,
    // an AMM router, the exact mislabels this filter was built to survive — a monotonic floor would keep
    // blocking it forever. Replacement is correct; doing it SILENTLY is not. An address that blocked on Monday
    // and quietly stops blocking on Friday is a fail-open with no evidence it happened, so the delta is
    // printed on every run and losses are called out separately from gains.
    // Measured 2026-07-26: 811 -> 811, nothing gained, nothing lost. The risk is structural, not current —
    // which is exactly why it needs a witness rather than a fix.
    let delta = null;
    try {
      if (fs.existsSync(outPath)) {
        const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const before = new Set((prev.addresses || []).map((a) => String(a).toLowerCase()));
        const after = new Set(data.addresses.map((a) => String(a).toLowerCase()));
        const lost = [...before].filter((a) => !after.has(a));
        const gained = [...after].filter((a) => !before.has(a));
        delta = { was: before.size, lost, gained };
      }
    } catch { /* unreadable previous file: report no delta rather than a wrong one */ }

    fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`[known-bad] wrote ${data.addresses.length} addresses to ${path.relative(process.cwd(), outPath)} (asOf ${data.asOf}, ${rejected} rejected)`);
    if (!delta) {
      console.log('[known-bad] no previous file at that path, so this run has no delta to report');
    } else {
      console.log(`[known-bad] delta vs previous: ${delta.was} -> ${data.addresses.length}  (+${delta.gained.length} / -${delta.lost.length})`);
      if (delta.lost.length) {
        // Loud on purpose. These addresses used to be blocked by this floor and no longer are.
        console.log(`[known-bad] ${delta.lost.length} address(es) STOPPED being known-bad — upstream dropped them. Verify before shipping:`);
        for (const a of delta.lost.slice(0, 25)) console.log(`[known-bad]   LOST ${a}`);
        if (delta.lost.length > 25) console.log(`[known-bad]   … and ${delta.lost.length - 25} more`);
      }
    }
  })().catch((e) => { console.error('[known-bad] fatal:', e.message); process.exit(1); });
}
