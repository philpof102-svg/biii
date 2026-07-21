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
const fs = require('node:fs'), path = require('node:path');

// Authoritative verified-issuer registry, if it's been ingested (scripts/biii-rwa-registry.js → RWA.xyz).
// Absent → assessAsset falls back to its small SEED. A stale/missing file can only UNDER-verify (safe).
let RWA_REGISTRY = null, RWA_SOURCE = null;
try { const p = path.join(__dirname, '..', 'data', 'rwa-registry.json'); if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); RWA_REGISTRY = j.entries; RWA_SOURCE = j.generatedFrom || 'file'; } } catch {}

const MAINSTREET = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');

const TOOLS = [
  { name: 'till_vet_merchant', description: 'MainStreet safe-to-pay preflight on a merchant address (advisory: decision + score). Vet the RECIPIENT before paying.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '0x merchant address' } }, required: ['address'] } },
  { name: 'till_create_charge', description: 'Create a USDC-on-Base charge for a real-world merchant. Returns the charge + the EIP-681 payment URI your OWN wallet must execute (basetill holds no key, moves no funds).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'merchant 0x address (their own wallet — non-custodial)' },
      amountUsd: { type: 'string', description: 'e.g. "4.50"' },
      label: { type: 'string' }, orderId: { type: 'string' } }, required: ['to', 'amountUsd'] } },
  { name: 'till_check_payment', description: 'Watch Base for the USDC transfer paying a charge and verify it FIELD-FOR-FIELD (wrong chain/token/recipient/underpay/unconfirmed = NOT paid). Only the chain says paid.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, amountMicro: { type: 'string' },
      lookbackBlocks: { type: 'number', description: 'default 900 (~30 min on Base)' } }, required: ['to', 'amountMicro'] } },
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
];

async function callTool(name, a = {}) {
  if (name === 'till_vet_merchant') {
    const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(String(a.address || ''))}`,
      { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { advisory: 'oracle unreachable (HTTP ' + r.status + ') — treat the merchant as UNKNOWN, not as safe' };
    const j = await r.json();
    return { decision: j.decision ?? null, score: j.score ?? null, advisory: 'ORACLE-REPORTED — advisory only, never a guarantee' };
  }
  if (name === 'till_create_charge') {
    const charge = T.createCharge({ to: a.to, amountUsd: a.amountUsd, label: a.label, orderId: a.orderId, nowMs: Date.now() });
    return { charge, paymentURI: T.paymentURI(charge),
      note: 'Execute this EIP-681 intent with YOUR OWN wallet (basetill signs nothing). Then till_check_payment.' };
  }
  if (name === 'till_check_payment') {
    const charge = { to: String(a.to || '').toLowerCase(), amountMicro: String(a.amountMicro || ''), amountUsd: T.microToUsd(String(a.amountMicro || '0')), token: T.USDC_BASE, chainId: 8453 };
    const fact = await findPayment({ to: charge.to, minMicro: charge.amountMicro, lookbackBlocks: a.lookbackBlocks || 900 });
    return { verdict: T.verifyPayment(charge, fact), fact: fact || null };
  }
  if (name === 'till_trust') {
    const cp = String(a.counterparty || '').toLowerCase();
    // vertex 1 — reputation (MainStreet), advisory
    let reputation = null;
    try {
      const r = await fetch(`${MAINSTREET}/api/agent/preflight/${encodeURIComponent(cp)}`, { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); reputation = { decision: j.decision ?? null, score: j.score ?? null }; }
    } catch {}
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
    return { triangle: assessTriangle({ reputation, standing, settlement }), sources: { reputation, standing: standing || null, settlementChecked: !!a.amountMicro } };
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
