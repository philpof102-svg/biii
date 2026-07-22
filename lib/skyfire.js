'use strict';
/**
 * BIII × Skyfire KYA — the agent-IDENTITY standard as a SEPARATE, advisory, re-verifiable lens.
 * ================================================================================================
 * Skyfire KYA ("Know Your Agent") is a signed JWT that binds a real human/business to an agent — now the
 * identity layer under Experian's KYA framework. It is the IDENTITY counterpart to the ERC-8004 REPUTATION
 * lens: ERC-8004 answers "how has this agent behaved?", KYA answers "who stands behind it, and is it
 * authorized?". BIII reads it as INTEROP, never a rival (COMPETITION.md: read the standards as signal
 * sources), and — like every BIII lens — trustless + fail-closed + honest about what it does NOT do.
 *
 * What this file does (PURE, no deps): parses the JWT (base64url — Node Buffer, no library), validates the
 * standard registered claims fail-closed (iss/sub present, exp not passed, aud matches the recipient), and
 * exposes a lens that treats the token as ATTESTED only when the caller confirms the signature verified.
 * The signature check itself (RS256/ES256 against the issuer's JWKS) needs a crypto/JWKS library and is
 * delegated to the caller/adapter, exactly like the ERC-8004 read — BIII never claims to verify what it
 * cannot without a dependency, and always ships the re-verify pointer. Surfacing an identity is NOT a
 * payable decision: a KYA-attested agent's address still runs the trust triangle.
 */

const b64urlToStr = (s) => {
  try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return null; }
};

/** parseJwt — split + base64url-decode a compact JWS. Pure; returns {header, payload, hasSig} or {error}. */
function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { error: 'not a compact JWT (expected header.payload.signature)' };
  const h = b64urlToStr(parts[0]);
  const p = b64urlToStr(parts[1]);
  let header, payload;
  try { header = JSON.parse(h); } catch { return { error: 'JWT header is not valid base64url JSON' }; }
  try { payload = JSON.parse(p); } catch { return { error: 'JWT payload is not valid base64url JSON' }; }
  return { header, payload, hasSig: parts[2].length > 0 };
}

/**
 * kyaLens — turn a Skyfire KYA JWT into an honest, SEPARATE, advisory identity lens.
 *   token: the compact KYA JWT.
 *   opts.verified: the caller attests the JWT SIGNATURE verified against the issuer's JWKS.
 *   opts.expectedAudience: the recipient this token must be addressed to (aud) — anti-replay. Recommended.
 *   opts.requireExpiry: strict callers demand a bounded lifetime — a KYA JWT with no `exp` is REFUSED
 *     (default false: an identity binding may legitimately be long-lived, unlike a payment authorization —
 *     but a no-exp token is always SURFACED via posture.expires so the reader is never blind to it).
 *   opts.now: injectable clock (ms).
 * Returns { available, attested, issuer, subject, audience, expiresAt, kyaClaims, posture, disclosure, reVerify, reason }.
 *   attested:true  → well-formed + signature-verified + unexpired + audience-matched: a real KYA identity.
 *     posture:{expires, audienceBound} — did the token carry an expiry, and was it replay-bound to you?
 *   attested:false → parsed but not fully verified/valid ⇒ a CLAIM, not an attestation (never treat as identity).
 */
function kyaLens(token, { verified = false, expectedAudience = null, requireExpiry = false, now = Date.now() } = {}) {
  const parsed = parseJwt(token);
  if (parsed.error) return { available: false, attested: false, reason: 'KYA token unparseable: ' + parsed.error + ' — absence of a valid token is never identity.' };

  const p = parsed.payload || {};
  const issuer = p.iss || null;
  const subject = p.sub || null;                        // the agent
  const audience = p.aud != null ? p.aud : null;        // who the token is FOR
  const expSec = Number(p.exp) || 0;
  const expiresAt = expSec > 0 ? new Date(expSec * 1000).toISOString() : null;
  // surface the KYA-specific (issuer-defined) claims raw — do NOT invent Skyfire's schema; the reader
  // interprets who backs the agent + any authorized spend. Standard registered claims are stripped out.
  const REGISTERED = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti']);
  const kyaClaims = Object.fromEntries(Object.entries(p).filter(([k]) => !REGISTERED.has(k)));

  const reVerify = {
    issuer,
    check: 'verify the JWT signature (RS256/ES256) against the issuer\'s JWKS, then confirm iss is a KYA issuer you trust — trust the signature + the issuer, not this field.',
    header: parsed.header || null,
    hasSignature: parsed.hasSig,
  };
  const base = { available: true, issuer, subject, audience, expiresAt, kyaClaims, reVerify };

  if (!issuer || !subject) return { ...base, attested: false, reason: 'KYA JWT missing iss or sub — an unidentified vouch is not an identity, refusing.' };
  if (expSec > 0 && now > expSec * 1000) return { ...base, attested: false, reason: 'KYA token expired — a stale attestation is not a live one, refusing.' };
  // A KYA JWT with no `exp` never expires: not a drain (this lens is advisory, never payable) but a leaked
  // no-exp token vouches forever. Strict callers opt into fail-closed with requireExpiry; otherwise it is
  // ALWAYS surfaced (posture.expires:false) so the reader is never blind to an unbounded vouch.
  if (requireExpiry && expSec <= 0) return { ...base, attested: false, reason: 'KYA token has no exp and requireExpiry is set — an unbounded (never-expiring) vouch is refused; a leaked no-exp token would vouch forever.' };
  if (expectedAudience != null) {
    const audMatch = Array.isArray(audience) ? audience.map(String).includes(String(expectedAudience)) : String(audience) === String(expectedAudience);
    if (!audMatch) return { ...base, attested: false, reason: 'KYA token aud does not match this recipient — token-replay guard (a KYA issued for someone else is not for you), refusing.' };
  }
  if (verified !== true) return { ...base, attested: false,
    reason: 'KYA JWT parsed + structurally valid, but the SIGNATURE is not verified (verified!==true) — BIII does not verify JWT signatures itself (no dep); verify against the issuer JWKS or re-verify with the pointer. Until then this is a CLAIM, not an attestation.' };

  const posture = { expires: expSec > 0, audienceBound: expectedAudience != null };
  const postureNote = (posture.expires ? '' : ' ⚠ NO EXPIRY: this vouch does not expire — treat a leaked token as valid indefinitely.')
    + (posture.audienceBound ? '' : ' ⚠ NOT REPLAY-BOUND: no expectedAudience was checked — this token is not tied to you as the recipient.');
  return { ...base, attested: true, advisory: true, posture,
    disclosure: 'KYA IDENTITY (attested): ' + issuer + ' vouches for agent ' + subject
      + (expectedAudience != null ? ' (addressed to you)' : '')
      + '. This attests WHO stands behind the agent (identity/authorization), NOT that its address is safe to pay — run the trust triangle on the address. Advisory + re-verifiable: check the signature against the issuer JWKS.' + postureNote };
}

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_CHAIN_ID = 8453;
const bi = (x) => { try { return BigInt(String(x)); } catch { return null; } };

/**
 * authorizeCharge — Skyfire's "Programmable Payment": does a BIII charge fall inside what the agent's
 * OWNER signed off? The check that makes an agent's spending SAFE by construction — a charge only executes
 * if it is within the authorized token, recipient, per-charge amount, AND the cumulative cap.
 *
 * spendAuth = { iss, sub, aud?, token:'USDC', chainId:8453, maxPerChargeMicro?, cumulativeCapMicro?,
 *               allowedRecipients?:[0x…], exp?, verified? } — OR the Programmable-Payment JWT (a string),
 *               which is parsed and requires verified:true (BIII does not verify JWT signatures itself).
 * charge   = a till.createCharge result ({ to, token, chainId, amountMicro }).
 * opts.spentMicro = how much has ALREADY been spent under this authorization (the cumulative guard — the
 *   caller tracks the running total; BIII is stateless). opts.now injectable.
 *
 * Returns { authorized, reason, chargeMicro, spentAfterMicro, remainingMicro, capMicro }. FAIL-CLOSED:
 * unverified / expired / wrong token or chain / over the per-charge max / over the cumulative cap / not in
 * the recipient allow-list ⇒ authorized:false. Absence of an authorization is never authorization.
 */
function authorizeCharge(spendAuth, charge, { spentMicro = 0, now = Date.now(), verified = false } = {}) {
  let auth = spendAuth;
  if (typeof spendAuth === 'string') {
    const parsed = parseJwt(spendAuth);
    if (parsed.error) return { authorized: false, reason: 'spend authorization JWT unparseable: ' + parsed.error };
    auth = { ...parsed.payload, verified };   // a parsed JWT is verified only if the caller attests it (opts.verified)
  }
  const a = auth && typeof auth === 'object' ? auth : {};
  const c = charge && typeof charge === 'object' ? charge : {};
  const chargeMicro = bi(c.amountMicro);
  const spentRaw = bi(spentMicro);
  const spent = spentRaw ?? 0n;
  const cap = a.cumulativeCapMicro != null ? bi(a.cumulativeCapMicro) : null;
  const perMax = a.maxPerChargeMicro != null ? bi(a.maxPerChargeMicro) : null;
  const base = { chargeMicro: chargeMicro != null ? chargeMicro.toString() : null,
    spentAfterMicro: null, remainingMicro: cap != null ? (cap - spent).toString() : null, capMicro: cap != null ? cap.toString() : null };

  // the caller attests the signature verified — via the auth object's `verified` field OR opts.verified
  // (unified so `authorizeCharge(authObj, charge, {verified:true})` is not a silent refuse). Still
  // fail-closed: verification must be TRUE on one of the two channels, never assumed.
  if (a.verified !== true && verified !== true) return { ...base, authorized: false, reason: 'spend authorization not verified (pass verified:true, or set it on the authorization, after checking the signature) — a claim is not a signed authorization.' };
  if (chargeMicro == null || chargeMicro <= 0n) return { ...base, authorized: false, reason: 'charge has no positive amountMicro — refusing.' };
  if (a.exp != null && Number(a.exp) > 0 && now > Number(a.exp) * 1000) return { ...base, authorized: false, reason: 'spend authorization expired — refusing.' };
  // FAIL-CLOSED on a MALFORMED limit (audit 2026-07-22): a cap/max that is PRESENT but not a valid integer
  // ('1e999', 'abc', '50.5' all throw in BigInt) must NOT be silently treated as "no limit" — that is the
  // exact drain the cap exists to prevent (a signed "$50 cap" written slightly wrong ⇒ unlimited spend).
  if (a.cumulativeCapMicro != null && cap == null) return { ...base, authorized: false, reason: 'cumulativeCapMicro is present but not a valid integer (micro-USDC, no decimals/scientific) — a malformed limit is NOT "no limit"; refusing.' };
  if (a.maxPerChargeMicro != null && perMax == null) return { ...base, authorized: false, reason: 'maxPerChargeMicro is present but not a valid integer — a malformed limit is NOT "no limit"; refusing.' };
  // the caller's running total must be a real non-negative integer, else the cumulative cap can't be trusted.
  if (spentRaw == null || spentRaw < 0n) return { ...base, authorized: false, reason: 'spentMicro must be a non-negative integer — refusing (a garbage/negative running total cannot verify the cumulative cap).' };
  // an authorization MUST bound spend: at least a per-charge max OR a cumulative cap. An unbounded signed
  // authorization is a footgun (any amount, forever) — refuse it unless the owner EXPLICITLY opts in.
  if (perMax == null && cap == null && a.unlimited !== true) return { ...base, authorized: false, reason: 'authorization sets neither a per-charge max nor a cumulative cap — an unbounded authorization is refused; set a limit, or deliberately opt in with unlimited:true.' };
  // token + chain must be USDC on Base on BOTH the auth and the charge (BIII is USDC-on-Base).
  const authTokenOk = String(a.token || 'USDC').toUpperCase() === 'USDC' && Number(a.chainId || BASE_CHAIN_ID) === BASE_CHAIN_ID;
  if (!authTokenOk) return { ...base, authorized: false, reason: 'authorization is not for USDC on Base — refusing.' };
  if (String(c.token || '').toLowerCase() !== USDC_BASE || Number(c.chainId) !== BASE_CHAIN_ID) return { ...base, authorized: false, reason: 'charge is not USDC on Base — refusing.' };
  if (Array.isArray(a.allowedRecipients) && a.allowedRecipients.length) {
    const allow = a.allowedRecipients.map((x) => String(x).toLowerCase());
    if (!allow.includes(String(c.to || '').toLowerCase())) return { ...base, authorized: false, reason: 'charge recipient is not in the authorization\'s allow-list — refusing.' };
  }
  if (perMax != null && chargeMicro > perMax) return { ...base, authorized: false, reason: 'charge ' + chargeMicro + ' exceeds the per-charge max ' + perMax + ' — refusing.' };
  if (cap != null) {
    const after = spent + chargeMicro;
    if (after > cap) return { ...base, authorized: false, spentAfterMicro: after.toString(), remainingMicro: (cap - spent).toString(),
      reason: 'charge would bring the cumulative spend ' + after + ' over the cap ' + cap + ' — refusing (this is the drain guard: ten small charges cannot beat a low cap).' };
    return { ...base, authorized: true, spentAfterMicro: after.toString(), remainingMicro: (cap - after).toString(),
      reason: 'within the per-charge max and the cumulative cap — authorized.' };
  }
  return { ...base, authorized: true, spentAfterMicro: (spent + chargeMicro).toString(), remainingMicro: null,
    reason: 'within the per-charge limit (no cumulative cap set) — authorized.' };
}

module.exports = { parseJwt, kyaLens, authorizeCharge };
