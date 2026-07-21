'use strict';
/**
 * BIII screen — the DECENTRALIZED known-bad floor.
 * ================================================================================================
 * The single most important safety check — "is this a known OFAC / scam / drainer address?" — must NOT
 * depend on a hosted oracle that one operator runs. If it does, that operator going down (or slow, or
 * frozen) silently removes the block, and a Lazarus address sails through. That is a single point of
 * failure AND a single point of dependency.
 *
 * The fix is structural: the known-bad DATA is PUBLIC and open-licensed (OFAC SDN, ScamSniffer, the
 * ethereum-lists darklist…), so the node carries it LOCALLY and screens with zero network. A known-bad
 * address then BLOCKs even when every oracle is down. The live *behavioral* score (settlement history,
 * funnel signals) is a different thing — it genuinely needs aggregated data, so it stays an OPTIONAL
 * advisory layer on top. Decentralize the floor; keep the score advisory.
 *
 * FAIL-CLOSED + HONEST (the one rule a screening layer must never break): a node with no list loaded
 * reports `available:false` and screens nothing — it MUST NEVER report an address as "clean" when it
 * simply has no data. Absence of a list is not absence of risk. "Not on my list" is never "safe".
 * Pure, synchronous, zero deps, re-verifiable (the list names its own public sources + date).
 */

const lower = (a) => String(a || '').toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lower(a));

/**
 * Build a screen from a known-bad source object: { asOf, sources:[…urls], addresses:[…0x] }.
 * Malformed/off-shape input yields an EMPTY, UNAVAILABLE screen — never a screen that silently clears.
 */
function loadScreen(data) {
  const d = data && typeof data === 'object' ? data : {};
  const set = new Set((Array.isArray(d.addresses) ? d.addresses : []).map(lower).filter(isAddr));
  return {
    set,
    available: set.size > 0,
    count: set.size,
    asOf: typeof d.asOf === 'string' ? d.asOf : null,
    sources: Array.isArray(d.sources) ? d.sources.filter((s) => typeof s === 'string') : [],
  };
}

/**
 * Screen ONE address against a loaded screen (or a raw source object).
 *   blocked:true            → known-bad: this address is on the local list ⇒ the caller must BLOCK.
 *   blocked:false, available:true  → not on the list — this is NOT a clean verdict, only "not known-bad
 *                                    to THIS list"; compose with the live oracle for a real answer.
 *   blocked:false, available:false → no list loaded ⇒ screening UNAVAILABLE (fail-closed: never "clean").
 */
function screenAddress(address, screenOrData) {
  const a = lower(address);
  if (!isAddr(a)) return { blocked: false, available: false, reason: 'not a 0x address' };
  const s = screenOrData && screenOrData.set instanceof Set ? screenOrData : loadScreen(screenOrData);
  if (!s.available) return { blocked: false, available: false,
    reason: 'no known-bad list loaded — screening UNAVAILABLE, not a clean verdict' };
  const provenance = (s.sources.length ? s.sources.join(', ') : 'bundled') + ', as of ' + (s.asOf || 'unknown date');
  if (s.set.has(a)) return { blocked: true, available: true, source: 'local-known-bad',
    reason: 'address is on the local known-bad list (' + provenance + ')' };
  return { blocked: false, available: true,
    reason: 'not on the local known-bad list (' + provenance + ') — NOT a safety guarantee' };
}

module.exports = { loadScreen, screenAddress };
