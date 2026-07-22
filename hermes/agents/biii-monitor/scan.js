#!/usr/bin/env node
'use strict';
/**
 * biii-monitor scan — the surveillance engine of a Hermes agent that watches Base for TRUST threats.
 * ================================================================================================
 * A Hermes cron runs this on a schedule; it checks a WATCHLIST (addresses + token contracts) through the
 * BIII trust layer and emits a brief of FLAGS — known-bad wallets and impersonation/look-alike tokens — so
 * the agent can act (alert, and DELEGATE a deeper follow-up task per flag). Pure + offline-verifiable: it
 * uses the committed known-bad floor + the 147-contract issuer-verified registry, so it flags with zero
 * network. Non-custodial, fail-closed, re-verifiable on-chain — it never moves funds.
 *
 * Watchlist: JSON { addresses: ["0x…"], tokens: [{address, claimedIssuer?, claimedSymbol?}] }.
 * Output: { generatedAt?, checked, flags: [...], brief } — flags are what a Hermes agent alerts + delegates on.
 *
 * Run: node scan.js [watchlist.json]   (defaults to ./watchlist.json)
 */
const fs = require('node:fs'), path = require('node:path');
const { screenAddress } = require('../../../lib/screen');
const { loadFloor } = require('../../../lib/vet');
const { assessAsset } = require('../../../lib/asset');
const { loadAssetRegistry } = require('../../../lib/asset-registry');

/** scanWatchlist — PURE (floor + registry injectable). Turn a watchlist into a flag list. */
function scanWatchlist(watchlist, { floor, registry } = {}) {
  const wl = watchlist && typeof watchlist === 'object' ? watchlist : {};
  const flags = [];
  let checked = 0;

  for (const a of Array.isArray(wl.addresses) ? wl.addresses : []) {
    checked++;
    const scr = screenAddress(a, floor);
    if (scr.blocked) flags.push({ kind: 'wallet', severity: 'high', q: String(a).toLowerCase(), verdict: 'known-bad',
      reason: scr.reason, delegate: 'trace recent transfers of this known-bad wallet on Base and list any counterparties it touched.' });
  }

  for (const tk of Array.isArray(wl.tokens) ? wl.tokens : []) {
    checked++;
    const v = assessAsset({ token: tk.address, claimedIssuer: tk.claimedIssuer, claimedSymbol: tk.claimedSymbol }, { registry });
    if (v.status === 'impersonation') flags.push({ kind: 'token', severity: 'high', q: String(tk.address).toLowerCase(), verdict: 'impersonation',
      reason: v.reason, genuine: v.genuineAddress || null,
      delegate: 'investigate this look-alike: find the deployer, check when it was created, and whether any wallets have already been drained to it.' });
    else if (v.status === 'unsafe') flags.push({ kind: 'token', severity: 'high', q: String(tk.address).toLowerCase(), verdict: 'unsafe', reason: v.reason,
      delegate: 'confirm the denylist source for this contract and check its recent transfer volume.' });
    // genuine / unknown are NOT flags — a monitor alerts on threats, not on clean or merely-unverified.
  }

  const brief = flags.length
    ? `⚠ ${flags.length} flag(s) on the watchlist: ` + flags.map((f) => `${f.verdict} ${f.q.slice(0, 10)}…`).join(', ')
    : `✓ clean — ${checked} watched item(s), no known-bad wallet or impersonation token detected.`;
  return { checked, flags, brief };
}

const briefKey = (f) => f.verdict + ':' + f.q;
const hhmm = (iso) => { try { return new Date(iso).toISOString().slice(11, 16) + 'Z'; } catch { return '?'; } };

function main() {
  const wlPath = process.argv[2] || path.join(__dirname, 'watchlist.json');
  let watchlist = { addresses: [], tokens: [] };
  try { watchlist = JSON.parse(fs.readFileSync(wlPath, 'utf8')); } catch { console.error('no watchlist at ' + wlPath + ' — using empty'); }
  const floor = loadFloor();
  const registry = loadAssetRegistry().entries || [];
  const cacheFile = path.join(__dirname, 'cache', 'brief.json');

  // A monitor reports CHANGE, not the same standing list every 30 min. Diff this run against the last
  // one (still in the cache until we overwrite it) so the journal reads as events, not repeated noise.
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run — no prior brief */ }

  const out = scanWatchlist(watchlist, { floor, registry });
  out.generatedAt = new Date().toISOString();
  const prevFlags = (prev && Array.isArray(prev.flags)) ? prev.flags : [];
  const prevKeys = prevFlags.map(briefKey);
  const nowKeys = out.flags.map(briefKey);
  const fresh = out.flags.filter((f) => !prevKeys.includes(briefKey(f)));
  const cleared = prevFlags.filter((f) => !nowKeys.includes(briefKey(f)));
  out.delta = { new: fresh.map(briefKey), cleared: cleared.map(briefKey), since: (prev && prev.generatedAt) || null };

  // write the brief to the cron cache (HOODRADAR pattern) for the Hermes agent / the /radar to ingest.
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2) + '\n'); } catch {}

  // Headline is change-first: first run → the raw brief; then only shout when something is new/cleared,
  // otherwise say plainly that nothing changed (with the count still standing).
  let head;
  if (!prev) head = out.brief;
  else if (fresh.length || cleared.length)
    head = `${out.brief}  ·  🆕 ${fresh.length} new, ${cleared.length} cleared since ${hhmm(prev.generatedAt)}`;
  else head = out.flags.length
    ? `✓ no change since ${hhmm(prev.generatedAt)} — ${out.flags.length} standing flag(s), nothing new on the watchlist.`
    : out.brief;

  console.log(head);
  for (const f of out.flags) {
    const isNew = fresh.some((g) => briefKey(g) === briefKey(f));
    console.log(`  ${isNew ? '🆕' : '🚩'} ${f.kind} ${f.verdict} — ${f.q}  (delegate: ${f.delegate})`);
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { scanWatchlist };
