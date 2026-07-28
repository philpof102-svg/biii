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
  /* ⚠️ UN PLANCHER NON LU SE DECLARAIT NON PERIME — donc frais.
   * `ageDays != null && ageDays > STALE_DAYS` rend `false` quand `asOf` manque, c'est-a-dire exactement
   * quand aucune liste n'a ete chargee. Mesure du 2026-07-28: `screenMeta(loadScreen(null))` rendait
   * `{count:0, asOf:null, stale:false}`. Publie tel quel sur `/radar` — surface PUBLIQUE — ca donne
   * « 0 adresses, non perime »: un plancher illisible se presente comme a jour ET vide. Et `vet.js:73`
   * traduit ce booleen en toutes lettres par « current ».
   *
   * « Courant » est une AFFIRMATION. L'absence d'age n'est pas une preuve de fraicheur, c'est une absence
   * de preuve — la distinction que ce fichier tient deja correctement dans `screenAddress`, qui refuse
   * d'appeler son zero un verdict propre. Prudent dans une fonction, fail-open dans celle d'a cote.
   *
   * ⚠️ PORTEE RESSERREE APRES COUP, et le raisonnement compte. Le premier jet incluait aussi
   * `ageDays == null` — ce qui a fait rougir `test/staleness.test.js:48`, dont le commentaire tranche
   * explicitement le cas: « unknown age is not asserted stale, but the string says "age unknown" ». Une
   * liste CHARGEE mais non datee est utilisable, et la declarer perimee affirme elle aussi quelque chose
   * qu'on ignore. L'auteur avait pese ce cas; je ne le renverse pas sur une preference.
   *
   * Ce qui reste corrige est l'autre cas, sans ambiguite: AUCUNE liste chargee ne doit se dire
   * « current ». Une non-lecture n'est pas une fraicheur. */
  const stale = !s.available || (ageDays != null && ageDays > STALE_DAYS);
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

/**
 * verifyFloor — the TRUSTLESS adoption check for a floor pulled from a decentralized source (gitlawb,
 * a URL, another node's till_floor). The rule that makes distributing the truth on a substrate you don't
 * control safe: the consumer NEVER trusts the source — it recomputes the fingerprint over the received
 * content and refuses (fail-closed) if it doesn't match the artifact's claimed fingerprint. A hostile
 * mirror can hand you any bytes; only bytes that hash to the stated (publicly re-derivable) fingerprint
 * are adopted. artifact = { addresses, asOf, sources, fingerprint }.
 *   valid:true               → content matches its claimed fingerprint — safe to adopt.
 *   valid:false              → tampered/corrupted/mismatched — REJECT, keep your own floor.
 * Optionally pass expectedFingerprint (a value you pinned or independently re-derived from the public
 * sources) to also require it equals the artifact's — the strongest check (source-independent).
 */
function verifyFloor(artifact, opts = {}) {
  const a = artifact && typeof artifact === 'object' ? artifact : {};
  const computed = floorFingerprint({ addresses: a.addresses, asOf: a.asOf, sources: a.sources });
  const claimed = typeof a.fingerprint === 'string' ? a.fingerprint : null;

  /* ⚠️ DEMANDER LE CONTROLE LE PLUS FORT ET OBTENIR LE PLUS FAIBLE, EN SILENCE.
   * L'ancienne garde etait `if (expectedFingerprint && expectedFingerprint !== claimed)`. Un pin FALSY —
   * chaine vide, `undefined` d'une variable d'environnement mal nommee — sautait la verification et
   * rendait `valid: true`, sans que rien ne dise que l'epingle n'avait pas servi.
   *
   * Le seul appelant du depot n'en passe pas, donc ce n'etait pas atteignable ici. Mais cette fonction est
   * EXPORTEE et documentee comme LE controle d'adoption trustless pour un noeud tiers: un operateur qui
   * ecrit `{ expectedFingerprint: process.env.PINNED_FLOOR }` avec la variable non definie adopterait
   * n'importe quel plancher bien forme venu d'un miroir hostile, en croyant l'avoir epingle. C'est le
   * motif de la journee applique au seul endroit ou il coute une adoption de donnees hostiles.
   *
   * On distingue donc « pas d'epingle demandee » (cle absente) de « epingle demandee mais inutilisable »
   * (cle presente, valeur vide) — et le second REFUSE, parce que l'appelant a explicitement demande le
   * controle fort. `checksRun` dit ensuite lesquels ont VRAIMENT tourne, pour que « valid: true » ne se
   * lise pas plus fort qu'il ne l'est. */
  /* `null` = opt-out EXPLICITE (c'etait la valeur par defaut documentee), donc pas d'epingle demandee.
   * `undefined` avec la cle PRESENTE = une epingle demandee dont la valeur n'est pas arrivee — c'est
   * exactement ce que produit `process.env.PIN_NON_DEFINI`, le cas archetypal. Il doit REFUSER.
   * (Ecrit `!== undefined` au premier jet, ce qui rouvrait le trou que ce bloc existe pour fermer.) */
  const pinDemande = Object.prototype.hasOwnProperty.call(opts, 'expectedFingerprint')
    && opts.expectedFingerprint !== null;
  const pin = pinDemande ? opts.expectedFingerprint : null;
  if (pinDemande && (typeof pin !== 'string' || !pin.trim())) {
    return { valid: false, computed, claimed, checksRun: ['content-hash'],
      reason: 'an expectedFingerprint was supplied but is empty or not a string — refusing to adopt '
        + 'rather than silently downgrading to the weaker check. Fix the pin, or omit it deliberately.' };
  }

  if (!claimed) return { valid: false, computed, claimed: null, checksRun: [],
    reason: 'artifact carries no fingerprint — cannot verify integrity; refusing to adopt.' };
  if (computed !== claimed) return { valid: false, computed, claimed, checksRun: ['content-hash'],
    reason: 'content does not hash to its claimed fingerprint (tampered/corrupted) — refusing to adopt.' };
  if (pinDemande && pin !== claimed) return { valid: false, computed, claimed,
    checksRun: ['content-hash', 'pinned-fingerprint'],
    reason: 'fingerprint does not match the expected/pinned value — refusing to adopt.' };
  const s = loadScreen(a);
  return { valid: true, computed, claimed, count: s.count, asOf: s.asOf || null,
    /* Ce qui a REELLEMENT tourne. Sans ce champ, un `valid:true` obtenu sans epingle est indiscernable
     * d'un `valid:true` obtenu avec — et c'est toute la difference entre « ces octets sont coherents » et
     * « ces octets sont ceux que j'attendais ». */
    checksRun: pinDemande ? ['content-hash', 'pinned-fingerprint'] : ['content-hash'],
    reason: 'content matches its claimed fingerprint' + (pinDemande ? ' and the expected value' : '')
      + ' — safe to adopt. (You never trusted the source; you verified the hash.)'
      + (pinDemande ? '' : ' NOTE: no expectedFingerprint was supplied, so this proves the bytes are '
        + 'self-consistent, NOT that they are the floor you meant to adopt.') };
}

module.exports = { loadScreen, screenAddress, screenMeta, floorFingerprint, floorProvenance, verifyFloor, STALE_DAYS };
