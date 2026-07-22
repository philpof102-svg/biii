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
 *   opts.now: injectable clock (ms).
 * Returns { available, attested, issuer, subject, audience, expiresAt, kyaClaims, disclosure, reVerify, reason }.
 *   attested:true  → well-formed + signature-verified + unexpired + audience-matched: a real KYA identity.
 *   attested:false → parsed but not fully verified/valid ⇒ a CLAIM, not an attestation (never treat as identity).
 */
function kyaLens(token, { verified = false, expectedAudience = null, now = Date.now() } = {}) {
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
  if (expectedAudience != null) {
    const audMatch = Array.isArray(audience) ? audience.map(String).includes(String(expectedAudience)) : String(audience) === String(expectedAudience);
    if (!audMatch) return { ...base, attested: false, reason: 'KYA token aud does not match this recipient — token-replay guard (a KYA issued for someone else is not for you), refusing.' };
  }
  if (verified !== true) return { ...base, attested: false,
    reason: 'KYA JWT parsed + structurally valid, but the SIGNATURE is not verified (verified!==true) — BIII does not verify JWT signatures itself (no dep); verify against the issuer JWKS or re-verify with the pointer. Until then this is a CLAIM, not an attestation.' };

  return { ...base, attested: true, advisory: true,
    disclosure: 'KYA IDENTITY (attested): ' + issuer + ' vouches for agent ' + subject
      + (expectedAudience != null ? ' (addressed to you)' : '')
      + '. This attests WHO stands behind the agent (identity/authorization), NOT that its address is safe to pay — run the trust triangle on the address. Advisory + re-verifiable: check the signature against the issuer JWKS.' };
}

module.exports = { parseJwt, kyaLens };
