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
    // vertex 2 — standing (LAWBOR proven history), optional (only if a node is configured)
    let standing = null;
    if (process.env.BIII_LAWBOR_URL) {
      try {
        const r = await fetch(`${process.env.BIII_LAWBOR_URL.replace(/\/$/, '')}/peer?of=${encodeURIComponent(cp)}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); standing = { paidMicro: (j.trust && (j.trust.inboundMicro || j.trust.directMicro)) || '0' }; }
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
