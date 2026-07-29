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
 * provenanceOf — how AUTHORITATIVE is an entry's address, judged from its `source` tag? An aggregator
 * listing (Coingecko/CMC) is WEAKER evidence than the issuer's own contract page — a 'genuine' verdict must
 * say which, so a green check never silently implies issuer-verification. Fail-safe: an unrecognized/empty
 * source is treated as the WEAKER 'aggregator', never as 'issuer-official' (never over-state authority).
 *   issuer-official — sourced from the issuer's official docs/tokenlist (the strong, citable case)
 *   aggregator      — a third-party aggregator listing (Coingecko/CMC): positive but weaker
 *   seed            — an in-repo example still marked to re-verify (NOT yet authoritative)
 */
function provenanceOf(source) {
  const s = lower(source);
  if (!s) return 'aggregator';                                    // fail-safe: unknown provenance ≠ issuer-official
  if (s.includes('re-verify') || s.includes('reverify') || s.includes('example')) return 'seed';
  if (s.startsWith('coingecko') || s.startsWith('coinmarketcap') || s.startsWith('cmc') || s.includes('aggregator')) return 'aggregator';
  if (s.startsWith('issuer:') || s.startsWith('http') || s.includes('official') || s.includes('.fi') || s.includes('.com') || s.includes('docs')) return 'issuer-official';
  return 'aggregator';                                            // default to the weaker classification
}

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
function assessAsset({ token, claimedIssuer, claimedSymbol } = {}, { registry = SEED_REGISTRY, denylist, registryComplete = null } = {}) {
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
      chainId: entry.chainId ?? null, source: entry.source || null, provenance: provenanceOf(entry.source), safeToAcquire: true };
  }

  // Unknown contract. THE dangerous case: it CLAIMS to be an asset we DO have a genuine address for,
  // but this address is not it → impersonation (lookalike / cloned token).
  /* ⚠️ LE `||` ACCUSAIT SUR LA SEULE CORRESPONDANCE D'EMETTEUR.
   * L'ancienne recherche declenchait `impersonation` des que le symbole OU l'emetteur correspondait.
   * Or revendiquer UN EMETTEUR CONNU n'est pas revendiquer UN PRODUIT PRECIS: ce registre ne pretend pas
   * lister tous les produits d'un emetteur — le seed integre en contient UN SEUL. Mesure du 2026-07-28,
   * sur le seed:
   *
   *   {claimedIssuer:'BlackRock', claimedSymbol:'AUTRE'} -> impersonation,
   *       « claims AUTRE but the genuine BlackRock BUIDL is 0x7712… »
   *
   * Un autre produit tokenise LEGITIME de BlackRock etait donc accuse d'usurper BUIDL — un produit qu'il
   * n'a jamais pretendu etre. Meme faute que dans lib/meme.js plus tot aujourd'hui: « ce n'est pas celui
   * que je connais » n'est pas « il usurpe celui que je connais ». On n'accuse pas sur notre propre
   * incompletude.
   *
   * LA PRISE EST CONSERVEE, et c'est elle qui compte: une COLLISION DE SYMBOLE — un contrat qui se dit
   * BUIDL sans etre l'adresse de BUIDL — reste une usurpation. C'est la fraude #1 que ce module vise. */
  /* ⚠️ ET CE VERDICT-CI REPOSE SUR UNE ABSENCE — la meme faute, une branche plus bas.
   * Dire « la VRAIE adresse est X, pas celle-ci » suppose que le registre liste TOUTES les adresses
   * legitimes de ce symbole. Il ne le garantit jamais: un actif est deploye sur plusieurs chaines, et
   * l'ingest peut en perdre des lignes. Mesure du 2026-07-29, sur ce code, avec le vrai contrat Base
   * d'Ondo (OUSG deploye sur Ethereum ET sur Base):
   *
   *   registre complet -> genuine       -> PROCEED
   *   ligne Base perdue -> impersonation -> REFUSE     ... sur le MEME contrat authentique
   *
   * Une categorie Coingecko tombee sur un ECONNRESET suffisait a produire ce basculement. On garde le
   * REFUS (fail-closed: l'argent ne bouge pas sur une collision de symbole non resolue) mais on cesse
   * d'ENONCER une fraude qu'on ne peut pas etablir. Seul un registre explicitement complet l'autorise. */
  if (claimedSymbol) {
    const known = reg.find((e) => norm(e.symbol) === norm(claimedSymbol)
      && (!claimedIssuer || !e.issuer || norm(e.issuer) === norm(claimedIssuer)));
    if (known && lower(known.address) !== addr) {
      const prouve = registryComplete === true;   // `null` (inconnu) ne vaut PAS `true`
      const quoi = [known.issuer, known.symbol].filter(Boolean).join(' ');
      // La PHRASE porte son propre statut. Sur un registre prouve complet, « genuine » est merite et le
      // verdict s'enonce en fait. Sinon il s'enonce en refus motive — meme decision, honnetete differente.
      return { status: 'impersonation', basis: 'symbol_collision', confirmed: prouve,
        reason: prouve
          ? `claims ${claimedSymbol} but the genuine ${quoi} is ${known.address}, not this contract`
          : `claims ${claimedSymbol} but the ${quoi} we have on file is ${known.address}, not this contract`
            + ' — and our registry is NOT established as complete, so this could instead be a legitimate '
            + 'deployment (another chain, another tranche) we never ingested. Refusing is the safe move; '
            + 'it is not proof of fraud.',
        registryComplete, genuineAddress: lower(known.address), safeToAcquire: false };
    }
  }
  /* Emetteur connu, produit inconnu de nous: on ne certifie rien ET on n'accuse pas. On DIT laquelle des
   * deux choses on ignore, sinon `unknown` se lit comme « jamais entendu parler », alors qu'ici on a
   * entendu parler de l'emetteur et pas de ce produit-la. */
  const emetteurConnu = claimedIssuer && reg.find((e) => e.issuer && norm(e.issuer) === norm(claimedIssuer));
  if (emetteurConnu) {
    return { status: 'unknown', safeToAcquire: false,
      reason: `${emetteurConnu.issuer} IS a verified issuer here, but this contract is not one of the `
        + `${reg.filter((e) => e.issuer && norm(e.issuer) === norm(claimedIssuer)).length} product(s) we have on `
        + `file for it. That is our registry being incomplete, NOT evidence against this contract — and it `
        + `is NOT a clearance either. Verify the address on the issuer's own page before acquiring.`,
      issuerKnown: true };
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
  if (assetVerdict.status === 'genuine') {
    // an issuer-official match is stronger evidence than an aggregator listing — don't score them the same,
    // and don't call an aggregator match "verified" (it's "listed"). Fail-closed calibration.
    const issuerOfficial = assetVerdict.provenance === 'issuer-official';
    return { decision: 'PROCEED', score: issuerOfficial ? 80 : 55,
      note: `${assetVerdict.issuer} ${assetVerdict.symbol} (${issuerOfficial ? 'issuer-verified' : 'aggregator-listed — not issuer-verified'})` };
  }
  if (assetVerdict.status === 'impersonation' || assetVerdict.status === 'unsafe') return { decision: 'REFUSE', score: 0, note: assetVerdict.reason };
  return { decision: null, score: 10, note: 'unverified contract' }; // unknown/invalid → weak, not safe
}

module.exports = { assessAsset, assetVertex, SEED_REGISTRY };
