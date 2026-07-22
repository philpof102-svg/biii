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
const L = require('../lib/ledger');
const X = require('../lib/export');
const { meterUsage } = require('../lib/meter');
const { erc8004Lens } = require('../lib/erc8004');
const { bindingLens } = require('../lib/identity');
const { kyaLens, authorizeCharge } = require('../lib/skyfire');
const { DISCLAIMER } = require('../lib/disclaimer');
const { loadScreen, screenAddress, screenMeta, floorProvenance } = require('../lib/screen');
const fs = require('node:fs'), path = require('node:path');

// trust-core — MainStreet's JUDGMENT extracted PURE (same classifier, zero DB/network). BIII runs it
// LOCALLY so the "safe to pay" verdict is computed on THIS node, not fetched from the hosted oracle.
// Resilient resolve: the published package name, else the local sibling repo; if neither is present TC
// stays null and localClassify() returns null — the existing screen-based BLOCK path is independent and
// still fires, so safety NEVER depends on trust-core being installed.
let TC = null;
try { TC = require('trust-core'); } catch { try { TC = require('../../trust-core'); } catch { TC = null; } }

// Authoritative verified-issuer registry, if it's been ingested (scripts/biii-rwa-registry.js → RWA.xyz).
// Absent → assessAsset falls back to its small SEED. A stale/missing file can only UNDER-verify (safe).
let RWA_REGISTRY = null, RWA_SOURCE = null;
try { const p = path.join(__dirname, '..', 'data', 'rwa-registry.json'); if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); RWA_REGISTRY = j.entries; RWA_SOURCE = j.generatedFrom || 'file'; } } catch {}

// DECENTRALIZED known-bad floor: a LOCAL, public, open-licensed list (data/known-bad.json). The node
// screens against it with zero network, so a known-bad address BLOCKs even when the MainStreet oracle is
// down — removing the single point of failure. Absent file ⇒ available:false ⇒ screening is UNAVAILABLE
// (never a silent "clean"), which the verdict discloses.
let KNOWN_BAD = loadScreen(null);
try { const p = path.join(__dirname, '..', 'data', 'known-bad.json'); if (fs.existsSync(p)) KNOWN_BAD = loadScreen(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch {}

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
async function fetchReputation(address) {
  const local = screenAddress(address, KNOWN_BAD);
  if (local.blocked) return { decision: 'BLOCK', score: null, source: 'local-known-bad', reason: local.reason };
  const o = await fetchOracle(address);
  if (o.decision != null || o.score != null) return { decision: o.decision, score: o.score, source: 'mainstreet-oracle' };
  return null;   // not-locally-known-bad + oracle down ⇒ no live signal. Honest 'unknown', never 'clean'.
}

// localClassify — MainStreet's judgment run on THIS node via trust-core (pure, no oracle). The known-bad
// screen supplies the fail-closed DENY lens; the endpoint URL (if known) supplies the phishing/http/admin
// URL lens — a genuinely NEW local capability (BIII can flag a hostile endpoint even for an address on no
// list). No behavioral score is available locally (that needs the indexer), so a clean read is capped at
// PROCEED_LOW_VALUE, never a confident PROCEED. This is the decentralization payoff: the verdict is computed
// here and holds when the oracle is down. It is surfaced as its OWN lens — never folded into the triangle's
// reputation input, because a green-unverified PROCEED_LOW_VALUE there would read as false 'trusted'.
function localClassify(address, { resourceUrl } = {}) {
  if (!TC) return null;
  const scr = screenAddress(address, KNOWN_BAD);
  const meta = screenMeta(KNOWN_BAD);
  const deny = { available: meta.available, asOf: meta.asOf, entry: scr.blocked ? { reason: scr.reason, severity: 'high' } : null };
  const signals = { deny };
  if (resourceUrl) signals.bazaar = { resourcePath: String(resourceUrl) };
  // BIII's own screen + its own knowledge of the endpoint = a locally-trusted signal bag (trustedSignals).
  const v = TC.verdict(signals, null, { trustedSignals: true });
  return { decision: v.decision, allowed: v.allowed, color: v.shield.color, reasonShort: v.shield.reasonShort,
    flags: v.shield.flags, explainer: v.shield.explainer,
    disclosure: 'LOCAL CLASSIFIER — MainStreet\'s judgment reproduced on THIS node via trust-core (pure, zero-oracle). Known-bad screen + endpoint-URL lens only; no behavioral score locally ⇒ a clean read is PROCEED_LOW_VALUE (low-value only), never a confident PROCEED. Holds even when the oracle is down.' };
}

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
      dueDateMs: { type: 'number' }, lang: { type: 'string', description: '"en" (default) or "fr"' } }, required: ['to', 'lineItems'] } },
  { name: 'till_check_invoice', description: 'Check an invoice against the chain: settled (paid on-chain, field-for-field) / overdue / issued. If settled, returns the receipt for the registry.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, totalMicro: { type: 'string', description: 'the invoice totalMicro' },
      number: { type: 'string' }, dueDateMs: { type: 'number' }, merchantName: { type: 'string' },
      lookbackBlocks: { type: 'number', description: 'default 43200 (~1 day on Base); invoices are slower than tills' } }, required: ['to', 'totalMicro'] } },
  { name: 'till_vet_asset', description: 'Is a TOKENIZED ASSET (stock/treasury/RWA) contract the GENUINE issuer\'s, or an impersonator? genuine / impersonation / unsafe / unknown — fail-closed (unknown is never genuine). Catches the FBI-flagged lookalike-token fraud. Registry is authoritative: seed only; source real addresses from issuer official docs.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string', description: '0x contract address of the token' },
      claimedIssuer: { type: 'string', description: 'what it claims to be, e.g. "BlackRock"' },
      claimedSymbol: { type: 'string', description: 'e.g. "BUIDL", "TSLAx"' } }, required: ['token'] } },
  { name: 'till_receipt', description: 'Produce the chain-anchored receipt for a VERIFIED payment (txHash + basescan link). Refuses without verification.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, amountUsd: { type: 'string' }, label: { type: 'string' },
      merchantName: { type: 'string' }, lookbackBlocks: { type: 'number' } }, required: ['to', 'amountUsd'] } },
  { name: 'till_roll', description: 'PROVABLE BOOKS: render an agent/merchant\'s till roll — a shareable statement where EVERY line carries its own txHash + basescan link, so the reader re-verifies each payment on Base themselves (trust no one, not even BIII). This is the substitute for the settlement statement an excluded merchant/agent loses when they leave a PSP. Pure and non-custodial (BIII holds no funds). Pass the verified receipts you collected from till_receipt.',
    inputSchema: { type: 'object', properties: {
      receipts: { type: 'array', description: 'the verified receipt objects (from till_receipt), each carrying a txHash', items: { type: 'object' } },
      merchantName: { type: 'string' }, lang: { type: 'string', description: '"en" (default) or "fr"' },
      brand: { description: 'WHITE-LABEL: a partner brand for the footer ("via <name>", optionally "· powered by BIII"). String or {name, poweredBy}. The non-custodial disclosure is a fact and stays regardless.' } }, required: ['receipts'] } },
  { name: 'till_export', description: 'ACCOUNTING EXPORT: turn the verified receipts into an accountant-ready CSV that QuickBooks / Xero / Excel import (the export finance teams need to adopt). Every row carries its own txHash + Basescan link, so the accountant re-verifies each amount on Base themselves — the export is a POINTER to the chain, never a book to trust. Non-custodial (BIII moved no funds). Columns: date, receipt_no, reference, description, payer, gross_usdc, tip_usdc, charged_usdc, token, chain, tx_hash, basescan_url, status. Dedup by txHash; optional block-time window; brand slugs the filename.',
    inputSchema: { type: 'object', properties: {
      receipts: { type: 'array', description: 'the verified receipt objects (from till_receipt), each carrying a txHash', items: { type: 'object' } },
      fromBlockTime: { type: 'number', description: 'optional — only export receipts settled at/after this unix block time' },
      toBlockTime: { type: 'number', description: 'optional — only export receipts settled at/before this unix block time' },
      brand: { description: 'WHITE-LABEL: a partner brand (string or {name}) — slugs the download filename; the non-custodial disclosure stays regardless.' } }, required: ['receipts'] } },
  { name: 'till_meter', description: 'USAGE → BILL for a white-label pilot, split by trust. The settled receipts are ON-CHAIN (each txHash re-verifiable on Base — the PROVABLE basis for receipt charges); the verdict count is SELF-REPORTED (verdicts are advisory reads, not chain artifacts) and labeled as such. The pricing plan is INJECTED (the partner brings their tiers). Pure, stateless, non-custodial (BIII holds no ledger). Returns the provable/self-reported split + itemized charges + total.',
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
      verified: { type: 'boolean', description: 'attest the JWT signature verified against the issuer\'s JWKS (BIII does not check it itself)' } }, required: ['token'] } },
  { name: 'till_authorize', description: 'SPEND AUTHORIZATION (Skyfire Programmable Payment): create a charge AND check it against what the agent\'s OWNER signed off — token, recipient allow-list, per-charge max, AND the cumulative cap. Fail-closed and drain-safe: an EIP-681 payment intent is issued ONLY if the charge is authorized (ten small charges cannot beat a low cap). BIII does not verify the authorization JWT signature itself — pass verified:true after checking it, or supply a spendAuth object. The caller tracks spentMicro (BIII is stateless).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'merchant 0x address (their own wallet)' },
      amountUsd: { type: 'string', description: 'e.g. "12.50" (or use amountMicro)' },
      amountMicro: { type: 'string' }, label: { type: 'string' },
      spendAuth: { description: 'the owner\'s signed spend authorization: a Programmable-Payment JWT (string) OR an object {token, chainId, maxPerChargeMicro, cumulativeCapMicro, allowedRecipients, exp}' },
      spentMicro: { type: 'string', description: 'how much has ALREADY been spent under this authorization (the caller\'s running total — the cumulative guard)' },
      verified: { type: 'boolean', description: 'attest the authorization JWT signature verified (BIII does not check it itself)' } }, required: ['to', 'spendAuth'] } },
];

async function callTool(name, a = {}) {
  if (name === 'till_vet_merchant') {
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
    // vertex 1 — reputation, shown as TWO LENSES kept SEPARATE (LAWBOR's discipline, verbatim): the LOCAL
    // known-bad screen (verified by THIS node against public lists, no network — decisive on a BLOCK) and
    // the ORACLE (MainStreet, ORACLE-REPORTED, advisory). They are never merged into one score — averaging
    // would launder the oracle's word into local proof, and would let an oracle PROCEED dilute a local BLOCK.
    const localScreen = screenAddress(cp, KNOWN_BAD);
    const meta = screenMeta(KNOWN_BAD);
    const oracle = localScreen.blocked ? { note: 'not consulted — the local BLOCK is decisive' } : await fetchOracle(cp);
    // The single decision fed to assessTriangle: local BLOCK wins; else the oracle's; else null (unknown).
    const reputation = localScreen.blocked ? { decision: 'BLOCK', score: null }
      : ((oracle.decision != null || oracle.score != null) ? { decision: oracle.decision, score: oracle.score } : null);
    const reputationLenses = {
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
    let standing = null;        // the decision fed to assessTriangle: { paidMicro }
    let standingLens = null;    // the auditable display lens (re-verifiable, never merged into reputation)
    if (process.env.BIII_LAWBOR_URL) {
      try {
        const r = await fetch(`${process.env.BIII_LAWBOR_URL.replace(/\/$/, '')}/why?of=${encodeURIComponent(cp)}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const j = await r.json();
          const directMicro = String(j.directMicro || '0');
          standing = { paidMicro: directMicro };
          standingLens = {
            paidUsdc: T.microToUsd(directMicro), directMicro, node: process.env.BIII_LAWBOR_URL,
            evidence: (Array.isArray(j.direct) ? j.direct : []).slice(0, 20).map((e) => ({ txHash: e.txHash, jobId: e.jobId, amountMicro: e.amountMicro, reVerify: 'https://basescan.org/tx/' + e.txHash })),
            bound: j.bound || null,
            disclosure: 'ORACLE-REPORTED by the LAWBOR node (BIII does not control it) — its viewer-relative view. RE-VERIFY each txHash on Base: a number without its evidence is not proof. Never merged into reputation.',
          };
        }
      } catch {}
    }
    // vertex 3 — settlement (on-chain), only if an amount is being checked
    let settlement = null;
    if (a.amountMicro) {
      const fact = await findPayment({ to: cp, minMicro: String(a.amountMicro), lookbackBlocks: 900 });
      settlement = T.verifyPayment({ to: cp, amountMicro: String(a.amountMicro), token: T.USDC_BASE, chainId: 8453 }, fact);
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
      merchantName: a.merchantName, dueDateMs: a.dueDateMs, issueDateMs: Date.now(), nowMs: Date.now() });
    return { invoice, bill: I.renderInvoice(invoice, { lang: a.lang || 'en' }), paymentURI: I.invoiceURI(invoice),
      note: 'Same registry as the till: the payer\'s OWN wallet executes the EIP-681; only the chain says "settled". Then till_check_invoice.' };
  }
  if (name === 'till_check_invoice') {
    const invoice = { kind: 'biii-invoice', number: a.number || null, dueDateMs: a.dueDateMs || null,
      merchant: { name: a.merchantName || null, address: String(a.to || '').toLowerCase() },
      charge: { to: String(a.to || '').toLowerCase(), amountMicro: String(a.totalMicro || ''), amountUsd: T.microToUsd(String(a.totalMicro || '0')), token: T.USDC_BASE, chainId: 8453 },
      lineItems: [], totalMicro: String(a.totalMicro || ''), totalUsd: T.microToUsd(String(a.totalMicro || '0')) };
    const fact = await findPayment({ to: invoice.charge.to, minMicro: invoice.charge.amountMicro, lookbackBlocks: a.lookbackBlocks || 43200 });
    const verdict = I.verifyInvoice(invoice, fact);
    const status = I.invoiceStatus(invoice, verdict, Date.now());
    return { status, verdict, fact: fact || null,
      receipt: verdict.paid === true ? I.invoiceReceipt(invoice, verdict, { merchantName: a.merchantName }) : null };
  }
  if (name === 'till_vet_asset') {
    const verdict = assessAsset({ token: a.token, claimedIssuer: a.claimedIssuer, claimedSymbol: a.claimedSymbol },
      RWA_REGISTRY ? { registry: RWA_REGISTRY } : {});
    return { verdict, triangleReputation: assetVertex(verdict),
      registrySource: RWA_REGISTRY ? `${RWA_SOURCE} · ${RWA_REGISTRY.length} contracts` : 'seed only (run `node scripts/biii-rwa-registry.js` — free Coingecko source, no key needed)',
      note: 'ADVISORY. genuine = the contract matches a verified issuer address; impersonation/unknown fail closed.' };
  }
  if (name === 'till_receipt') {
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
      summary: { count: s.count, grossUsd: s.grossUsd, tipsUsd: s.tipsUsd },
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
    return { ...ex, note: 'Import into QuickBooks / Xero / Excel; re-verify every tx_hash on BaseScan yourself. ' + DISCLAIMER };
  }
  if (name === 'till_meter') {
    // USAGE → BILL, stateless, split by trust: settled receipts are provable (on-chain), the verdict
    // count is self-reported (advisory reads aren't chain artifacts). The plan is injected by the partner.
    const receipts = (Array.isArray(a.receipts) ? a.receipts : []).filter((r) => r && r.txHash);
    const window = {};
    if (Number.isFinite(a.fromBlockTime)) window.fromBlockTime = Number(a.fromBlockTime);
    if (Number.isFinite(a.toBlockTime)) window.toBlockTime = Number(a.toBlockTime);
    const bill = meterUsage(receipts, { plan: a.plan, verdictCount: a.verdictCount, window });
    return { ...bill, note: 'Re-verify the settled receipts on Base yourself; bill on the self-reported verdict count only with a trusted volume report. ' + DISCLAIMER };
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
    const kya = kyaLens(a.token, { verified: !!a.verified, expectedAudience: a.expectedAudience, now: Date.now() });
    return { kya,
      note: kya.attested
        ? 'KYA-attested identity. This is WHO backs the agent, not that its address is safe to pay — run till_trust on the address. ' + DISCLAIMER
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

// ── minimal stdio MCP (initialize / tools/list / tools/call) ─────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return;  // JSON.parse("null") is valid → would crash the destructure OUTSIDE the try below, killing every tool
  const { id, method, params } = m;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'biii', version: '0.1.0' } } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const out = await callTool(params.name, params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
    }
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });    // notifications & misc: ack quietly
  } catch (e) {
    if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } });
  }
});

module.exports = { callTool, TOOLS, localClassify };
