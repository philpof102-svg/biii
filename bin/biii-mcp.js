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
const { DISCLAIMER } = require('../lib/disclaimer');
const { loadScreen, screenAddress, screenMeta } = require('../lib/screen');
const fs = require('node:fs'), path = require('node:path');

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

// Reputation for the trust triangle. TWO layers, decentralization on purpose:
//   1) LOCAL known-bad floor (no network) — a listed address is BLOCKed regardless of any oracle.
//   2) MainStreet live behavioral score — ADVISORY, fail-closed (unreachable/absent ⇒ null ⇒ 'unknown',
//      never 'clean'). x-ms-monitor:1 keeps internal calls out of the product metrics.
// So MainStreet being slow/down can no longer let a known scammer through — the floor still fires.
async function fetchReputation(address) {
  const local = screenAddress(address, KNOWN_BAD);
  if (local.blocked) return { decision: 'BLOCK', score: null, source: 'local-known-bad', reason: local.reason };
  try {
    const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(String(address || '').toLowerCase())}`,
      { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); return { decision: j.decision ?? null, score: j.score ?? null, source: 'mainstreet-oracle' }; }
  } catch {}
  // oracle down + not-locally-known-bad ⇒ no live signal. Honest: 'unknown', never 'clean'. The local
  // screen still RAN (it just did not flag this address) — the floor held.
  return null;
}

const TOOLS = [
  { name: 'till_vet_merchant', description: 'MainStreet safe-to-pay preflight on a merchant address (advisory: decision + score). Vet the RECIPIENT before paying.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '0x merchant address' } }, required: ['address'] } },
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
  { name: 'till_trust', description: 'The TRUST TRIANGLE in one call: composes reputation (MainStreet safe-to-pay), standing (LAWBOR proven history, if BIII_LAWBOR_URL set) and settlement (on-chain, if amountMicro given) into ONE verdict (unsafe/unknown/trusted/settled). Fail-closed: absence is never trust.',
    inputSchema: { type: 'object', properties: {
      counterparty: { type: 'string', description: '0x address to assess (the merchant, or a payer)' },
      amountMicro: { type: 'string', description: 'optional — if given, also check on-chain settlement to this address' } }, required: ['counterparty'] } },
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
      merchantName: { type: 'string' }, lang: { type: 'string', description: '"en" (default) or "fr"' } }, required: ['receipts'] } },
];

async function callTool(name, a = {}) {
  if (name === 'till_vet_merchant') {
    // DECENTRALIZED floor FIRST: a locally-known-bad address is refused with zero network, even if the
    // oracle is slow/down — the block cannot vanish with the service (the SPOF this closes).
    const local = screenAddress(a.address, KNOWN_BAD);
    if (local.blocked) return { decision: 'BLOCK', score: 0, source: 'local-known-bad', advisory: local.reason };
    const screen = screenMeta(KNOWN_BAD);   // freshness of the floor a "not-known-bad" result leans on
    try {
      const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(String(a.address || ''))}`,
        { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { advisory: 'oracle unreachable (HTTP ' + r.status + ') — treat the merchant as UNKNOWN, not as safe', screen };
      const j = await r.json();
      return { decision: j.decision ?? null, score: j.score ?? null, source: 'mainstreet-oracle', advisory: 'ORACLE-REPORTED — advisory only, never a guarantee', screen };
    } catch (e) {
      // a timeout used to THROW here (no catch) and crash the tool; degrade honestly instead.
      return { advisory: 'oracle unreachable (' + (e && e.message) + ') — treat the merchant as UNKNOWN, not as safe', screen };
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
    // vertex 1 — reputation (MainStreet), advisory (shared helper, keeps x-ms-monitor discipline)
    const reputation = await fetchReputation(cp);
    // vertex 2 — standing (LAWBOR proven history), optional (only if a node is configured).
    // LAWBOR GET /credit?of= returns directUsdcMicro: the direct, on-chain-PROVEN USDC settled with this
    // counterparty (agent↔agent). That IS standing. Fail-closed: unreachable/absent ⇒ null ⇒ 'none'.
    let standing = null;
    if (process.env.BIII_LAWBOR_URL) {
      try {
        const r = await fetch(`${process.env.BIII_LAWBOR_URL.replace(/\/$/, '')}/credit?of=${encodeURIComponent(cp)}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); standing = { paidMicro: String(j.directUsdcMicro || '0') }; }
      } catch {}
    }
    // vertex 3 — settlement (on-chain), only if an amount is being checked
    let settlement = null;
    if (a.amountMicro) {
      const fact = await findPayment({ to: cp, minMicro: String(a.amountMicro), lookbackBlocks: 900 });
      settlement = T.verifyPayment({ to: cp, amountMicro: String(a.amountMicro), token: T.USDC_BASE, chainId: 8453 }, fact);
    }
    // FRESHNESS disclosure: a verdict that is not a hard local BLOCK leans on the known-bad list's age.
    // Surface it so "not-known-bad" is never read as "screened against a current list" when it isn't.
    const screen = screenMeta(KNOWN_BAD);
    return { triangle: assessTriangle({ reputation, standing, settlement }),
      sources: { reputation, standing: standing || null, settlementChecked: !!a.amountMicro, screen },
      disclosure: screen.disclosure };
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
      statement: L.renderRoll(rows, { merchantName: a.merchantName || 'Merchant', lang: a.lang === 'fr' ? 'fr' : 'en' }),
      summary: { count: s.count, grossUsd: s.grossUsd, tipsUsd: s.tipsUsd },
      lines: rows.map((e) => ({ no: e.no, amountUsd: e.receipt.amountUsd, txHash: e.receipt.txHash, explorer: e.receipt.explorer || ('https://basescan.org/tx/' + e.receipt.txHash) })),
      note: 'Re-verify EVERY txHash on BaseScan yourself — this statement is only as true as the chain it points to. ' + DISCLAIMER,
    };
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

module.exports = { callTool, TOOLS };
