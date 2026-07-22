'use strict';
/**
 * BIII local vet — the LOCAL safe-to-pay verdict, extracted ONCE so every surface judges identically.
 * ================================================================================================
 * The same composition (known-bad screen → trust-core classifier → floor provenance) used to live inside
 * bin/biii-mcp.js only; extracting it here lets the MCP tool, the REST endpoint (GET /trust), and any
 * embedder share ONE code path — surfaces can't drift apart (the same drift-kill discipline as trust-core
 * itself: one judgment, many mouths).
 *
 * Everything is LOCAL + pure-ish (fs read at load, no network): the known-bad floor is this node's own
 * file, trust-core is this node's own classifier. Fail-closed all the way down:
 *   - floor file absent   ⇒ available:false ⇒ "screening UNAVAILABLE", never a silent "clean".
 *   - trust-core absent   ⇒ classifier:null (disclosed) — the screen-based BLOCK path still fires.
 *   - no behavioral score ⇒ a clean read caps at PROCEED_LOW_VALUE, never a confident PROCEED.
 */
const { loadScreen, screenAddress, screenMeta, floorProvenance } = require('./screen');
const fs = require('node:fs'), path = require('node:path');

// trust-core — MainStreet's JUDGMENT extracted PURE (same classifier, zero DB/network). Resilient resolve:
// the published package name, else the local sibling repo; neither present ⇒ null (classifier lens absent,
// screen BLOCK independent — safety NEVER depends on trust-core being installed).
let TC = null;
try { TC = require('trust-core'); } catch { try { TC = require('../../trust-core'); } catch { TC = null; } }

/** loadFloor — this node's known-bad floor from data/known-bad.json (absent ⇒ available:false, disclosed). */
function loadFloor(file) {
  const p = file || path.join(__dirname, '..', 'data', 'known-bad.json');
  try { if (fs.existsSync(p)) return loadScreen(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch {}
  return loadScreen(null);
}

/**
 * localClassify — MainStreet's judgment run on THIS node via trust-core (pure, no oracle). The known-bad
 * screen supplies the fail-closed DENY lens; the endpoint URL (if known) supplies the phishing/http/admin
 * URL lens. No behavioral score locally ⇒ clean caps at PROCEED_LOW_VALUE. Returns null when trust-core
 * is not installed (callers disclose). knownBad/tc injectable for tests.
 */
function localClassify(address, { resourceUrl, knownBad, tc = TC } = {}) {
  if (!tc) return null;
  const kb = knownBad || loadScreen(null);
  const scr = screenAddress(address, kb);
  const meta = screenMeta(kb);
  const deny = { available: meta.available, asOf: meta.asOf, entry: scr.blocked ? { reason: scr.reason, severity: 'high' } : null };
  const signals = { deny };
  if (resourceUrl) signals.bazaar = { resourcePath: String(resourceUrl) };
  // BIII's own screen + its own knowledge of the endpoint = a locally-trusted signal bag (trustedSignals).
  const v = tc.verdict(signals, null, { trustedSignals: true });
  return { decision: v.decision, allowed: v.allowed, color: v.shield.color, reasonShort: v.shield.reasonShort,
    flags: v.shield.flags, explainer: v.shield.explainer,
    disclosure: 'LOCAL CLASSIFIER — MainStreet\'s judgment reproduced on THIS node via trust-core (pure, zero-oracle). Known-bad screen + endpoint-URL lens only; no behavioral score locally ⇒ a clean read is PROCEED_LOW_VALUE (low-value only), never a confident PROCEED. Holds even when the oracle is down.' };
}

/**
 * vetLocal — the whole LOCAL verdict in one call: screen (decisive) + classifier (this node's trust-core
 * read) + floor provenance (which basis judged, how fresh). This is what GET /trust serves, and what any
 * embedding app should render. NO network, NO oracle: what this node can verify itself, honestly labeled.
 */
function vetLocal(address, { resourceUrl, knownBad, tc } = {}) {
  const kb = knownBad || loadFloor();
  const addr = String(address || '').toLowerCase();
  const screen = screenAddress(addr, kb);
  const meta = screenMeta(kb);
  const prov = floorProvenance(kb);
  return {
    address: addr,
    screen: { blocked: screen.blocked, reason: screen.reason || null },      // the decisive local floor
    classifier: localClassify(addr, { resourceUrl, knownBad: kb, tc }),      // null ⇒ trust-core not installed
    floor: { available: meta.available, asOf: meta.asOf || null, ageDays: meta.ageDays ?? null,
      stale: meta.stale === true, count: meta.count ?? null, fingerprint: prov.fingerprint || null },
    disclosure: meta.available
      ? (screen.blocked
        ? 'BLOCKED on this node\'s local known-bad floor — decisive, no oracle consulted.'
        : 'Not on this node\'s known-bad floor (' + (meta.count ?? '?') + ' addresses, ' + (meta.stale ? 'STALE — re-run the ingest' : 'current') + '). NOT a clean bill: no behavioral score is computed locally.')
      : 'SCREENING UNAVAILABLE — no known-bad floor is loaded on this node. This is NOT a clean verdict; ingest the floor (scripts/biii-known-bad-ingest.js) before trusting any read.',
  };
}

module.exports = { loadFloor, localClassify, vetLocal, TC };
