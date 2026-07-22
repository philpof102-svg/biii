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

const crypto = require('node:crypto');
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

/**
 * screenMeta — the FRESHNESS disclosure. A "not-known-bad" result is only as current as the list it was
 * checked against: an address sanctioned yesterday is invisible to a snapshot from last month. So every
 * verdict that leans on the screen must carry the list's age and say so plainly — the lesson a stale,
 * authoritative-looking record teaches the hard way (a frozen list that can't admit it is stale is worse
 * than no list). `now` is injectable for deterministic tests.
 */
const STALE_DAYS = 30;
function screenMeta(screenOrData, { now = Date.now() } = {}) {
  const s = screenOrData && screenOrData.set instanceof Set ? screenOrData : loadScreen(screenOrData);
  const t = s.asOf ? Date.parse(s.asOf) : NaN;
  const ageDays = Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
  const stale = ageDays != null && ageDays > STALE_DAYS;
  const disclosure = !s.available
    ? 'known-bad screening UNAVAILABLE (no list loaded) — a "not-known-bad" here is NOT a clean verdict'
    : stale
      ? 'known-bad list is ' + ageDays + ' days old (as of ' + s.asOf + ') — a recently-sanctioned address may not be covered; re-run scripts/biii-known-bad-ingest.js'
      : 'known-bad list current as of ' + (s.asOf || 'unknown') + ' (' + (ageDays == null ? 'age unknown' : ageDays + 'd old') + ', ' + s.count + ' addresses)';
  return { available: s.available, count: s.count, asOf: s.asOf, sources: s.sources, ageDays, stale, disclosure };
}

/**
 * floorFingerprint — a CANONICAL content hash of the known-bad floor, so two independent nodes can prove
 * they judge on the SAME floor without trusting each other or any operator. Deterministic: the addresses
 * are sorted (Set order is insertion-order, not canonical), joined with asOf + sorted sources, then
 * sha256'd. Same (addresses, asOf, sources) ⇒ same fingerprint, everywhere. This is how "is the floor the
 * same here as there?" becomes a checkable fact — the convergence is on PUBLIC DATA + a deterministic hash,
 * never on a central operator. (sha256, not keccak — this is a content fingerprint, not an EVM ABI call.)
 */
function floorFingerprint(screenOrData) {
  const s = screenOrData && screenOrData.set instanceof Set ? screenOrData : loadScreen(screenOrData);
  const addrs = [...s.set].sort();                                   // canonical order — node-independent
  const sources = (Array.isArray(s.sources) ? s.sources.slice() : []).sort();
  const canonical = JSON.stringify({ v: 1, asOf: s.asOf || null, sources, count: addrs.length, addresses: addrs });
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * floorProvenance — the re-verifiable descriptor of a node's known-bad floor: its fingerprint (compare it
 * with any other node), what it is (count + asOf + sources), its freshness, and how to re-derive it. The
 * point: a node NEVER asks you to trust its floor — it names public sources + a fingerprint so you rebuild
 * the floor yourself (scripts/biii-known-bad-ingest.js against the same MIT lists) and confirm the hash.
 * Decentralized-by-construction: same public sources → same fingerprint → same floor, with no operator.
 */
function floorProvenance(screenOrData, { now = Date.now() } = {}) {
  const meta = screenMeta(screenOrData, { now });
  return {
    fingerprint: floorFingerprint(screenOrData),
    count: meta.count, asOf: meta.asOf, sources: meta.sources, ageDays: meta.ageDays, stale: meta.stale,
    available: meta.available,
    reDerive: 'scripts/biii-known-bad-ingest.js against the named public sources — recompute the fingerprint and confirm it matches.',
    note: 'This floor is NOT an operator\'s word: the sources are public + open-licensed and the fingerprint is a deterministic content hash. Two nodes with the SAME fingerprint judge on the SAME known-bad floor; a different fingerprint means different data, not a different opinion. Decentralized: convergence is on public data + the hash, never on a central node.',
  };
}

module.exports = { loadScreen, screenAddress, screenMeta, floorFingerprint, floorProvenance, STALE_DAYS };
