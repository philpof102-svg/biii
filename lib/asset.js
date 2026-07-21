'use strict';
/**
 * BIII asset — the trust registry, pointed at TOKENIZED ASSETS (stocks, treasuries, RWA).
 * ==================================================================================================
 * Phil's insight (2026-07-21): the same layer that says "safe to pay this merchant" says "safe to
 * ACQUIRE this tokenized asset". Tokenized equities/RWA are already live on Base (Backed/xStocks,
 * Dinari dShares, Ondo GM, BlackRock BUIDL >$2.5B) — and the #1 fraud (FBI + wallet advisories, 2026)
 * is TOKEN IMPERSONATION: a fake token cloning a real issuer, often from a lookalike address. The
 * question "is this contract the GENUINE issuer's, or an impersonator?" is a registry + verdict — the
 * exact primitive BIII already runs for known-bad wallets, turned toward RWA.
 *
 * assessAsset() answers, fail-closed:
 *   genuine        — the contract IS a verified issuer's token (matches the registry; claim, if any, checks out)
 *   impersonation  — it CLAIMS to be a known asset but is NOT that issuer's real contract (the dangerous case)
 *   unsafe         — the contract is denylisted (scam/known-bad)
 *   unknown        — not a verified issuer contract: unverified, never assume genuine
 *
 * ⚠️ AUTHORITATIVE SOURCE, like the sanctions denylist. A wrong "genuine" address would BLESS a fake, so
 * the registry MUST be sourced from each issuer's OFFICIAL contract page (BlackRock/Securitize, Ondo,
 * Backed, Dinari…) — never hand-guessed. The SEED below is a tiny set of examples, each with a `source`
 * and marked to re-verify; in production the registry is injected (bring-your-own, per issuer official docs).
 */

const lower = (s) => String(s || '').toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lower(a));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * SEED registry — EXAMPLES ONLY. Each entry MUST be re-verified against the issuer's official contract
 * page before production trust (a wrong address here would bless an impersonator). Shape:
 *   { issuer, symbol, name, chainId, address, source }
 * Base-native tokenized-stock addresses (Backed/xStocks, Dinari dShares) are intentionally NOT hard-coded
 * here yet — pull them from the issuers' official lists into the injected registry.
 */
const SEED_REGISTRY = [
  { issuer: 'BlackRock', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity',
    chainId: 1, address: '0x7712c34205737192402172409a8f7ccef8aa2aec',
    source: 'BlackRock/Securitize official — RE-VERIFY at securitize.io before production' },
  // add Ondo (USDY/OUSG), Backed xStocks (Base), Dinari dShares (Base) from their OFFICIAL pages.
];

/**
 * assessAsset — is this tokenized-asset contract safe to acquire?
 *   input : { token, claimedIssuer?, claimedSymbol? }   (what the token IS + what it CLAIMS to be)
 *   opts  : { registry = SEED_REGISTRY, denylist = Set() }  (injected: sourced from issuer docs + known-bad)
 * Fail-closed: an unknown contract is 'unknown' (never 'genuine'); a claim that doesn't match a verified
 * address is 'impersonation'; a denylisted contract is 'unsafe' and overrides everything.
 */
function assessAsset({ token, claimedIssuer, claimedSymbol } = {}, { registry = SEED_REGISTRY, denylist } = {}) {
  const addr = lower(token);
  if (!isAddr(addr)) return { status: 'invalid', reason: 'not a 0x contract address', safeToAcquire: false };

  // normalize REGARDLESS of container — a Set of checksummed (EIP-55) addresses was used as-is before,
  // so the lowercased lookup key never matched and the whole denylist silently no-op'd.
  const deny = new Set([...(denylist instanceof Set ? denylist : (denylist || []))].map(lower));
  if (deny.has(addr)) return { status: 'unsafe', reason: 'contract is denylisted (scam / known-bad)', safeToAcquire: false };

  const reg = Array.isArray(registry) ? registry : SEED_REGISTRY;
  const entry = reg.find((e) => lower(e.address) === addr);

  if (entry) {
    // The contract IS a verified issuer token. If a claim was made, it must match — else someone is
    // labelling a real contract as the wrong asset.
    if (claimedIssuer && entry.issuer && norm(claimedIssuer) !== norm(entry.issuer))
      return { status: 'impersonation', reason: `this contract is ${entry.issuer}'s ${entry.symbol}, not ${claimedIssuer}`, safeToAcquire: false };
    if (claimedSymbol && norm(claimedSymbol) !== norm(entry.symbol))
      return { status: 'impersonation', reason: `this contract is ${entry.symbol}, not ${claimedSymbol}`, safeToAcquire: false };
    return { status: 'genuine', issuer: entry.issuer, symbol: entry.symbol, name: entry.name || null,
      chainId: entry.chainId ?? null, source: entry.source || null, safeToAcquire: true };
  }

  // Unknown contract. THE dangerous case: it CLAIMS to be an asset we DO have a genuine address for,
  // but this address is not it → impersonation (lookalike / cloned token).
  if (claimedSymbol || claimedIssuer) {
    const known = reg.find((e) =>
      (claimedSymbol && norm(e.symbol) === norm(claimedSymbol)) ||
      (claimedIssuer && norm(e.issuer) === norm(claimedIssuer)));
    if (known && lower(known.address) !== addr)
      return { status: 'impersonation',
        reason: `claims ${claimedSymbol || claimedIssuer} but the genuine ${[known.issuer, known.symbol].filter(Boolean).join(' ')} is ${known.address}, not this contract`,
        genuineAddress: lower(known.address), safeToAcquire: false };
  }
  return { status: 'unknown', reason: 'not a verified issuer contract — unverified, do not assume genuine', safeToAcquire: false };
}

/**
 * assetVertex — map an asset verdict into the trust-triangle's reputation vertex, so acquiring a
 * tokenized asset composes with counterparty reputation + on-chain settlement in assessTriangle().
 *   genuine → safe · impersonation/unsafe → flag (overrides) · unknown → weak
 */
function assetVertex(assetVerdict) {
  if (!assetVerdict) return { decision: null, score: null };
  if (assetVerdict.status === 'genuine') return { decision: 'PROCEED', score: 80, note: `${assetVerdict.issuer} ${assetVerdict.symbol} (verified)` };
  if (assetVerdict.status === 'impersonation' || assetVerdict.status === 'unsafe') return { decision: 'REFUSE', score: 0, note: assetVerdict.reason };
  return { decision: null, score: 10, note: 'unverified contract' }; // unknown/invalid → weak, not safe
}

module.exports = { assessAsset, assetVertex, SEED_REGISTRY };
