#!/usr/bin/env node
'use strict';
/**
 * basetill MCP — PHASE 3: the agentic economy pays real-world humans.
 * ==================================================================
 * The trilogy: MainStreet says WHO is safe to pay · LAWBOR proves agent↔agent outcomes ·
 * basetill is the BRIDGE — any MCP agent (Claude, openclaude, LAWBOR bots…) can pay a real
 * merchant in USDC on Base and hold a chain-anchored receipt.
 *
 * Descriptor-only, same posture as LAWBOR: basetill NEVER holds a key and NEVER moves funds.
 * till_create_charge returns the EIP-681 intent; the AGENT'S OWN wallet signs/pays; the
 * chain — not us — says "paid" (till_check_payment verifies field-for-field).
 *
 * Tools:
 *   till_vet_merchant   — MainStreet "safe to pay" on the RECIPIENT before any money moves
 *   till_create_charge  — amount+merchant → charge + universal EIP-681 payment intent
 *   till_check_payment  — chain watcher + field-for-field verification → paid / not
 *   till_receipt        — the receipt (only exists for a verified payment)
 */
const readline = require('node:readline');
const T = require('../lib/till');
const { findPayment } = require('../lib/chain');
const { assessTriangle } = require('../lib/trust');
const I = require('../lib/invoice');
const { assessAsset, assetVertex } = require('../lib/asset');
const { vetMeme } = require('../lib/meme');
const { scanRugOne } = require('../lib/rugsignals');
const { traceFeeder } = require('../lib/feeder');
const { classifyB20 } = require('../lib/b20');
const { whatMoved, readBridgeExit, followTron } = require('../lib/trace');
const { assessRecoveryOffer } = require('../lib/recovery');
const { vetApproach } = require('../lib/lure');
const { checkApprovals } = require('../lib/approvals');
const SEED = require('../lib/seedscan');
const KEYS = require('../lib/keyscan');
const DELIV = require('../lib/delivery');
const { watchWallet } = require('../lib/wallet-watch');
const { vetAgent } = require('../lib/agent-vet');
const L = require('../lib/ledger');
const X = require('../lib/export');
const { meterUsage } = require('../lib/meter');
const { erc8004Lens } = require('../lib/erc8004');
const { bindingLens } = require('../lib/identity');
const { kyaLens, authorizeCharge } = require('../lib/skyfire');
const { DISCLAIMER } = require('../lib/disclaimer');
const { screenAddress, screenMeta, floorProvenance } = require('../lib/screen');
const V = require('../lib/vet');   // the LOCAL verdict, shared with GET /trust — one judgment, many mouths
const { loadAssetRegistry } = require('../lib/asset-registry');   // issuer-verified merged over aggregator (shared with /asset)
const FUNDER = require('../lib/funder-history');   // our OWN observed history of who paid for what, with its age
const fs = require('node:fs'), path = require('node:path');

// Verified-issuer registry: committed issuer-official entries (green) merged over the generated aggregator
// registry (teal). Absent → assessAsset falls back to its small SEED. A stale/missing file can only
// UNDER-verify (a non-registry token reads 'unknown', never a false 'genuine'). Same loader the server uses.
const _assetReg = loadAssetRegistry();
const RWA_REGISTRY = _assetReg.entries, RWA_SOURCE = _assetReg.source;
const RWA_COMPLETE = _assetReg.complete;   // true | false | null(unknown) — null must never read as true

// DECENTRALIZED known-bad floor: a LOCAL, public, open-licensed list (data/known-bad.json). The node
// screens against it with zero network, so a known-bad address BLOCKs even when the MainStreet oracle is
// down — removing the single point of failure. Absent file ⇒ available:false ⇒ screening is UNAVAILABLE
// (never a silent "clean"), which the verdict discloses. (Loader shared with GET /trust via lib/vet.)
const KNOWN_BAD = V.loadFloor();

const MAINSTREET = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');

// fetchOracle — MainStreet's ORACLE-REPORTED behavioral read ONLY (no local floor here). Advisory,
// fail-closed: unreachable/non-200 ⇒ {error, disclosure}. x-ms-monitor:1 keeps calls out of product metrics.
async function fetchOracle(address) {
  try {
    const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(String(address || '').toLowerCase())}`,
      { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json();
      return { decision: j.decision ?? null, score: j.score ?? null,
        disclosure: 'ORACLE-REPORTED — MainStreet\'s advisory read, not verified by this node; never overrides the local floor.' }; }
    return { error: 'oracle HTTP ' + r.status, disclosure: 'advisory only — the local known-bad floor still holds' };
  } catch (e) { return { error: 'oracle unreachable: ' + (e && e.message), disclosure: 'advisory only — the local known-bad floor still holds' }; }
}

// Reputation for the trust triangle, as ONE composed decision (LOCAL floor wins, else the oracle, else
// null). The two-lens SPLIT for display lives in till_trust; this helper is what feeds assessTriangle and
// the withTrust lens. So MainStreet being slow/down can never let a known scammer through — the floor fires.
/* ⚠️ UNE COUCHE QUI DISTINGUE TROIS CAS, UNE COUCHE AU-DESSUS QUI LES APLATIT SUR UN BOOLEEN.
 * `screenAddress` fait parfaitement son travail: il rend `available:false` avec la phrase « screening
 * UNAVAILABLE, not a clean verdict » quand aucune liste known-bad n'est chargee. Cette fonction ne lisait
 * que `local.blocked` et jetait le reste. Resultat, deux etats de preuve DIFFERENTS sortaient identiques:
 *
 *   liste indisponible    + oracle repond OK  ->  { decision:'OK', source:'mainstreet-oracle' }
 *   liste chargee, absent + oracle repond OK  ->  { decision:'OK', source:'mainstreet-oracle' }
 *
 * Dans le premier cas le plancher local n'a JAMAIS tourne — et ce plancher est ce qui tient quand
 * l'oracle se trompe ou ment. Le defaut n'est visible dans aucun des deux modules pris seul: seulement
 * en les comparant. Le meme fait est d'ailleurs divulgue ailleurs dans ce codebase
 * (`wallet-watch.judgeCounterparty` pousse « the local known-bad screen is unavailable »), ce qui rend
 * l'omission ici d'autant plus nette — la bonne reponse etait deja ecrite, dans un autre fichier.
 *
 * `localScreen` voyage donc avec chaque verdict. Et les deux dependances sont injectables: sans joint,
 * cette fonction etait intestable, ce qui explique qu'aucun test ne l'ait nommee. */
async function fetchReputation(address, { floor = KNOWN_BAD, oracle = fetchOracle } = {}) {
  const local = screenAddress(address, floor);
  const localScreen = { available: local.available === true, reason: local.reason };
  if (local.blocked) return { decision: 'BLOCK', score: null, source: 'local-known-bad', reason: local.reason, localScreen };
  const o = await oracle(address);
  if (o.decision != null || o.score != null) {
    return { decision: o.decision, score: o.score, source: 'mainstreet-oracle', localScreen,
      // Un oracle qui dit OK par-dessus un plancher qui n'a pas tourne n'est pas le meme OK.
      ...(localScreen.available ? {} : { caveat: 'the local known-bad floor did NOT run for this address, so this verdict rests on the advisory oracle ALONE — it is not a floor-backed read.' }) };
  }
  return null;   // not-locally-known-bad + oracle down ⇒ no live signal. Honest 'unknown', never 'clean'.
}

// localClassify — MainStreet's judgment run on THIS node via trust-core (pure, no oracle). Extracted to
// lib/vet.js (shared with GET /trust — one judgment, many mouths); this wrapper binds the node's floor.
// Surfaced as its OWN lens — never folded into the triangle's reputation input, because a green-unverified
// PROCEED_LOW_VALUE there would read as false 'trusted'.
const localClassify = (address, opts = {}) => V.localClassify(address, { ...opts, knownBad: KNOWN_BAD });

const TOOLS = [
  { name: 'till_vet_merchant', description: 'MainStreet safe-to-pay preflight on a merchant address. Returns the hosted oracle read (advisory) AND a LOCAL CLASSIFIER verdict computed on this node via trust-core (pure, zero-oracle) — so a verdict holds even if the oracle is down. Vet the RECIPIENT before paying.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '0x merchant address' },
      resourceUrl: { type: 'string', description: 'optional — the endpoint/resource URL you would pay; enables the local phishing/plain-http/admin-path URL lens' } }, required: ['address'] } },
  { name: 'till_create_charge', description: 'Create a USDC-on-Base charge for a real-world merchant. Returns the charge + the EIP-681 payment URI your OWN wallet must execute (basetill holds no key, moves no funds).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'merchant 0x address (their own wallet — non-custodial)' },
      amountUsd: { type: 'string', description: 'e.g. "4.50"' },
      label: { type: 'string' }, orderId: { type: 'string' } }, required: ['to', 'amountUsd'] } },
  { name: 'till_check_payment', description: 'Watch Base for the USDC transfer paying a charge and verify it FIELD-FOR-FIELD (wrong chain/token/recipient/underpay/unconfirmed = NOT paid). Only the chain says paid — verification is chain-only and never depends on any trust signal. Pass withTrust:true to ALSO get the payee\'s advisory MainStreet trust in the same call (advisory, never changes the paid verdict).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, amountMicro: { type: 'string' },
      lookbackBlocks: { type: 'number', description: 'default 900 (~30 min on Base)' },
      withTrust: { type: 'boolean', description: 'optional — also return advisoryTrust (MainStreet safe-to-pay on the payee); does NOT affect the chain-only paid verdict' } }, required: ['to', 'amountMicro'] } },
  { name: 'till_trust', description: 'The TRUST TRIANGLE in one call: composes reputation, standing (LAWBOR proven history, if BIII_LAWBOR_URL set) and settlement (on-chain, if amountMicro given) into ONE verdict (unsafe/unknown/trusted/settled). Reputation is shown as TWO LENSES kept SEPARATE, never merged: `local` = this node\'s known-bad screen against public lists (no network, decisive — a BLOCK overrides everything) and `oracle` = MainStreet\'s advisory read (ORACLE-REPORTED, can raise trust but never lower a local block). Fail-closed: absence is never trust; a local BLOCK holds even if the oracle is down. Every verdict carries the list\'s freshness (asOf/ageDays/stale).',
    inputSchema: { type: 'object', properties: {
      counterparty: { type: 'string', description: '0x address to assess (the merchant, or a payer)' },
      amountMicro: { type: 'string', description: 'optional — if given, also check on-chain settlement to this address' },
      rail: { type: 'string', description: 'optional — the rail this payment settles on. BIII can WITNESS only "base" / "usdc-base" (it reads Base directly). Name any other rail — "card", "mastercard-agent-pay", "sepa", "stripe" — and the settlement vertex returns not_observable instead of pretending: the payment may well have completed, BIII simply cannot see it. Fail-closed: a rail we do not recognise is treated as unwitnessable, never as on-chain. Reputation and standing still decide, so a vetted counterparty stays payable; `proven` stays false because nothing was seen.' },
      resourceUrl: { type: 'string', description: 'optional — the endpoint/resource URL you would pay; enables the local phishing/plain-http/admin-path URL lens in the local classifier' },
      agentId: { type: 'string', description: 'optional — the counterparty\'s ERC-8004 agentId; surfaces a SEPARATE, advisory, re-verifiable ERC-8004 reputation lens (interop, never rival)' },
      erc8004Summary: { type: 'object', description: 'optional — a ReputationRegistry.getSummary result {count, summaryValue, summaryValueDecimals} for the agentId; BIII applies the sybil-honest lens + a re-verify pointer (BIII does not read the registry live yet)' },
      erc8004TrustedClients: { type: 'boolean', description: 'optional — attest the getSummary was filtered to clients YOU trust (drops the sybil caveat; still advisory)' } }, required: ['counterparty'] } },
  { name: 'till_create_invoice', description: 'Create a Web2-style INVOICE (number, line items, due date, bill-to) on the SAME non-custodial registry: paid by the same EIP-681 intent, verified by the same chain discipline, recorded in the same provable till roll. Returns the invoice + a human-readable bill (EN/FR) + the payment URI.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'merchant 0x address (their own wallet — non-custodial)' },
      lineItems: { type: 'array', description: '[{description, amountUsd} or {description, qty, unitUsd}]',
        items: { type: 'object', properties: { description: { type: 'string' }, amountUsd: { type: 'string' }, qty: { type: 'number' }, unitUsd: { type: 'string' } } } },
      number: { type: 'string' }, billTo: { type: 'string' }, merchantName: { type: 'string' },
      dueDateMs: { type: 'number' }, lang: { type: 'string', description: '"en" (default) or "fr"' },
      rail: { type: 'string', description: 'optional — how this invoice SETTLES. Absent or "base" = USDC on Base, which BIII reads and can therefore attest. Name any other rail ("card", "sepa", "cash", "mastercard-agent-pay") and till_check_invoice returns not_observable instead of calling the customer unpaid: an invoice settled by card or in cash will never appear on Base, so the absence of an on-chain transfer says nothing about them. Pass the SAME rail to till_check_invoice.' } },
      required: ['to', 'lineItems'] } },
  { name: 'till_check_invoice', description: 'Check an invoice against the chain: settled (paid on-chain, field-for-field) / overdue / issued / not_observable (settles on a rail BIII cannot read — ask the merchant\'s books, never assume unpaid). If settled, returns the receipt for the registry.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, totalMicro: { type: 'string', description: 'the invoice totalMicro' },
      number: { type: 'string' }, dueDateMs: { type: 'number' }, merchantName: { type: 'string' },
      rail: { type: 'string', description: 'optional — the SAME rail the invoice was created with. This tool rebuilds the invoice from these arguments, so a rail not passed here is a rail BIII cannot know about, and an off-chain invoice would be reported "overdue, unpaid" about a customer who has paid.' },
      lookbackBlocks: { type: 'number', description: 'default 43200 (~1 day on Base); invoices are slower than tills' } }, required: ['to', 'totalMicro'] } },
  { name: 'till_vet_asset', description: 'Is a TOKENIZED ASSET (stock/treasury/RWA) contract the GENUINE issuer\'s, or an impersonator? genuine / impersonation / unsafe / unknown — fail-closed (unknown is never genuine). Catches the FBI-flagged lookalike-token fraud. Registry is authoritative: seed only; source real addresses from issuer official docs.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string', description: '0x contract address of the token' },
      claimedIssuer: { type: 'string', description: 'what it claims to be, e.g. "BlackRock"' },
      claimedSymbol: { type: 'string', description: 'e.g. "BUIDL", "TSLAx"' } }, required: ['token'] } },
  { name: 'till_vet_meme', description: 'Which contract is the REAL memecoin among 10+ look-alikes? Fail-closed verdict from live market data (DexScreener). Returns: genuine (one contract dominates liquidity), ambiguous (top-2 tied — never certified), impersonation (the address you passed is NOT the dominant one), thin (no credible liquidity). Advisory + re-verifiable.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', description: 'memecoin symbol, e.g. "TOSHI", "BRETT"' },
      chainId: { type: ['string', 'number'], description: 'optional chain filter — the DexScreener slug ("base", "solana", "ethereum") or an EVM chain id (8453 = Base). A chain we cannot map returns NO candidates rather than silently searching every chain: being handed a Solana contract after asking for Base is worse than being handed nothing.' },
      address: { type: 'string', description: 'optional specific contract address to judge' } }, required: ['symbol'] } },
  { name: 'till_receipt', description: 'Produce the chain-anchored receipt for a VERIFIED payment (txHash + basescan link). Refuses without verification.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, amountUsd: { type: 'string' }, label: { type: 'string' },
      merchantName: { type: 'string' }, lookbackBlocks: { type: 'number' } }, required: ['to', 'amountUsd'] } },
  { name: 'till_roll', description: 'PROVABLE BOOKS: render an agent/merchant\'s till roll — a shareable statement where EVERY line carries its own txHash + basescan link, so the reader re-verifies each payment on Base themselves (trust no one, not even BIII). This is the substitute for the settlement statement an excluded merchant/agent loses when they leave a PSP. Pure and non-custodial (BIII holds no funds). Pass the verified receipts you collected from till_receipt.',
    inputSchema: { type: 'object', properties: {
      receipts: { type: 'array', description: 'the verified receipt objects (from till_receipt), each carrying a txHash', items: { type: 'object' } },
      merchantName: { type: 'string' }, lang: { type: 'string', description: '"en" (default) or "fr"' },
      brand: { description: 'WHITE-LABEL: a partner brand for the footer ("via <name>", optionally "· powered by BIII"). String or {name, poweredBy}. The non-custodial disclosure is a fact and stays regardless.' } }, required: ['receipts'] } },
  { name: 'till_export', description: 'ACCOUNTING EXPORT: turn the verified receipts into an accountant-ready CSV that QuickBooks / Xero / Excel import (the export finance teams need to adopt). Every row carries its own txHash + Basescan link, so the accountant re-verifies each amount on Base themselves — the export is a POINTER to the chain, never a book to trust. Non-custodial (BIII moved no funds). Columns: date, receipt_no, reference, description, payer, gross_usdc, tip_usdc, charged_usdc, token, chain, tx_hash, basescan_url, status. Dedup by txHash; optional block-time window; brand slugs the filename. WINDOW HONESTY: a receipt with no on-chain block time cannot be proven to fall inside a dated window, so it is excluded from one — and summary.undatedExcluded reports HOW MANY were, with the same warning prepended to `disclosure`. If that count is non-zero the CSV is short by those rows: re-run with no window to see them all.',
    inputSchema: { type: 'object', properties: {
      receipts: { type: 'array', description: 'the verified receipt objects (from till_receipt), each carrying a txHash', items: { type: 'object' } },
      fromBlockTime: { type: 'number', description: 'optional — only export receipts settled at/after this unix block time' },
      toBlockTime: { type: 'number', description: 'optional — only export receipts settled at/before this unix block time' },
      brand: { description: 'WHITE-LABEL: a partner brand (string or {name}) — slugs the download filename; the non-custodial disclosure stays regardless.' } }, required: ['receipts'] } },
  { name: 'till_meter', description: 'USAGE → BILL for a white-label pilot, split by trust. The settled receipts are ON-CHAIN (each txHash re-verifiable on Base — the PROVABLE basis for receipt charges); the verdict count is SELF-REPORTED (verdicts are advisory reads, not chain artifacts) and labeled as such. The pricing plan is INJECTED (the partner brings their tiers). Pure, stateless, non-custodial (BIII holds no ledger). Returns the provable/self-reported split + itemized charges + total. WINDOW HONESTY: a receipt with no on-chain block time is excluded from a DATED window (its date cannot be proven) and counted in provable.undatedExcluded — a non-zero value means the bill is UNDER-charged by those receipts, so check it before invoicing.',
    inputSchema: { type: 'object', properties: {
      receipts: { type: 'array', description: 'the verified receipt objects (from till_receipt) — the provable on-chain usage', items: { type: 'object' } },
      verdictCount: { type: 'number', description: 'optional — operator-reported number of trust verdicts served this period (advisory, NOT chain-provable)' },
      plan: { type: 'object', description: 'optional pricing plan: {name, monthlyBaseUsd, includedVerdicts, verdictOverageUsd, includedReceipts, receiptOverageUsd}. Defaults to the pilot template ($750/mo, 5000 verdicts, $0.25/verdict, $0.03/receipt).' },
      fromBlockTime: { type: 'number' }, toBlockTime: { type: 'number' } }, required: ['receipts'] } },
  { name: 'till_floor', description: 'DECENTRALIZATION PROOF: the provenance + content-FINGERPRINT of this node\'s known-bad floor. Two nodes with the SAME fingerprint judge on the SAME floor — sameness is a checkable fact, not an operator\'s word. The floor is re-derivable from named public open-licensed lists (run scripts/biii-known-bad-ingest.js and confirm the hash), so convergence is on PUBLIC DATA + a deterministic hash, never on a central node. Compare fingerprints across nodes to prove they share the same objective floor.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'till_resolve', description: 'IDENTITY BRIDGE: resolve an AGENT identity — a buzz/Nostr npub (64-hex secp256k1) AND/OR a gitlawb did:key (Ed25519) — to a payable, trust-assessable BASE address, trustlessly. The binding is a BIDIRECTIONAL attestation: each identity key AND the Base key sign the same canonical message, so anyone re-verifies the signatures (BIII never takes your word). A binding needs AT LEAST one identity key (npub or did). Fail-closed: unverified / an identity key missing its signature / expired / un-nonced / malformed ⇒ a CLAIM, not a binding (bound:false). BIII does not verify secp256k1/Ed25519 itself (no dep) — supply verified:true after checking the sigs, or re-verify with the returned pointer. When bound, feed the address to till_trust / till_vet_merchant (resolving is NOT trusting).',
    inputSchema: { type: 'object', properties: {
      npub: { type: 'string', description: 'the agent\'s 64-hex secp256k1 pubkey (Nostr/buzz identity) — provide npub and/or did' },
      did: { type: 'string', description: 'the agent\'s gitlawb did:key (Ed25519 identity) — provide did and/or npub' },
      address: { type: 'string', description: 'the claimed Base address (0x…)' },
      nonce: { type: 'string', description: 'a per-binding nonce (anti-replay) — required' },
      chainId: { type: 'number', description: 'default 8453 (Base)' },
      expiry: { type: 'number', description: 'optional unix seconds; 0 = no expiry' },
      sigNostr: { type: 'string', description: 'the Nostr key\'s signature over the canonical message (required if npub is present)' },
      sigDid: { type: 'string', description: 'the did:key\'s Ed25519 signature over the canonical message (required if did is present)' },
      sigBase: { type: 'string', description: 'the Base key\'s signature over the canonical message (always required)' },
      verified: { type: 'boolean', description: 'attest that every present signature verified (BIII does not check secp256k1/Ed25519 itself)' } }, required: ['address'] } },
  { name: 'till_kya', description: 'IDENTITY STANDARD (interop): read a Skyfire KYA ("Know Your Agent") JWT — the signed token binding a real human/business to an agent (Experian\'s identity layer). The IDENTITY counterpart to till_trust\'s ERC-8004 reputation lens. Parses the JWT + validates fail-closed (iss/sub present, not expired, aud matches YOU — anti-replay), and treats it as ATTESTED only when you confirm the signature verified against the issuer JWKS (BIII does not verify JWT signatures itself — no dep; supply verified:true or re-verify with the pointer). Advisory: attesting WHO backs an agent is NOT "safe to pay" — run till_trust on the address.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string', description: 'the compact KYA JWT (header.payload.signature)' },
      expectedAudience: { type: 'string', description: 'the recipient this token must be addressed to (its aud) — anti-replay; recommended' },
      requireExpiry: { type: 'boolean', description: 'strict mode: REFUSE a KYA JWT with no exp (a never-expiring vouch). Default false — a no-exp token still attests but is flagged posture.expires:false' },
      verified: { type: 'boolean', description: 'attest the JWT signature verified against the issuer\'s JWKS (BIII does not check it itself)' } }, required: ['token'] } },
  { name: 'till_authorize', description: 'SPEND AUTHORIZATION (Skyfire Programmable Payment): create a charge AND check it against what the agent\'s OWNER signed off — token, recipient allow-list, per-charge max, AND the cumulative cap. Fail-closed and drain-safe: an EIP-681 payment intent is issued ONLY if the charge is authorized (ten small charges cannot beat a low cap). BIII does not verify the authorization JWT signature itself — pass verified:true after checking it, or supply a spendAuth object. The caller tracks spentMicro (BIII is stateless).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'merchant 0x address (their own wallet)' },
      amountUsd: { type: 'string', description: 'e.g. "12.50" (or use amountMicro)' },
      amountMicro: { type: 'string' }, label: { type: 'string' },
      spendAuth: { description: 'the owner\'s signed spend authorization: a Programmable-Payment JWT (string) OR an object {token, chainId, maxPerChargeMicro, cumulativeCapMicro, allowedRecipients, exp}' },
      spentMicro: { type: 'string', description: 'how much has ALREADY been spent under this authorization (the caller\'s running total — the cumulative guard)' },
      verified: { type: 'boolean', description: 'attest the authorization JWT signature verified (BIII does not check it itself)' } }, required: ['to', 'spendAuth'] } },

  { name: 'till_rug_powers', description: 'WHO CAN STILL RUG THIS TOKEN? till_vet_meme says which contract is the real one; this says whether the real one is itself a trap. A dangerous capability only counts if someone can still FIRE it — mintable with ownership renounced is inert, the same flag with a live owner is an armed rug, and scoring flags without that distinction is why most scanners are noise. Merges two sources that fail at opposite ends: a curated index (owner powers, LP locks) that has never heard of a token minted ten minutes ago, and a live trade simulation that always works on fresh deploys but sees nothing about control. Fail-closed: NEVER returns clean on simulation alone, because "you can sell it right now" is not safety. Verdicts: rug_ready / high_risk / caution / clean / unknown.',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'token contract address' },
      chain: { type: 'string', description: 'base (default) | ethereum | bsc | polygon | arbitrum | optimism | avalanche' } }, required: ['address'] } },

  { name: 'till_launch_funder', description: 'WHO PAID FOR THIS LAUNCH, AND WHAT ELSE DID THEY PAY FOR? Follows the money backwards: a token names its creator, a creator minted minutes ago names the wallet that funded it, and that funder usually funded others. Three free explorer queries surface a cluster no buyer can see from a chart. Proven live: one funder had sent an identical 15.020 ETH to 26 fresh wallets. Reports STRUCTURE ONLY — a shared funder proves shared control or shared infrastructure, never fraud; a launchpad and a rug factory are indistinguishable from the graph. What it does prove is that these tokens share fate and should be judged together.',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'token contract address' },
      chain: { type: 'string', description: 'base (default) — chains with a public Blockscout instance' } }, required: ['address'] } },

  { name: 'till_b20_authentic', description: 'IS THIS A REAL BASE-NATIVE B20, OR AN ERC-20 WEARING ITS ADDRESS PREFIX? B20 is Base\'s native standard for compliant asset issuance (stablecoins, RWA); its tokens sit at addresses starting 0xb200 and run as a precompile, so a genuine one carries almost no EVM bytecode. As people learn to read 0xb200 as "official Base asset", a plain ERC-20 at a vanity address of the same prefix inherits that credibility for free — landing on it by chance is about 1 in 65,536. Both outcomes matter and differ: an impostor lacks the issuer controls the standard implies, while a GENUINE B20 lets its issuer freeze and burn a blocked holder\'s balance — a power no ERC-20 has and no ERC-20-shaped scanner looks for. Verdicts: native_b20 / prefix_impostor / not_b20 / unknown.',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'token contract address' },
      chain: { type: 'string', description: 'base (default)' } }, required: ['address'] } },

  { name: 'till_trace_theft', description: 'FOLLOW STOLEN FUNDS from the victim\'s transaction to where the trail dies. Three modes. moved: what actually left a wallet in one transaction, marking which transfers are AUTHENTIC — ERC-20 Transfer logs are attacker-controlled text, so only the transaction signer is authoritative and forged events are flagged rather than followed. bridge: read a cross-chain exit; aggregators write the destination chain and receiver into their own calldata because the far side needs them, and chain ids are checked against a table before any field is called an amount (0x2b6653dc reads as a plausible token amount and is in fact TRON mainnet). tron: walk a TRON account\'s flow, detecting relay hops — an account forwarding the amount it received, within seconds, is a pass-through and not a destination. Reports hops, never identity or intent.',
    inputSchema: { type: 'object', properties: {
      mode: { type: 'string', description: 'moved | bridge | tron' },
      txHash: { type: 'string', description: 'transaction hash (modes: moved, bridge)' },
      address: { type: 'string', description: 'TRON address, T-form (mode: tron)' },
      chain: { type: 'string', description: 'EVM chain for moved/bridge — base (default) | ethereum | optimism | polygon | arbitrum | gnosis' },
      maxHops: { type: 'number', description: 'tron mode: how far to walk (default 3)' } }, required: ['mode'] } },

  { name: 'till_recovery_offer', description: 'THE SECOND THEFT: judge an approach offering to recover already-stolen funds. Every other tool here tries to stop the first loss; this exists because the first loss is what makes a person findable, and a drained wallet is a lead with a market for it. Answerable with certainty rather than a score, because the ask itself is the tell: recovery happens through the thief returning funds, or a court, exchange, or issuer freezing and reassigning them — none of which require anything from the victim\'s wallet. So a recovery needing your signature or an upfront fee is not merely suspect, it is structurally impossible as described, no matter how credible the person sounds or how accurately they recite your loss (the theft is public — anyone can read it back to you). Also reads the chain for the harvesting shape: many unrelated senders paying one address that returns nothing. NEVER returns "safe".',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'the address you were asked to pay or interact with (optional — its absence is not reassurance)' },
      chain: { type: 'string', description: 'base (default) | ethereum | polygon | arbitrum | optimism' },
      asksForSignature: { type: 'boolean', description: 'were you asked to sign a message or transaction?' },
      asksForUpfrontPayment: { type: 'boolean', description: 'were you asked to pay a fee before delivery?' },
      asksForSeedOrKey: { type: 'boolean', description: 'were you asked for a seed phrase, private key or keystore?' },
      asksToInstall: { type: 'boolean', description: 'were you asked to download or run anything?' } }, required: [] } },

  { name: 'till_vet_approach', description: 'JUDGE AN INBOUND OPPORTUNITY BY ITS ASK, NOT BY HOW GOOD IT LOOKS (podcast, interview, partnership, job, AMA). Built from a lure that worked on someone who verifies counterparties professionally: a 35-question production dossier citing his real scoring model, his settlement rails, his own catchphrase, quoting his posts verbatim — and asking genuinely HARD questions, because a flatterer never includes criticism and including it is what flips an approach from marketing to journalism in the reader\'s head. The mechanism is EFFORT AS A TRUST SIGNAL: that much researched detail used to cost hours of human work, so nobody spent it on one target, and everyone\'s instinct silently priced that in. The arithmetic was right for decades and is not right now. So this deliberately does NOT score how convincing an approach is — grading convincingness would just give a forgery a good mark. It grades the two things a forger cannot hide: where a link ACTUALLY points (a brand name to the left of the registrable domain is a free label, so wechat.web09eu.com is web09eu.com), and what the sender wants you to do. Never returns "safe".',
    inputSchema: { type: 'object', properties: {
      links: { type: 'array', items: { type: 'string' }, description: 'every URL in the message' },
      platform: { type: 'string', description: 'the platform they named, e.g. "WeChat", "Zoom"' },
      asksToInstall: { type: 'boolean' }, asksForKeyOrSeed: { type: 'boolean' },
      asksForSignature: { type: 'boolean' }, asksForUpfrontPayment: { type: 'boolean' },
      urgency: { type: 'boolean', description: 'was time pressure applied?' } }, required: [] } },

  { name: 'till_open_approvals', description: 'WHICH DOORS INTO THIS WALLET ARE STILL OPEN? An ERC-20 approval is a standing permission to move your tokens without asking again, and it is the most common drain vector that does NOT require the private key: you approved a contract once for an unlimited amount and forgot. Wallets do not surface these, so almost nobody knows what they have granted. The load-bearing discipline: an Approval EVENT IS NOT THE CURRENT STATE — a later approval of zero revokes an earlier one silently, so the log is used only to find candidate (token, spender) pairs and every one is then confirmed by calling allowance() on the chain right now. Reports three outcomes, never two: live, confirmed-revoked, and COULD-NOT-CHECK. The first draft collapsed the last two and reported forty closed doors having verified nine — an unanswered call is not a closed door. Read-only: it tells you what to revoke and where, and can never revoke or sign anything itself.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'the wallet address to audit' },
      chain: { type: 'string', description: 'base (default) | ethereum' },
      fromBlock: { type: 'number', description: 'optional: scan from this block (default 0)' } }, required: ['owner'] } },

  { name: 'till_watch_wallet', description: 'WHAT CHANGED AROUND THIS WALLET SINCE WE LAST LOOKED? The other tools answer at a point in time; this is what turns them into a guard, because it REMEMBERS and therefore distinguishes a new door from an old one. Three unlimited approvals granted last year are a standing condition; a fourth appearing this morning is an event, and only the second deserves to interrupt anyone — a monitor that repeats its standing conditions every run teaches its reader to close it, and a closed monitor is worth nothing. Detects new live allowances and first-time counterparties, using TRANSACTIONS rather than event logs (an ERC-20 Transfer log names whoever the emitting contract chose, so it cannot establish that this wallet sent anything). Reports its own blind spots every run: on a wallet monitor an empty alert list reads as "you are safe", so a check that could not complete is stated, never swallowed. First run is an inventory, not a set of events. Read-only: holds no key, cannot revoke or sign.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'the wallet address to watch' },
      chain: { type: 'string', description: 'base (default) | ethereum' },
      persist: { type: 'boolean', description: 'default true — save state so the NEXT call can diff against it. Pass false for a one-off look that does not become the baseline.' } }, required: ['owner'] } },

  { name: 'till_vet_agent', description: 'IS THIS AGENT SAFE TO CONNECT TO, AND SAFE TO PAY? The gap this closes: everything else here judges tokens, launches, thefts and wallets, but never the AGENT — which is the thing that actually holds the tools. Four checkable dangers, none of which require trusting a word of the description. It does not exist (a listing is not a service, and paying an endpoint that never answers is the simplest loss available). Its tools can move money (a name is marketing; the input SCHEMA is the capability, and only a QUANTITY field proves a payment surface, because a message has a recipient exactly as a payment does but you cannot move value without saying how much). It asks for key material (a schema field for a private key or seed is the whole attack, declared in the open). Or it is paid to an address with no past. Deliberately does NOT grade how good the description reads: a well-written tool listing is free to fabricate now, so scoring prose would hand a forgery a good mark. Read-only — it introspects and never calls a tool. Never returns "safe".',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string', description: 'the agent\'s HTTP MCP endpoint' },
      payTo: { type: 'string', description: 'optional: the address that would receive payment' },
      chain: { type: 'string', description: 'base (default)' } }, required: [] } },
  { name: 'till_seed_exposure', description: 'IS A RECOVERY PHRASE SITTING IN CLEARTEXT ON THIS MACHINE? Everything else here answers whether an ADDRESS is safe to pay; this answers whether the MACHINE is safe to hold a wallet, and a safe address on a compromised machine is worth nothing. "Self custody if you know how to keep your seedphrase safe" puts the whole condition in the sentence and nothing ships that checks it: an antivirus answers "do you have a known virus", which is a different question. This one is DECIDABLE rather than scored. A keyword scan drowns — abandon, able, about and absent are ordinary English and all four are BIP-39 words — but a mnemonic is a RUN of 12/15/18/21/24 consecutive words from a 2048-word list with a CHECKSUM in the last word, so a candidate is proven by arithmetic. Measured across 204 files and 1.6 MB of real prose and source: zero false confirmations. It NEVER outputs the phrase — file, line and word count only, because this output ends up in terminal buffers, logs and screenshots, and a scanner that prints the seed it found is a stealer with good intentions. Reports its own blind spots: no images, PDFs, password managers, browser storage or encrypted archives, so "nothing found" means nothing was found IN WHAT WAS READ. Read-only, no network, nothing is copied.',
    inputSchema: { type: 'object', properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'directories to scan; defaults to Documents, Desktop, Downloads and the OneDrive equivalents' } }, required: [] } },

  { name: 'till_key_exposure', description: 'WHAT KEY MATERIAL IS ON THIS DISK, AND WHAT STILL HOLDS AN OLD COPY OF IT? The companion to till_seed_exposure, and it exists because a real theft happened without the phrase ever being written down: the key was exfiltrated. The trap is that a secp256k1 private key is 64 hex characters and so is every SHA-256 hash, git object id and transaction hash in a saved response, so the value SHAPE carries almost no information. Two things do: STRUCTURE (a Web3 Secret Storage keystore has version 3 and a crypto member with ciphertext, kdf and mac — nothing else looks like that, and finding one is not an exposure but an encrypted wallet whose strength is its password) and THE LABEL (cleartext keys are named by what needs them, so PRIVATE_KEY matches and PRIVATE_KEY_HASH is rejected as a digest). RETAINED COPIES are what people miss: ROTATING A SECRET DOES NOT REMOVE IT FROM THE DISK, because editor history, session caches and backup folders keep snapshots of what the file used to say — on the machine this was built for, one .env holding three named keys had eighteen previous versions still readable, and the folder had been copied into a keep-across-the-reformat backup. Also reports browser wallet vaults by PRESENCE only, nothing opened or parsed, because that is how a key leaves a machine when it was never in a text file. Never outputs key material, not even a prefix: four bytes narrow a brute force. Never decrypts, never derives an address.',
    inputSchema: { type: 'object', properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'directories to scan; defaults to Documents, Desktop and Downloads' } }, required: [] } },
  { name: 'till_verify_delivery', description: 'I CAN PROVE I PAID. CAN I PROVE I WAS SERVED? Every other check here runs before money moves; this is the question after, and it is the one nothing in this market answers. A payment is a fact on Base that anyone can re-check forever; the deliverable was a sentence in a message. So a buyer can prove it spent and cannot prove it received — and every settlement record in existence, including the ones this server writes, records the money and takes the goods on trust. The fix is a commitment, not an opinion: the seller publishes sha256(deliverable) BEFORE being paid, the buyer hashes what arrived and compares. That settles exactly two things no prose can fake — the deliverable EXISTED before the money (you cannot hash what you have not made, which kills "pay me and I will get to it") and the bytes were NOT SWAPPED for something cheaper once the funds cleared. FOUR states, and the last two are the point. `commitment_too_late`: the bytes match but the hash was published at or after payment, so it proves only that nobody edited it afterwards — a hash published after the funds clear can simply be the hash of whatever was eventually sent, which is the exact trick this catches, and calling it `served` would bless it. `unverifiable`: no commitment was made, which is the honest verdict for almost every agent transaction today — a buyer must know it never had the MEANS to check rather than believe it passed one. It proves NOTHING about quality: a committed hash of garbage verifies perfectly. Pure, offline, no network, no keys.',
    inputSchema: { type: 'object', properties: {
      commitmentHash: { type: 'string', description: '0x + sha256 the seller published BEFORE payment. Omit it and the answer is unverifiable, which is the truth.' },
      received: { type: 'string', description: 'the bytes you actually received (or pass receivedHash instead if you hashed them yourself)' },
      receivedHash: { type: 'string', description: '0x + sha256 of what you received, if you would rather not send the artifact' },
      paidAt: { type: 'number', description: 'block or unix ms of the payment — needed for the strong claim' },
      committedAt: { type: 'number', description: 'block or unix ms at which the commitment was recorded somewhere the seller cannot rewrite' } }, required: [] } },
  { name: 'till_funder_history', description: 'HAS THE WALLET THAT PAID FOR THIS LAUNCH ALREADY KILLED ONE? till_launch_funder reads the graph and tells you a cluster exists; this reads our OWN observation record and tells you what happened to the rest of it. The distinction matters because every other check here asks the token a question it cannot answer in time: a curated security index returns an owner address for roughly one Base token in ten, so "who can still fire a rug power" — the question this whole scanner was built on — came back unanswerable on 221 of 221 launches we watched. Who PAID is answerable, because we watched that ourselves. THE EVIDENCE IS WALK-FORWARD, which is the only kind worth quoting: every token was replayed in time order and judged using strictly earlier history, so no prediction ever saw its own outcome or any later one. A payer with a prior kill was followed by another death in 62 of 67 resolved cases (93%) against a 52% base rate, and it holds across SIX independent payers, each 75-100% lethal — not one outlier carrying an average. Read the limits as part of the answer: six operators is not sixty, "clean so far" rests on two payers and is an absence of a bad record rather than a good one, and 47% of watched launches have no funder on file — but 96% of THOSE were never traced at all, because tracing is capped per run, so that number measures our own budget and not the chain; they are reported as out of reach rather than safe, and never as evidence. AND IT IS EVADABLE FOR THE PRICE OF ONE HOP — a fresh funding wallet lands in "never seen", which is already 30% of cases. It makes REUSE expensive, which is what an operation running dozens of launches an hour actually does; expect the strong bucket to decay as operators adapt. Structure, never intent: a shared funder proves shared control or shared infrastructure, and a launchpad looks identical from the graph. Every answer carries the age of the database, and past the freshness bar the reassuring verdicts are WITHDRAWN rather than annotated, because a stale "never killed" is the exact sentence that gets someone hurt. Pure, offline, read-only.',
    inputSchema: { type: 'object', properties: {
      funder: { type: 'string', description: 'the wallet that PAID for the launch — get it from till_launch_funder, which traces deployer→funder on chain. Omit it and the honest answer is that this check has nothing to say.' } }, required: [] } },
];

/**
 * exigeAdresse — LA MEME ENTREE, LE MEME REFUS, SUR TOUS LES OUTILS.
 *
 * `till_trust` a ete durci (ligne ~315) pour refuser une adresse malformee au lieu de composer un
 * triangle dessus, et son commentaire pose la regle: le meme refus sur les deux surfaces. Les autres
 * outils prenant une adresse n'ont pas ete amenes avec. Mesure du 2026-07-28, meme entree `0x123`:
 *
 *   till_trust        -> REFUS, aucun verdict
 *   till_vet_merchant -> VERDICT
 *   till_rug_powers   -> VERDICT
 *
 * Et le plus couteux n'est pas l'absence de refus, c'est ce que devient l'erreur. `till_vet_merchant`
 * envoyait la chaine a l'oracle, recevait un HTTP 400, et le rapportait ainsi:
 *
 *   « oracle unreachable (HTTP 400) — treat the merchant as UNKNOWN, not as safe »
 *
 * Deux causes OPPOSEES aplaties sur un meme message: « mon entree est invalide » et « le service est
 * tombe ». La difference est actionnable — corriger l'adresse, ou reessayer plus tard — et un agent qui
 * a fait une faute de frappe est informe d'une panne, donc il peut reessayer indefiniment. Au passage,
 * une chaine arbitraire partait vers un service tiers.
 *
 * Meme forme que `till_trust`: on minuscule (une adresse checksummee est valide), on ne TRIM pas — on ne
 * devine pas ce que l'appelant voulait dire.
 */
const ADRESSE_BASE = /^0x[0-9a-f]{40}$/;
function exigeAdresse(brut, champ = 'address') {
  const adr = String(brut || '').toLowerCase();
  if (!ADRESSE_BASE.test(adr)) {
    return { error: champ + ' must be a 0x Base address (40 hex) — no verdict is composed for a '
      + 'malformed one, and nothing is sent to the oracle. This is a REJECTED INPUT, not a service '
      + 'outage: re-send a valid address rather than retrying.', got: String(brut ?? '').slice(0, 40) };
  }
  return { adresse: adr };
}

/**
 * instantMs — un horodatage FOURNI mais illisible n'est pas un horodatage ABSENT.
 *
 * ⚠️ `Number(a.paidAt)` detruisait toute date ISO-8601. Mesure du 2026-07-28, meme scenario, engagement
 * publie APRES le paiement — le tour exact que `till_verify_delivery` existe pour attraper:
 *
 *   committedAt/paidAt en millisecondes -> commitment_too_late   ✓
 *   committedAt/paidAt en ISO-8601      -> served                ✗
 *
 * `Number('2026-07-02T00:00:00Z')` vaut NaN, les deux instants tombaient a null, et `lib/delivery.js` —
 * qui est correct — repondait honnetement « Ordering was NOT supplied ». Sauf que l'appelant AVAIT
 * fourni l'ordre: la coercition l'avait mange, et l'outil lui disait qu'il ne l'avait pas donne. Une
 * valeur non LUE presentee comme non DONNEE, avec le verdict propre a la place de la prise.
 *
 * L'ISO est la forme la plus naturelle ici: c'est celle de tous les horodatages de ce depot.
 *
 * ⚠️ Les nombres sont testes AVANT `Date.parse`, sinon `Date.parse(0)` rendrait l'an 2000 pour l'epoch.
 */
function instantMs(v) {
  if (v == null || v === '') return { fourni: false, ms: null };
  if (typeof v === 'number') return Number.isFinite(v) ? { fourni: true, ms: v } : { fourni: true, ms: null };
  const n = Number(v);
  if (Number.isFinite(n)) return { fourni: true, ms: n };
  const d = Date.parse(String(v));
  return { fourni: true, ms: Number.isFinite(d) ? d : null };
}

async function callTool(name, a = {}) {
  if (name === 'till_vet_merchant') {
    const g = exigeAdresse(a.address); if (g.error) return g;
    // DECENTRALIZED floor FIRST: a locally-known-bad address is refused with zero network, even if the
    // oracle is slow/down — the block cannot vanish with the service (the SPOF this closes).
    const local = screenAddress(a.address, KNOWN_BAD);
    const localClassifier = localClassify(a.address, { resourceUrl: a.resourceUrl });   // this node's own verdict, no oracle
    if (local.blocked) return { decision: 'BLOCK', score: 0, source: 'local-known-bad', advisory: local.reason, localClassifier };
    const screen = screenMeta(KNOWN_BAD);   // freshness of the floor a "not-known-bad" result leans on
    try {
      const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(String(a.address || ''))}`,
        { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { advisory: 'oracle unreachable (HTTP ' + r.status + ') — treat the merchant as UNKNOWN, not as safe', screen, localClassifier };
      const j = await r.json();
      return { decision: j.decision ?? null, score: j.score ?? null, source: 'mainstreet-oracle', advisory: 'ORACLE-REPORTED — advisory only, never a guarantee', screen, localClassifier };
    } catch (e) {
      // a timeout used to THROW here (no catch) and crash the tool; degrade honestly instead.
      return { advisory: 'oracle unreachable (' + (e && e.message) + ') — treat the merchant as UNKNOWN, not as safe', screen, localClassifier };
    }
  }
  if (name === 'till_create_charge') {
    const charge = T.createCharge({ to: a.to, amountUsd: a.amountUsd, label: a.label, orderId: a.orderId, nowMs: Date.now() });
    return { charge, paymentURI: T.paymentURI(charge),
      note: 'Execute this EIP-681 intent with YOUR OWN wallet (basetill signs nothing). Then till_check_payment.' };
  }
  if (name === 'till_check_payment') {
    /* ⚠️ SANS GARDE, `{}` PARTAIT SUR LA CHAÎNE ET L'EXCEPTION S'ÉCHAPPAIT EN `-32000 tool failed —
     * check arguments`. Mesuré le 2026-07-30 sur le vrai serveur. Trois défauts dans un :
     *   · l'appel RPC était BRÛLÉ avant toute validation (valider d'abord, dépenser ensuite) ;
     *   · le message générique ne dit pas QUEL champ est fautif, donc il n'est pas actionnable ;
     *   · une exception n'est pas un refus — un appelant ne peut pas distinguer « entrée invalide »
     *     d'une panne du serveur, et sur un outil de VÉRIFICATION DE PAIEMENT c'est la confusion
     *     qu'il faut le moins.
     * Le garde `exigeAdresse` existait déjà dans ce fichier et n'avait pas été posé ici. */
    const g = exigeAdresse(a.to, 'to'); if (g.error) return g;
    if (!/^\d+$/.test(String(a.amountMicro || ''))) {
      return { error: 'REJECTED INPUT: `amountMicro` is ' + (a.amountMicro == null ? 'missing' : JSON.stringify(String(a.amountMicro)).slice(0, 24))
        + ' — it must be an integer number of USDC micro-units (6 decimals, e.g. "1500000" for $1.50). '
        + 'NOTHING WAS CHECKED ON CHAIN — this is not a verdict that the payment is missing.' };
    }
    const charge = { to: String(a.to || '').toLowerCase(), amountMicro: String(a.amountMicro || ''), amountUsd: T.microToUsd(String(a.amountMicro || '0')), token: T.USDC_BASE, chainId: 8453 };
    const fact = await findPayment({ to: charge.to, minMicro: charge.amountMicro, lookbackBlocks: a.lookbackBlocks || 900 });
    const out = { verdict: T.verifyPayment(charge, fact), fact: fact || null };
    // OPT-IN advisory (default OFF, so verification stays chain-only — the decoupling that IS the product):
    // an agent that wants "did it land AND is this payee still safe?" in one call opts in. It is ADVISORY
    // and NEVER changes `verdict` — only the chain says paid.
    if (a.withTrust) out.advisoryTrust = { reputation: await fetchReputation(charge.to),
      note: 'ADVISORY only — MainStreet safe-to-pay on the payee. Does NOT affect the paid verdict (chain-only).' };
    return out;
  }
  if (name === 'till_trust') {
    const cp = String(a.counterparty || '').toLowerCase();
    /* LA MEME ENTREE, LE MEME REFUS, SUR LES DEUX SURFACES. lib/server.js:265 rend 400 sur une adresse
     * malformee (« no verdict for a malformed address »); ce handler, lui, composait le triangle sur
     * n'importe quelle chaine — y compris la chaine vide, qui partait interroger l'oracle et le noeud
     * LAWBOR « a propos de rien ». Le resultat sortait fail-closed (unknown / payable:false), donc rien
     * de dangereux n'en sortait: c'est un defaut de FORME, corrige pour l'asymetrie, pas pour un risque.
     *
     * Le pont d'identite ne perd rien: till_resolve est un outil distinct, et sa propre description dit
     * de passer a till_trust l'ADRESSE resolue. Le schema de ce parametre dit deja « 0x address ». */
    if (!/^0x[0-9a-f]{40}$/.test(cp)) {
      /* La DISTINCTION est commune a tous les outils (voir `exigeAdresse`): un appelant doit pouvoir
       * separer « mon entree est invalide » de « le service est tombe », sinon il reessaie une panne qui
       * n'existe pas. Le conseil, lui, reste propre a cet outil. */
      return { error: 'counterparty must be a 0x Base address (40 hex) — no verdict is composed for a '
        + 'malformed identifier. This is a REJECTED INPUT, not a service outage: fix the value rather '
        + 'than retrying. Resolve an npub/did:key with till_resolve first, then pass the bound '
        + 'address here (resolving is not trusting).' };
    }
    // vertex 1 — reputation, shown as TWO LENSES kept SEPARATE (LAWBOR's discipline, verbatim): the LOCAL
    // known-bad screen (verified by THIS node against public lists, no network — decisive on a BLOCK) and
    // the ORACLE (MainStreet, ORACLE-REPORTED, advisory). They are never merged into one score — averaging
    // would launder the oracle's word into local proof, and would let an oracle PROCEED dilute a local BLOCK.
    const localScreen = screenAddress(cp, KNOWN_BAD);
    const meta = screenMeta(KNOWN_BAD);
    const oracle = localScreen.blocked ? { note: 'not consulted — the local BLOCK is decisive' } : await fetchOracle(cp);
    // The single decision fed to assessTriangle: local BLOCK wins; else the oracle's; else null (unknown).
    /* ⚠️ `oracle.error` EXISTE et se perdait ici. fetchOracle distingue deja « injoignable / non-200 »
     * ({error}) de « a repondu » ({decision, score}); cette ligne ecrasait les deux sur `null`, et
     * repVertex(null) rendait `unknown` — un statut qui compte comme LU. Une panne de l'oracle sortait
     * donc en triangle COMPLET. La distinction est desormais transmise telle quelle. */
    const reputation = localScreen.blocked ? { decision: 'BLOCK', score: null }
      : (oracle.error ? { unqueried: true, reason: oracle.error + ' — unread on our side, not a verdict' }
        : ((oracle.decision != null || oracle.score != null) ? { decision: oracle.decision, score: oracle.score } : null));
    const reputationLenses = {
      /* ⚠️ `available` (« une liste est-elle chargee ? ») et `reason` (« CETTE adresse a-t-elle pu etre
       * criblee ? ») repondent a deux questions differentes et sont colles cote a cote. Sur une
       * contrepartie qui n'etait pas une adresse, ca donnait available:true, blocked:false,
       * reason:"not a 0x address" — un lecteur y lit « liste a jour, pas bloque » alors que RIEN n'avait
       * ete crible. Mesure du 2026-07-28.
       *
       * Un champ `screen` a d'abord ete ajoute ici pour separer les deux. Il a ete RETIRE apres mesure:
       * la validation de `counterparty` en tete de ce handler supprime le seul cas ou les deux valeurs
       * divergeaient, donc le champ s'accordait desormais toujours avec `available` — un signal a variance
       * nulle, qui n'observe pas, il affirme. L'invariant est porte par un cas de test (« aucun verdict
       * n'est compose pour une entree que le crible ne peut pas juger »), qui rougit s'il casse au lieu de
       * rester vert en decorant. */
      local: { blocked: localScreen.blocked, available: meta.available, asOf: meta.asOf, ageDays: meta.ageDays, stale: meta.stale, reason: localScreen.reason,
        floorFingerprint: floorProvenance(KNOWN_BAD).fingerprint,   // which floor this verdict judged on — compare across nodes to prove same basis
        disclosure: 'LOCAL — screened by THIS node against public known-bad lists (no network). A BLOCK here is decisive and overrides any oracle answer. The floorFingerprint identifies WHICH floor this is: another node with the same fingerprint shares the same objective judgment basis (till_floor), proven without trusting either node.' },
      oracle,
      note: 'Two lenses, SEPARATE and never merged into one score: LOCAL (verified here, decisive on a BLOCK) vs ORACLE (MainStreet, ORACLE-REPORTED, advisory). Averaging them would launder the oracle\'s word into local proof.',
    };
    // vertex 2 — STANDING (LAWBOR proven paid history), optional. HARDENED like the reputation oracle:
    // it is a SECOND service BIII does not control, so it is labeled ORACLE-REPORTED and shipped WITH its
    // EVIDENCE — the txHashes behind the number — so the reader RE-VERIFIES on Base instead of trusting a
    // node's bare figure. Use /why (number + evidence) not /credit (number alone). Fail-closed on absence.
    /* TROIS ISSUES, JAMAIS DEUX — corrige le 2026-07-27.
     * Avant, `standing` restait `null` que la variable soit absente OU que le noeud ait echoue, et
     * `standingVertex(null)` rendait « no proven history yet »: une AFFIRMATION sur la contrepartie alors
     * qu'aucun appel n'avait ete fait. Le `catch {}` vide rendait meme une panne indiscernable d'une
     * absence de configuration. On distingue desormais, et chaque cas porte SA raison. */
    let standing = null;        // the decision fed to assessTriangle: { paidMicro } | { unqueried, reason }
    let standingLens = null;    // the auditable display lens (re-verifiable, never merged into reputation)
    if (!process.env.BIII_LAWBOR_URL) {
      standing = { unqueried: true,
        reason: 'BIII_LAWBOR_URL is not set, so the LAWBOR node was never asked. This vertex is missing on '
          + 'OUR side and says nothing about the counterparty.' };
    } else {
      try {
        const r = await fetch(`${process.env.BIII_LAWBOR_URL.replace(/\/$/, '')}/why?of=${encodeURIComponent(cp)}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) {
          standing = { unqueried: true, reason: 'the LAWBOR node answered HTTP ' + r.status + ' — unread, not empty' };
        }
        if (r.ok) {
          const j = await r.json();
          /* DERIVE DE FORMAT != ZERO. `String(j.directMicro || '0')` rendait '0' quand le champ etait
           * ABSENT, et ce '0' descendait ensuite dans le verdict comme s'il avait ete mesure. Un noeud
           * d'une autre version, ou une reponse d'erreur en 200, devenait ainsi « aucun historique
           * prouve » — une affirmation sur la contrepartie tiree d'une incomprehension de la reponse. */
          if (j == null || j.directMicro == null) {
            standing = { unqueried: true,
              reason: 'the LAWBOR node answered 200 but without a directMicro field — a shape we do not '
                + 'understand is unread, never zero' };
          } else {
            const directMicro = String(j.directMicro);
            /* La borne du noeud voyage avec le chiffre: sans elle, un zero de demarrage a froid serait lu
             * comme une mesure. Voir standingVertex/standingCeiling dans lib/trust.js. */
            standing = { paidMicro: directMicro, bound: j.bound || null };
            standingLens = {
              paidUsdc: T.microToUsd(directMicro), directMicro, node: process.env.BIII_LAWBOR_URL,
              evidence: (Array.isArray(j.direct) ? j.direct : []).slice(0, 20).map((e) => ({ txHash: e.txHash, jobId: e.jobId, amountMicro: e.amountMicro, reVerify: 'https://basescan.org/tx/' + e.txHash })),
              bound: j.bound || null,
              disclosure: 'ORACLE-REPORTED by the LAWBOR node (BIII does not control it) — its viewer-relative view. RE-VERIFY each txHash on Base: a number without its evidence is not proof. Never merged into reputation.',
            };
          }
        }
      } catch (e) {
        /* Un catch VIDE transformait une panne reseau en « aucun historique ». La raison est desormais
         * portee jusqu'au verdict: le lecteur voit qu'on n'a pas pu lire, pas qu'il n'y avait rien. */
        standing = { unqueried: true,
          reason: 'the LAWBOR node could not be reached (' + (e && e.name ? e.name : 'error') + ') — unread, not empty' };
      }
    }
    /* vertex 3 — settlement.
     *
     * BIII ne sait temoigner QU'UN rail: l'USDC sur Base, qu'il lit directement. Tout autre rail — carte,
     * virement, une jambe Mastercard Agent Pay reglee vers un compte bancaire — n'apparaitra JAMAIS
     * on-chain. Avant, ces cas tombaient dans `settlement: null` -> `pending` (« rien vu pour l'instant »),
     * ce qui promet une arrivee qui ne viendra pas, et comptait comme sommet LU: le triangle se declarait
     * complet alors qu'un rail entier lui echappait.
     *
     * FAIL-CLOSED SUR LE NOM DU RAIL: seuls les rails qu'on sait lire prennent le chemin on-chain. Un
     * 'bse' mal tape, un rail inconnu, un nom qu'on n'a jamais vu — tout ca vaut « non temoignable »,
     * jamais « on-chain ». Se tromper dans ce sens fait dire « je ne peux pas voir »; dans l'autre, ca
     * ferait chercher sur Base un paiement qui n'y sera pas et conclure a un echec. */
    const { named: railNamed, rail, witnessable } = T.railOf(a.rail);
    let settlement = null;
    if (railNamed && !witnessable) {
      settlement = { offChain: true, rail };
    } else if (a.amountMicro) {
      /* UNE PANNE RPC EST UN SOMMET NON LU, PAS LA FIN DU TRIANGLE. lib/chain.js jette sur !r.ok; cet
       * appel etait le seul des trois sans try/catch — l'oracle en a un, le standing aussi. Un RPC
       * injoignable remontait donc jusqu'au handler, qui repondait -32000 « check arguments » et jetait la
       * reputation et le standing DEJA calcules, en envoyant l'appelant deboguer des arguments qui n'y
       * etaient pour rien. Le module savait se degrader par sommet; le handler ne lui en laissait pas
       * l'occasion. Mesure du 2026-07-28: avec BASE_RPC_URL mort, till_trust JETAIT. */
      try {
        const fact = await findPayment({ to: cp, minMicro: String(a.amountMicro), lookbackBlocks: 900 });
        settlement = T.verifyPayment({ to: cp, amountMicro: String(a.amountMicro), token: T.USDC_BASE, chainId: 8453 }, fact);
      } catch (e) {
        /* `unqueried` et pas `pending`: « je n'ai pas pu regarder » n'est pas « rien vu pour l'instant ».
         * La branche lectrice a ete ajoutee A settlementVertex EN PREMIER — sans elle cette forme tombait
         * dans le return final et sortait `failed`, c'est-a-dire une panne RPC AFFIRMANT que le paiement a
         * echoue. Pire que pending, qui promet au moins une arrivee. */
        settlement = { unqueried: true,
          reason: 'the Base RPC could not be read (' + (e && e.name ? e.name : 'error') + ') — this vertex '
            + 'is unread on OUR side. It is NOT "no payment found", and it is NOT pending.' };
      }
    }
    // LOCAL CLASSIFIER lens — MainStreet's judgment reproduced on THIS node via trust-core (pure, no oracle).
    // A SEPARATE lens, never merged into the triangle's reputation input: a green-unverified PROCEED_LOW_VALUE
    // fed there would read as false 'trusted'. It proves the safe-to-pay verdict is computed here and holds
    // when the oracle is down; on a known-bad address it BLOCKs identically to (and independently of) the floor.
    const localClassifier = localClassify(cp, { resourceUrl: a.resourceUrl });
    // ERC-8004 lens — INTEROP with the dominant agent-reputation standard, surfaced only when the caller
    // opts in (agentId or a getSummary result). It is a SEPARATE, ADVISORY, re-verifiable signal: feedback
    // is client-submitted (sybil-farmable), so it never enters the triangle's payable decision — it informs,
    // and always points to re-verify getSummary on Base. Absent opt-in ⇒ omitted (absence is never trust).
    const erc8004 = (a.agentId != null || a.erc8004Summary)
      ? erc8004Lens(a.erc8004Summary, { agentId: a.agentId, trustedClientsOnly: !!a.erc8004TrustedClients })
      : null;
    return { triangle: assessTriangle({ reputation, standing, settlement }),
      sources: { reputation: reputationLenses, localClassifier, standing: standingLens, ...(erc8004 ? { erc8004 } : {}), settlementChecked: !!a.amountMicro },
      disclosure: meta.disclosure };
  }
  if (name === 'till_create_invoice') {
    const invoice = I.createInvoice({ to: a.to, lineItems: a.lineItems, number: a.number, billTo: a.billTo,
      merchantName: a.merchantName, dueDateMs: a.dueDateMs, rail: a.rail, issueDateMs: Date.now(), nowMs: Date.now() });
    return { invoice, bill: I.renderInvoice(invoice, { lang: a.lang || 'en' }), paymentURI: I.invoiceURI(invoice),
      note: 'Same registry as the till: the payer\'s OWN wallet executes the EIP-681; only the chain says "settled". Then till_check_invoice.' };
  }
  if (name === 'till_check_invoice') {
    /* ⚠️ CE HANDLER RECONSTRUIT LA FACTURE DE ZERO a partir de ses arguments — il ne recoit jamais
     * l'objet emis par till_create_invoice. Tout champ non repris ici est donc INVISIBLE pour le
     * verdict, quoi qu'ait pose le createur.
     *
     * `rail` manquait aux DEUX bouts: till_create_invoice ne le transmettait pas a createInvoice, et
     * cette reconstruction ne le portait pas. `not_observable` etait donc totalement inatteignable par
     * la surface MCP — le correctif de lib/invoice.js ne servait qu'a un appelant qui importe le module
     * en direct. Troisieme fois dans la journee que le lecteur precede l'ecrivain; ici la chaine etait
     * rompue en deux points a la fois. */
    /* ⚠️ LE MÊME TROU QUE `till_check_payment`, trouvé en allant voir le voisin JUSTE APRÈS l'avoir
     * bouché — `to` et `totalMicro` partaient non validés jusqu'à `findPayment`, et l'exception
     * ressortait en `-32000 « check arguments »`. Sur l'outil qui dit si une FACTURE est payée, accuser
     * l'appelant d'une panne amont est la même faute, avec un montant en jeu. */
    const gi = exigeAdresse(a.to, 'to'); if (gi.error) return gi;
    if (!/^\d+$/.test(String(a.totalMicro || ''))) {
      return { error: 'REJECTED INPUT: `totalMicro` is ' + (a.totalMicro == null ? 'missing' : JSON.stringify(String(a.totalMicro)).slice(0, 24))
        + ' — it must be an integer number of USDC micro-units (6 decimals, e.g. "1500000" for $1.50). '
        + 'NOTHING WAS CHECKED ON CHAIN — this is not a verdict that the invoice is unpaid.' };
    }
    const invoice = { kind: 'biii-invoice', number: a.number || null, dueDateMs: a.dueDateMs || null,
      rail: T.railOf(a.rail).rail,
      merchant: { name: a.merchantName || null, address: String(a.to || '').toLowerCase() },
      charge: { to: String(a.to || '').toLowerCase(), amountMicro: String(a.totalMicro || ''), amountUsd: T.microToUsd(String(a.totalMicro || '0')), token: T.USDC_BASE, chainId: 8453 },
      lineItems: [], totalMicro: String(a.totalMicro || ''), totalUsd: T.microToUsd(String(a.totalMicro || '0')) };

    /* LE RAIL SE LIT AVANT LA CHAINE. Interroger Base pour une facture reglee par carte coute un appel
     * RPC qui ne peut rien apprendre — et surtout, une panne de ce RPC faisait echouer TOUT l'outil,
     * alors que la reponse (`not_observable`) n'a besoin d'aucune lecture. Constate a l'ecriture de ce
     * chemin: `rpc eth_getLogs HTTP 413` sur la fenetre de 43 200 blocs, et le tool rendait une erreur
     * generique pour une facture dont le verdict etait connu d'avance.
     *
     * C'est aussi le cas d'usage le plus concret du produit: un commercant hors ligne, une facture
     * reglee en especes. Il ne doit dependre d'aucun noeud. */
    const railInv = T.railOf(invoice.rail);
    if (railInv.named && !railInv.witnessable) {
      const status = I.invoiceStatus(invoice, null, Date.now());
      return { status, verdict: null, fact: null, receipt: null,
        note: 'No chain read was attempted: this invoice settles on a rail BIII cannot witness, so the '
          + 'answer does not depend on Base being reachable. Its payment state lives in the merchant\'s books.' };
    }

    const fact = await findPayment({ to: invoice.charge.to, minMicro: invoice.charge.amountMicro, lookbackBlocks: a.lookbackBlocks || 43200 });
    const verdict = I.verifyInvoice(invoice, fact);
    const status = I.invoiceStatus(invoice, verdict, Date.now());
    return { status, verdict, fact: fact || null,
      receipt: verdict.paid === true ? I.invoiceReceipt(invoice, verdict, { merchantName: a.merchantName }) : null };
  }
  if (name === 'till_vet_asset') {
    // registryComplete travels WITH the registry: without it the verdict would keep asserting that a
    // contract absent from a knowingly-truncated file is an impersonator.
    const verdict = assessAsset({ token: a.token, claimedIssuer: a.claimedIssuer, claimedSymbol: a.claimedSymbol },
      RWA_REGISTRY ? { registry: RWA_REGISTRY, registryComplete: RWA_COMPLETE } : { registryComplete: RWA_COMPLETE });
    return { verdict, triangleReputation: assetVertex(verdict),
      registrySource: RWA_REGISTRY ? `${RWA_SOURCE} (${RWA_REGISTRY.length} contracts)` : 'seed only (run `node scripts/biii-rwa-registry.js` — free Coingecko source, no key needed)',
      registryComplete: RWA_COMPLETE,
      ...(RWA_COMPLETE === true ? {} : { registryCaveat: RWA_COMPLETE === false
        ? 'the registry file records its own ingest as INCOMPLETE — rows are missing, so an absent contract is not an absent asset'
        : 'the registry does not state whether its ingest completed, so completeness is UNKNOWN — absence proves nothing' }),
      note: 'ADVISORY. genuine = the contract matches a verified issuer address; impersonation/unknown fail closed.' };
  }
  if (name === 'till_vet_meme') {
    /* `Number(a.chainId)` transformait 'base' en NaN — donc en « pas de filtre » — et 8453 en une valeur
     * qui ne correspondait a aucun slug DexScreener, donc en « tout ecarter ». On passe la valeur TELLE
     * QUELLE; lib/meme.js accepte le slug comme l'identifiant numerique et refuse ce qu'il ne sait pas
     * traduire. Voir l'en-tete de candidatesFrom pour la mesure en production. */
    const result = await vetMeme({ symbol: a.symbol, chainId: a.chainId, address: a.address });
    return { ...result, note: 'ADVISORY. genuine = one contract dominates liquidity (>3x runner-up); ambiguous = top-2 tied (never certified); re-verify on DexScreener/Basescan.' };
  }
  if (name === 'till_rug_powers') {
    const g = exigeAdresse(a.address); if (g.error) return g;
    const v = await scanRugOne(a.chain || 'base', a.address);
    return { ...v, note: 'ADVISORY, fail-closed. "clean" means no rug power was found that anyone can still fire — NOT a promise the price holds or the team is honest. Owner-gated dangers are scored only while an owner exists; missing data reads as unknown, never clean.' };
  }
  if (name === 'till_launch_funder') {
    const g = exigeAdresse(a.address); if (g.error) return g;
    const f = await traceFeeder(a.chain || 'base', a.address);
    if (!f || !f.ok) return { error: (f && f.reason) || 'could not trace the funding of this launch' };
    return f;
  }
  if (name === 'till_b20_authentic') {
    return await classifyB20(a.chain || 'base', a.address);
  }
  if (name === 'till_trace_theft') {
    const chain = a.chain || 'base';
    if (a.mode === 'moved') {
      if (!a.txHash) return { error: 'txHash is required for mode "moved"' };
      const m = await whatMoved(chain, a.txHash);
      // `ok: false` voyage aussi, pour que les trois modes echouent de la MEME facon — la moitie du
      // defaut etait que chaque mode se lisait differemment, pas seulement que l'un d'eux se taisait.
      if (!m.ok) return { ok: false, reason: m.reason, error: m.reason };
      return { ...m, note: m.forgedTransfers ? m.forgedTransfers + ' transfer event(s) name a sender who did not sign this transaction — those are forged logs, do not follow them.' : 'All transfer events match the transaction signer.' };
    }
    if (a.mode === 'bridge') {
      if (!a.txHash) return { error: 'txHash is required for mode "bridge"' };
      /* ⚠️ UN TOOL, TROIS MODES, DEUX CONVENTIONS D'ECHEC.
       *
       * Ce handler signale l'echec par `{ error }` — quinze fois dans ce fichier, y compris trois lignes
       * plus haut pour le mode `moved`. Mais `readBridgeExit` rend `{ ok: false, reason }` et cette ligne
       * le repassait tel quel. Un agent qui suit la convention du tool teste `.error`, n'en trouve pas, et
       * lit un echec comme une reponse — puis cherche `destinationChains` dans un objet qui n'en a pas.
       *
       * Le correctif etait alle sur `moved` et pas sur son jumeau: c'est le motif de divergence entre
       * routes soeurs, ici a l'interieur d'un SEUL handler.
       *
       * Purement ADDITIF: `ok` et `reason` restent, `error` s'ajoute. Un consommateur qui lit deja `ok`
       * n'est pas casse, et celui qui suit la convention documentee cesse de rater l'echec. (`followTron`
       * plus bas ne rend jamais `ok: false` — il porte son arret dans le resultat — donc il ne partage
       * pas ce defaut, verifie plutot que suppose.) */
      const b = await readBridgeExit(chain, a.txHash);
      return b && b.ok ? b : { ...b, error: (b && b.reason) || 'the bridge read did not answer' };
    }
    if (a.mode === 'tron') {
      if (!a.address) return { error: 'address is required for mode "tron"' };
      return await followTron(a.address, { maxHops: a.maxHops || 3 });
    }
    return { error: 'mode must be one of: moved, bridge, tron' };
  }
  if (name === 'till_seed_exposure') {
    const paths = Array.isArray(a.paths) && a.paths.length ? a.paths : SEED.defaultPaths();
    return SEED.scanPaths(paths, SEED.loadWordlist());
  }
  if (name === 'till_verify_delivery') {
    /* Un horodatage donne et illisible fait REFUSER, il ne se degrade pas en « pas fourni ». Le verdict
     * qui en sortirait serait `served` la ou `commitment_too_late` etait du — une reponse fausse dans le
     * sens qui coute de l'argent. Mieux vaut redemander: la comparaison de hash est bon marche. */
    const tPaid = instantMs(a.paidAt), tComm = instantMs(a.committedAt);
    const illisibles = [tPaid.fourni && tPaid.ms == null ? 'paidAt' : null,
      tComm.fourni && tComm.ms == null ? 'committedAt' : null].filter(Boolean);
    if (illisibles.length) {
      return { error: illisibles.join(' and ') + ' was supplied but could not be read as a time. Send '
        + 'milliseconds since epoch (1751328000000) or an ISO-8601 instant (2026-07-01T00:00:00Z). '
        + 'REFUSED rather than judged: with the ordering lost, a late commitment would come back as '
        + '"served", which is the exact trick this tool exists to catch.',
        got: { paidAt: a.paidAt ?? null, committedAt: a.committedAt ?? null } };
    }
    // Either the artifact or its digest — the digest is the better habit, and on a hosted server the only
    // defensible one: nothing here should hold someone's deliverable in order to compare a hash.
    return DELIV.assessDelivery({
      commitment: a.commitmentHash ? { deliverableHash: String(a.commitmentHash).toLowerCase() } : null,
      received: a.received,
      receivedHash: a.receivedHash,
      paidAt: tPaid.ms,
      committedAt: tComm.ms,
    });
  }
  if (name === 'till_funder_history') {
    // No address is not an error and must not read like one — but the old comment quoted 45% as a property
    // of launches, when 96% of that population was never traced at all — our per-run cap, not the chain.
    // `lookup(null)` now says the gap is in our coverage, not in the launch.
    return FUNDER.lookup(a.funder ? String(a.funder) : null);
  }
  if (name === 'till_key_exposure') {
    const paths = Array.isArray(a.paths) && a.paths.length ? a.paths : SEED.defaultPaths();
    return KEYS.scanKeyPaths(paths);
  }
  if (name === 'till_vet_agent') {
    return await vetAgent({ url: a.url, payTo: a.payTo, chain: a.chain || 'base',
      knownBadScreen: KNOWN_BAD, screenFn: screenAddress });
  }
  if (name === 'till_watch_wallet') {
    const r = await watchWallet(a.chain || 'base', a.owner, { persist: a.persist !== false });
    return r.ok ? r : { error: r.reason };
  }
  if (name === 'till_open_approvals') {
    const r = await checkApprovals(a.chain || 'base', a.owner, a.fromBlock ? { fromBlock: a.fromBlock } : {});
    return r.ok ? r : { error: r.reason };
  }
  if (name === 'till_vet_approach') {
    return vetApproach({ links: a.links, platform: a.platform, asksToInstall: a.asksToInstall,
      asksForKeyOrSeed: a.asksForKeyOrSeed, asksForSignature: a.asksForSignature,
      asksForUpfrontPayment: a.asksForUpfrontPayment, urgency: a.urgency });
  }
  if (name === 'till_recovery_offer') {
    return await assessRecoveryOffer({ address: a.address, chain: a.chain || 'base',
      asksForSignature: a.asksForSignature, asksForUpfrontPayment: a.asksForUpfrontPayment,
      asksForSeedOrKey: a.asksForSeedOrKey, asksToInstall: a.asksToInstall });
  }
  if (name === 'till_receipt') {
    /* ⚠️ TROISIÈME EXEMPLAIRE DU MÊME TROU (après till_check_payment 7c9520c et till_check_invoice
     * 946b9d7). `createCharge` lève sur un montant ou une adresse malformés, l'exception ressortait en
     * `-32000 « check arguments »`, et c'est ici l'outil qui DÉLIVRE UN REÇU : dire à quelqu'un que sa
     * demande est fautive alors que le nœud est tombé, sur la pièce qui atteste un paiement, est la
     * pire version de cette confusion.
     * Note de méthode: cet outil était le seul jamais mesuré, exclu par prudence de la sonde à entrée
     * vide au cas où il écrirait. Il ne mute RIEN — createCharge est un constructeur pur, findPayment
     * lit la chaîne, receipt formate. La lecture lève l'exclusion; la prudence n'était pas inutile,
     * elle était juste non résolue. */
    const gr = exigeAdresse(a.to, 'to'); if (gr.error) return gr;
    if (!(Number(a.amountUsd) > 0)) {
      return { error: 'REJECTED INPUT: `amountUsd` is ' + (a.amountUsd == null ? 'missing' : JSON.stringify(String(a.amountUsd)).slice(0, 24))
        + ' — it must be a positive number of dollars (e.g. 1.50). NOTHING WAS CHECKED ON CHAIN — this '
        + 'is not a statement that no payment exists, and no receipt was withheld on the evidence.' };
    }
    const charge = T.createCharge({ to: a.to, amountUsd: a.amountUsd, label: a.label, nowMs: Date.now() });
    const fact = await findPayment({ to: charge.to, minMicro: charge.amountMicro, lookbackBlocks: a.lookbackBlocks || 900 });
    const verdict = T.verifyPayment(charge, fact);
    if (!verdict.paid) return { error: 'no verified payment found — ' + verdict.reason };
    return { receipt: T.receipt(charge, verdict, { merchantName: a.merchantName }) };
  }
  if (name === 'till_roll') {
    // PROVABLE BOOKS, stateless: fold the caller's receipts into a roll (dedup by txHash) and render the
    // shareable statement. BIII does NOT re-verify for you — every line carries its txHash so YOU re-check
    // on Base. That is the whole point: trust no one, not even us.
    const receipts = (Array.isArray(a.receipts) ? a.receipts : []).filter((r) => r && r.txHash);
    let rows = [];
    for (const r of receipts) { const res = L.appendReceipt(rows, r); if (res.entry) rows = res.rows; }
    const s = L.summary(rows);
    return {
      statement: L.renderRoll(rows, { merchantName: a.merchantName || 'Merchant', lang: a.lang === 'fr' ? 'fr' : 'en', brand: a.brand }),
      // till_roll ne passe AUCUNE fenetre, donc undatedExcluded y vaut toujours 0 — il descend quand meme,
      // pour que les trois routes des livres aient la meme forme et qu'aucune ne redevienne l'exception.
      summary: { count: s.count, grossUsd: s.grossUsd, tipsUsd: s.tipsUsd, undatedExcluded: s.undatedExcluded },
      lines: rows.map((e) => ({ no: e.no, amountUsd: e.receipt.amountUsd, txHash: e.receipt.txHash, explorer: e.receipt.explorer || ('https://basescan.org/tx/' + e.receipt.txHash) })),
      note: 'Re-verify EVERY txHash on BaseScan yourself — this statement is only as true as the chain it points to. ' + DISCLAIMER,
    };
  }
  if (name === 'till_export') {
    // ACCOUNTING EXPORT, stateless: the same receipts the till roll uses → an accountant-ready CSV
    // (QuickBooks/Xero/Excel import it). Same non-custodial discipline: every row carries its txHash +
    // Basescan link so the accountant re-verifies on Base — a pointer to the chain, never a book to trust.
    const receipts = (Array.isArray(a.receipts) ? a.receipts : []).filter((r) => r && r.txHash);
    const window = {};
    if (Number.isFinite(a.fromBlockTime)) window.fromBlockTime = Number(a.fromBlockTime);
    if (Number.isFinite(a.toBlockTime)) window.toBlockTime = Number(a.toBlockTime);
    const ex = X.buildExport(receipts, { window, brand: a.brand });
    // La divulgation doit atteindre l'agent au bout du fil: `...ex` porte deja summary.undatedExcluded et
    // la phrase dans `disclosure`, mais `note` est ce qu'un appelant lit en premier — elle le dit aussi.
    const manque = ex.summary.undatedExcluded
      ? `⚠ ${ex.summary.undatedExcluded} receipt(s) had no on-chain block time and are NOT in this dated CSV. `
      : '';
    return { ...ex, note: manque + 'Import into QuickBooks / Xero / Excel; re-verify every tx_hash on BaseScan yourself. ' + DISCLAIMER };
  }
  if (name === 'till_meter') {
    // USAGE → BILL, stateless, split by trust: settled receipts are provable (on-chain), the verdict
    // count is self-reported (advisory reads aren't chain artifacts). The plan is injected by the partner.
    const receipts = (Array.isArray(a.receipts) ? a.receipts : []).filter((r) => r && r.txHash);
    const window = {};
    if (Number.isFinite(a.fromBlockTime)) window.fromBlockTime = Number(a.fromBlockTime);
    if (Number.isFinite(a.toBlockTime)) window.toBlockTime = Number(a.toBlockTime);
    const bill = meterUsage(receipts, { plan: a.plan, verdictCount: a.verdictCount, window });
    const manque = bill.provable.undatedExcluded
      ? `⚠ ${bill.provable.undatedExcluded} receipt(s) had no on-chain block time and are NOT billed in this dated period — this total is UNDER-charged. `
      : '';
    return { ...bill, note: manque + 'Re-verify the settled receipts on Base yourself; bill on the self-reported verdict count only with a trusted volume report. ' + DISCLAIMER };
  }
  if (name === 'till_floor') {
    // DECENTRALIZATION PROOF: expose this node's known-bad floor provenance + fingerprint so any other
    // node can prove they share the SAME objective floor (same fingerprint) — convergence on public data,
    // never on a central operator. Answers "is the judgment the same everywhere?" — for the floor, checkably yes.
    return { floor: floorProvenance(KNOWN_BAD),
      note: 'Compare this fingerprint with another node\'s till_floor: same fingerprint = same floor = same objective judgment basis, proven without trusting either node. ' + DISCLAIMER };
  }
  if (name === 'till_resolve') {
    // IDENTITY BRIDGE (agent glue): npub (buzz) AND/OR did:key (gitlawb) ↔ Base, trustless + fail-closed.
    // Resolve an agent's Nostr and/or gitlawb identity to a payable Base address ONLY on a proven
    // bidirectional attestation (each identity key + the Base key sign) — then the caller runs till_trust on
    // the address (resolving is not trusting). BIII does not verify secp256k1/Ed25519 itself.
    const binding = bindingLens(a, { now: Date.now() });
    return { binding,
      note: binding.bound
        ? 'Bound. Now assess this address with till_trust / till_vet_merchant — a resolved address is not a safe one. ' + DISCLAIMER
        : 'NOT bound (' + binding.reason + '). Do not resolve payment to it. ' + DISCLAIMER };
  }
  if (name === 'till_kya') {
    // IDENTITY STANDARD (interop, never rival): read a Skyfire KYA JWT as a SEPARATE, advisory identity
    // lens — attested only when the caller confirms the signature + the aud matches (anti-replay). BIII
    // does not verify JWT signatures itself. Attesting who backs an agent is NOT safe-to-pay (run the triangle).
    const kya = kyaLens(a.token, { verified: !!a.verified, expectedAudience: a.expectedAudience, requireExpiry: !!a.requireExpiry, now: Date.now() });
    const weak = kya.attested && kya.posture && (!kya.posture.expires || !kya.posture.audienceBound);
    return { kya,
      note: kya.attested
        ? 'KYA-attested identity' + (weak ? ' (⚠ weak posture: ' + [kya.posture.expires ? null : 'never expires', kya.posture.audienceBound ? null : 'not replay-bound'].filter(Boolean).join(' + ') + ')' : '') + '. This is WHO backs the agent, not that its address is safe to pay — run till_trust on the address. ' + DISCLAIMER
        : 'NOT attested (' + kya.reason + '). Treat as an unverified claim. ' + DISCLAIMER };
  }
  if (name === 'till_authorize') {
    // SPEND AUTHORIZATION: a charge only becomes an executable EIP-681 intent if it is within what the
    // agent's owner signed off (token/recipient/per-charge/cumulative). Fail-closed + drain-safe: no
    // payment intent is issued for an unauthorized charge. BIII does not verify the JWT signature itself.
    let charge;
    try { charge = T.createCharge({ to: a.to, amountUsd: a.amountUsd, amountMicro: a.amountMicro, label: a.label, nowMs: Date.now() }); }
    catch (e) { return { authorized: false, error: e.message }; }
    const authorization = authorizeCharge(a.spendAuth, charge, { spentMicro: a.spentMicro, verified: !!a.verified });
    return { charge: { to: charge.to, amountUsd: charge.amountUsd, amountMicro: charge.amountMicro, token: charge.token, chainId: charge.chainId },
      authorization,
      paymentURI: authorization.authorized ? T.paymentURI(charge) : null,   // NO intent for an unauthorized charge
      note: authorization.authorized
        ? 'Authorized — execute this EIP-681 with the agent wallet (BIII holds no key). ' + DISCLAIMER
        : 'REFUSED (' + authorization.reason + '). No payment intent issued. ' + DISCLAIMER };
  }
  throw new Error('unknown tool ' + name);
}

// ── shared JSON-RPC dispatch (used by BOTH the stdio loop AND the hosted /mcp HTTP endpoint) ──
// Returns the response object, or null for a notification / non-object (nothing to send back).
async function handleRpc(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  const { id, method, params } = m;
  /* JSON-RPC distinguishes THREE states here, and `id == null` flattened the first two into one:
   *   no `id` member at all -> a NOTIFICATION. Never answer it.
   *   `id: null`            -> a request. Discouraged by the spec, but legal, and it wants an answer.
   *   a real id             -> a request.
   * Measured 2026-08-06 under the old test: `{jsonrpc,id:null,method:'tools/list'}` was answered (the
   * tools/list branch returned before the check) while `{jsonrpc,id:null,method:'nope'}` was silently
   * dropped — the same caller treated as a request or as a notification depending on which branch it hit. */
  const isNotification = !('id' in m);
  const reply = (body) => (isNotification ? null : { jsonrpc: '2.0', id, ...body });
  try {
    if (method === 'initialize') return reply({ result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'biii', version: '0.1.0' } } });
    if (method === 'tools/list') return reply({ result: { tools: TOOLS } });
    // `ping` is a spec-required utility that MUST answer with an empty result. It used to work only by
    // falling through to the catch-all below; now that unknown methods are refused, it is handled ON
    // PURPOSE. Measured before the change: nothing in this repo implemented it.
    if (method === 'ping') return reply({ result: {} });
    if (method === 'tools/call') {
      /* VALIDATE THE ENVELOPE BEFORE CLAIMING ANYTHING ABOUT A TOOL — the previous fix left this hole.
       * Measured 2026-08-06: `{method:'tools/call'}` with NO params made `params.name` throw a TypeError,
       * which does not match /^unknown tool /, so it fell to the generic branch and answered
       *   -32000  tool "undefined" failed — it exists and was reached
       * No name was supplied, so nothing existed and nothing was reached. The branch written to STOP a
       * false attribution was itself making one. -32602 is the spec's code for exactly this. */
      /* NOTE — a mutation SURVIVES on this line, diagnosed 2026-08-06, do not "fill the hole": replacing it
       * with `params || null` changes no outcome, because a primitive's `.name` and an array's `.name` are
       * both undefined and the string check below then refuses all the same. It is defence in depth, not a
       * load-bearing guard. Left in for the reader; the refusal is enforced one line down. */
      const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : null;
      const name = p && p.name;
      if (typeof name !== 'string' || name === '') {
        return reply({ error: { code: -32602, message:
          'tools/call needs a params.name string naming the tool. None was supplied, so no tool was looked '
          + 'up — this says nothing about whether any tool exists. Call tools/list for the current set.' } });
      }
      const args = (p.arguments && typeof p.arguments === 'object') ? p.arguments : {};
      const out = await callTool(name, args);
      return reply({ result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
    }
    if (isNotification) return null;                       // notifications/initialized etc. — no reply
    /* AN UNIMPLEMENTED METHOD IS NOT AN EMPTY ONE. This returned `result: {}` — a SUCCESS. Measured
     * 2026-08-06: `prompts/list`, `resources/list` and `wharrgarbl` were all answered
     * `{"jsonrpc":"2.0","id":N,"result":{}}`, so a client asking what prompts this server offers was told
     * "none" when the truth is that prompts were never implemented. An absence became an affirmation, and
     * a conformance probe reading it would record a malformed success instead of a clean refusal.
     * This is the same distinction the unknown-TOOL branch below already draws, one branch away. */
    return reply({ error: { code: -32601, message:
      `method "${method}" is not implemented on this server — it is not empty, it is absent. `
      + `This server implements initialize, tools/list, tools/call and ping.` } });
  } catch (e) {
    try { console.error('[biii-mcp]', method, '·', (e && (e.stack || e.message)) || e); } catch { /* log must not throw */ }
    if (isNotification) return null;

    /* AN UNKNOWN TOOL IS NOT A FAILED ONE — measured by a third party before it was fixed.
     *
     * On 2026-07-27 the usage counter showed a call to `__verifymcp_auth_probe_<hex>__`: an external
     * conformance probe asking what this server does with a tool name that does not exist. We answered
     * `-32000  tool "…" failed — check arguments`, sending the caller to debug parameters for a name that
     * was never implemented. The information was already there — callTool throws `unknown tool <name>` —
     * and the generic catch was overwriting it.
     *
     * The two cases need different codes because they need different actions from the caller:
     *   unknown tool  -> -32601 Method not found. Re-read tools/list; nothing about the arguments matters.
     *   tool threw    -> -32000. The tool exists; the call did not work.
     *
     * Naming the unknown tool leaks nothing: `tools/list` is public and unauthenticated by design. The
     * CWE-209 concern is about internal detail (stack traces, paths, upstream errors), and that stays in
     * the server log — which is why the failed-tool branch keeps its deliberately uninformative message. */
    const unknownTool = method === 'tools/call' && /^unknown tool /.test(String(e && e.message));
    if (unknownTool) {
      return { jsonrpc: '2.0', id, error: { code: -32601,
        message: `unknown tool "${params && params.name}" — it does not exist on this server; call tools/list for the current set` } };
    }
    /* ⚠️ « CHECK ARGUMENTS » N'EST PAS VAGUE, C'EST UNE ATTRIBUTION — et elle était fausse la moitié du
     * temps. CWE-209 demande de ne pas divulguer le DÉTAIL interne (traces, chemins, erreur amont) ; il
     * ne demande pas de désigner un coupable. Mesuré le 2026-07-30, arguments VALIDES et BASE_RPC_URL
     * mort :
     *
     *   TypeError: fetch failed  ->  «tool "till_check_payment" failed — check arguments»
     *
     * Sur l'outil qui répond « ai-je été payé ? », un marchand dont le nœud est tombé s'entend donc dire
     * que ses données de paiement sont fausses. Les deux causes appellent des actions OPPOSÉES : une
     * erreur d'entrée se corrige en changeant la requête, une panne amont se corrige en réessayant plus
     * tard. Ce fichier avait déjà corrigé exactement ça pour `till_trust` (28/07) — mais outil par outil,
     * avec un try/catch local. Le catch générique continuait d'attribuer pour tous les autres.
     * On ne nomme donc plus de cause : on dit que l'appel n'a pas abouti, et que les deux hypothèses
     * restent ouvertes. Aucune information nouvelle ne sort ; une fausse accusation disparaît. */
    const msg = method === 'tools/call'
      // « failed » RESTE: c'est la categorie stable qu'un client peut router (et un test l'epingle a
      // juste titre). Ce n'est pas une attribution — l'appel a bel et bien echoue. C'est « check
      // arguments » qui designait un coupable, et c'est cela seul qui part.
      ? `tool "${params && params.name}" failed — it exists and was reached. The cause may be `
        + `the arguments OR an upstream/network failure on our side; the detail is in the server log, not `
        + `in this reply. Retry once before changing the request.`
      : 'request failed';
    return { jsonrpc: '2.0', id, error: { code: -32000, message: msg } };
  }
}

// stdio transport — ONLY when run directly (require.main), so requiring this module (for /mcp) is side-effect-free.
if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const resp = await handleRpc(m);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  });
}

module.exports = { callTool, TOOLS, localClassify, handleRpc, fetchReputation };
