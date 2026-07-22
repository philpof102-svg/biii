'use strict';
/**
 * BIII identity bridge — npub ↔ Base, the glue between a buzz/Nostr agent identity and a payable,
 * trust-assessable Base address (and optionally a gitlawb DID).
 * ================================================================================================
 * A buzz agent is a secp256k1 keypair (Nostr, hex pubkey). To PAY it or assess "safe to pay", you need
 * its Base address — and you must not take anyone's word for the mapping. So the binding is a
 * BIDIRECTIONAL attestation: BOTH keys sign the SAME canonical message. Anyone reconstructs that message
 * and verifies both signatures — the binding is proven, no trust in BIII. This mirrors every other BIII
 * lens: trustless, fail-closed, re-verifiable, and honest about what it does NOT do.
 *
 * What this file does (PURE, no deps): defines the canonical message both keys sign, validates the binding
 * STRUCTURE fail-closed, and exposes a binding lens that resolves npub→Base ONLY when the caller attests
 * the signatures verified (`verified:true`) — else `bound:false` (a claim is not a binding). The actual
 * secp256k1 verification (Nostr BIP-340 Schnorr + Base ecrecover) needs a crypto lib and is delegated to
 * the caller/adapter, exactly like the ERC-8004 lens delegates the on-chain read — BIII never claims to
 * verify what it cannot verify without a dependency, and always ships the re-verify pointer.
 */

const BASE_CHAIN_ID = 8453;
const isHex = (s, n) => new RegExp('^[0-9a-f]{' + n + '}$', 'i').test(String(s || ''));
const isPubkey = (s) => isHex(s, 64);                                   // Nostr/secp256k1 x-only pubkey, hex
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
const isDid = (s) => s == null || /^did:[a-z0-9]+:.+/.test(String(s));

/**
 * bindingMessage — the CANONICAL string both keys sign. Deterministic + versioned, so any verifier
 * reconstructs the exact bytes and checks the two signatures. Field order is fixed; a normalized address
 * (lowercased) and a fixed layout make it collision-free and re-derivable.
 */
function bindingMessage({ npub, address, did = null, nonce, chainId = BASE_CHAIN_ID, expiry = 0 } = {}) {
  return [
    'BIII-IDENTITY-BINDING-v1',
    'npub: ' + String(npub || '').toLowerCase(),
    'base: ' + String(address || '').toLowerCase(),
    'did: ' + (did ? String(did) : '-'),
    'chainId: ' + (Number(chainId) || BASE_CHAIN_ID),
    'nonce: ' + String(nonce || ''),
    'expiry: ' + (Number(expiry) || 0),
  ].join('\n');
}

/**
 * bindingLens — resolve a buzz npub to a trust-assessable Base address, trustlessly.
 * attestation = { npub, address, did?, nonce, chainId?, expiry?, sigNostr?, sigBase?, verified? }
 *   verified:true  — the caller attests BOTH signatures over bindingMessage checked out.
 * Returns { bound, npub, address, did, message, disclosure, reVerify, reason }.
 *   bound:true  → npub↔address is a proven, live binding — safe to resolve + then assess via the triangle.
 *   bound:false → structurally invalid / expired / unverified / one-sided ⇒ a CLAIM, not a binding. Never
 *                 resolve payment to it. (Fail-closed: absence of proof is never a binding.)
 */
function bindingLens(attestation, { now = Date.now() } = {}) {
  const a = attestation && typeof attestation === 'object' ? attestation : {};
  const npub = String(a.npub || '').toLowerCase();
  const address = String(a.address || '').toLowerCase();
  const message = bindingMessage({ npub, address, did: a.did, nonce: a.nonce, chainId: a.chainId, expiry: a.expiry });
  const reVerify = {
    message,
    check: 'reconstruct `message` and verify sigNostr (BIP-340 Schnorr over the npub) AND sigBase (Base ecrecover to `address`) — trust the two signatures, not this field.',
    sigNostr: a.sigNostr || null, sigBase: a.sigBase || null,
  };
  const base = { npub, address, did: a.did || null, message, reVerify };

  if (!isPubkey(npub)) return { ...base, bound: false, reason: 'npub is not a 64-hex secp256k1 pubkey — malformed identity, refusing.' };
  if (!isAddr(address)) return { ...base, bound: false, reason: 'address is not a 0x Base address — malformed, refusing.' };
  if (!isDid(a.did)) return { ...base, bound: false, reason: 'did is present but not a valid did: URI — refusing.' };
  if (!a.nonce) return { ...base, bound: false, reason: 'no nonce — an unnonced binding is replayable, refusing.' };
  if (Number(a.expiry) > 0 && now > Number(a.expiry) * 1000) return { ...base, bound: false, reason: 'binding expired — refusing (a stale binding is not a live one).' };
  if (!a.sigNostr || !a.sigBase) return { ...base, bound: false, reason: 'binding is one-sided (needs BOTH the Nostr and the Base signature) — a half-signed claim is not a binding.' };
  if (a.verified !== true) return { ...base, bound: false,
    reason: 'signatures not verified (verified!==true) — BIII does not verify secp256k1 itself; supply verified:true after checking both sigs, or re-verify with the pointer. Until then this is a CLAIM, not a binding.' };

  return { ...base, bound: true,
    reason: 'npub↔address is a proven bidirectional binding — resolve to the Base address, then assess it with till_trust / till_vet_merchant.',
    disclosure: 'IDENTITY BINDING (proven): this buzz npub and this Base address each signed the same canonical message. Re-verify the two signatures yourself. Resolving to a payable address does NOT make it safe — run the trust triangle on the address.' };
}

module.exports = { bindingMessage, bindingLens, BASE_CHAIN_ID };
