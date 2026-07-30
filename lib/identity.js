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
function bindingLens(attestation, { now = Date.now(), requireExpiry = false } = {}) {
  const a = attestation && typeof attestation === 'object' ? attestation : {};
  const npub = String(a.npub || '').toLowerCase();
  const address = String(a.address || '').toLowerCase();
  const did = (a.did != null && String(a.did) !== '-' && String(a.did) !== '') ? String(a.did) : null;
  const message = bindingMessage({ npub, address, did, nonce: a.nonce, chainId: a.chainId, expiry: a.expiry });
  const hasNpub = isPubkey(npub);                                   // buzz / Nostr identity (secp256k1)
  const hasDid = did != null && isDid(did);                         // gitlawb identity (did:key Ed25519)
  const reVerify = {
    message,
    check: 'reconstruct `message` and verify sigBase (Base ecrecover to `address`) AND, for each identity key present, its own signature: sigNostr (BIP-340 Schnorr over the npub) / sigDid (Ed25519 over the did:key). Trust the signatures, not this field.',
    sigNostr: a.sigNostr || null, sigDid: a.sigDid || null, sigBase: a.sigBase || null,
  };
  const base = { npub: hasNpub ? npub : null, did: hasDid ? did : null, address,
    identities: { npub: hasNpub ? npub : null, did: hasDid ? did : null }, message, reVerify };
  const refuse = (reason) => ({ ...base, bound: false, reason });

  if (!isAddr(address)) return refuse('address is not a 0x Base address — malformed, refusing.');
  if (a.npub != null && String(a.npub) !== '' && !hasNpub) return refuse('npub is present but not a 64-hex secp256k1 pubkey — refusing.');
  if (did != null && !hasDid) return refuse('did is present but not a valid did: URI — refusing.');
  // A binding needs AT LEAST ONE identity key — an npub (buzz/Nostr) OR a did:key (gitlawb), or both.
  if (!hasNpub && !hasDid) return refuse('no identity key — a binding needs an npub (buzz/Nostr) or a did:key (gitlawb) — refusing.');
  if (!a.nonce) return refuse('no nonce — an unnonced binding is replayable, refusing.');
  /* ⚠️ L'UNITÉ DE `expiry` ÉCHOUAIT OUVERT. Le champ est en SECONDES unix (le schéma MCP le dit), et la
   * ligne suivante multiplie par 1000. Un appelant qui écrit le geste naturel en JavaScript —
   * `expiry: Date.now()` — livre ~1,7e12, que ce × 1000 projette ~50 000 ans dans le futur : la liaison
   * ne peut alors PLUS JAMAIS expirer, et une liaison périmée se lit comme vivante.
   * Mesuré le 2026-07-30, attestation complète et `verified:true` :
   *   expiry en secondes, passé ....... bound=false  ✓
   *   expiry en MILLISECONDES, passé .. bound=true   ⛔  ← même instant, autre unité
   * Une erreur d'unité plausible sur un champ de sécurité ne doit pas accorder plus que le champ correct.
   * 1e11 secondes = an 5138 : au-delà, ce n'est pas une date, c'est une unité fausse. On refuse au lieu
   * d'accorder l'éternité. (Découvert en me trompant moi-même d'unité dans la sonde — l'erreur était dans
   * mon test, la conséquence est dans le code.) */
  if (Number(a.expiry) > 1e11) return refuse('expiry ' + a.expiry + ' is not unix SECONDS — it looks like '
    + 'milliseconds. Refusing rather than granting a binding that could never expire.');
  if (Number(a.expiry) > 0 && now > Number(a.expiry) * 1000) return refuse('binding expired — a stale binding is not a live one, refusing.');
  // Each identity key present MUST carry its own signature (a bidirectional attestation per key), and the
  // Base key MUST sign too — a half-signed binding is a claim, not a binding.
  if (hasNpub && !a.sigNostr) return refuse('npub is present without its Nostr signature — refusing.');
  if (hasDid && !a.sigDid) return refuse('did is present without its DID (Ed25519) signature — refusing.');
  if (!a.sigBase) return refuse('no Base signature — the Base key must sign too (bidirectional) — refusing.');
  if (a.verified !== true) return refuse('signatures not verified (verified!==true) — BIII does not verify secp256k1/Ed25519 itself; supply verified:true after checking the signatures, or re-verify with the pointer. Until then this is a CLAIM, not a binding.');

  /* ⚠️ UNE ASYMÉTRIE DANS CETTE FONCTION MÊME — mesurée le 2026-07-30.
   * Ce module REFUSE une liaison sans nonce (« an unnonced binding is replayable, refusing ») et
   * ACCEPTAIT en silence une liaison qui n'expire JAMAIS :
   *
   *   expiry 0 ........ bound=true    <-- permanent
   *   expiry ABSENT ... bound=true    <-- permanent
   *   expiry passé .... bound=false   ✓
   *   expiry futur .... bound=true    ✓
   *
   * Même classe de risque — un justificatif permanent — traitée strictement d'un côté et par défaut de
   * l'autre, à quelques lignes d'écart. C'est l'heuristique « bien résolu ici, mal résolu là » appliquée
   * À L'INTÉRIEUR d'une seule fonction, le cas le plus dur à voir : on lit le garde du nonce, on en
   * conclut que la fonction est stricte, et on ne relit pas le champ voisin.
   *
   * La doctrine existait déjà ailleurs dans le produit (posture KYA, `requireExpiry`) et n'avait jamais
   * été portée ici. On NE décide PAS la politique à la place de l'appelant : `bound` reste `true`, sinon
   * on casserait tout appelant existant. Mais le permanent cesse d'être SILENCIEUX — il se déclare, et
   * `requireExpiry: true` permet à qui veut de le refuser. Permanent doit être un CHOIX, pas un défaut. */
  const expiresAt = Number(a.expiry) > 0 ? Number(a.expiry) : null;
  if (expiresAt === null && requireExpiry) {
    return refuse('binding carries NO expiry and requireExpiry was set — a binding that never expires is '
      + 'a permanent credential, the same risk this module already refuses for a missing nonce.');
  }
  const who = [hasNpub ? 'npub' : null, hasDid ? 'did' : null].filter(Boolean).join(' + ');
  return { ...base, bound: true, expiresAt,
    reason: 'proven bidirectional binding (' + who + ' ↔ Base) — resolve to the address, then assess it with till_trust / till_vet_merchant.'
      + (expiresAt === null ? ' ⚠️ It carries NO expiry, so it never goes stale on its own.' : ''),
    disclosure: 'IDENTITY BINDING (proven): the agent\'s ' + who + ' key(s) and this Base address each signed the same canonical message. Re-verify the signatures yourself. Resolving to a payable address does NOT make it safe — run the trust triangle on the address.'
      + (expiresAt === null
        ? ' ⚠️ NO EXPIRY: this binding is PERMANENT until the keys are rotated — nothing revokes it on a clock. '
          + 'That is a standing credential, not a session. Pass requireExpiry:true to refuse such bindings.'
        : ' It expires at unix ' + expiresAt + '.') };
}

module.exports = { bindingMessage, bindingLens, BASE_CHAIN_ID };
