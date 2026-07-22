#!/usr/bin/env node
'use strict';
/**
 * examples/buzz-agent-pays.js — the partnership proof: a buzz/Nostr agent pays SAFELY via BIII.
 * ================================================================================================
 * buzz (Block) is a sovereign workspace where agents are keypairs — but it has NO payment layer and NO
 * counterparty reputation (its NIP-IA explicitly avoids global reputation). BIII fills exactly that gap,
 * and a buzz agent already loads MCP servers, so the integration is ZERO new code: add biii-mcp.
 *
 * This script runs the whole wedge OFFLINE with the real BIII libs — no keys, no funds, no network:
 *   1. resolve the agent's npub → a payable Base address (bidirectional attestation, verified)
 *   2. read the agent's Skyfire KYA identity (who backs it) — advisory
 *   3. is the merchant safe to pay?  local known-bad floor + trust-core verdict (decisive, no oracle)
 *   4. pay: an EIP-681 charge the agent's OWN wallet executes (BIII holds no key)
 *   5. settle + receipt: field-for-field verified, anchored to the txHash
 *   6. post the receipt back to buzz as a signed event — payment in the SAME auditable log as the work
 *
 * Run: node examples/buzz-agent-pays.js
 */
const T = require('../lib/till');
const { bindingLens, bindingMessage } = require('../lib/identity');
const { kyaLens } = require('../lib/skyfire');
const { loadScreen, screenAddress } = require('../lib/screen');
const { verdict } = require('trust-core');
const fs = require('node:fs'), path = require('node:path');

const line = () => console.log('─'.repeat(72));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function main() {
  console.log('\n=== BIII × buzz — a keypair-native agent pays a real merchant, safely ===\n');
  console.log('buzz has agents-as-keypairs but no payment + no reputation. BIII is the MCP that adds both.');
  console.log('Everything below is OFFLINE, non-custodial (no key, no funds), and re-verifiable.\n');

  // ── 1. IDENTITY: npub ↔ Base (the agent proved it owns the address; both keys signed the message) ──
  const npub = 'a3f1'.repeat(16);                                   // the buzz agent's Nostr pubkey (64-hex)
  const agentAddress = '0x' + 'ab'.repeat(20);
  const binding = bindingLens({ npub, address: agentAddress, nonce: 'demo-nonce-1', chainId: 8453,
    sigNostr: '0x' + '1'.repeat(128), sigBase: '0x' + '2'.repeat(130), verified: true });   // verified upstream
  console.log('[1] IDENTITY  npub ' + npub.slice(0, 12) + '… ⇄ ' + agentAddress);
  console.log('    bound: ' + binding.bound + '  (both keys signed the canonical message — anyone re-verifies)');
  if (!binding.bound) return console.log('    → refusing: ' + binding.reason);

  // ── 2. KYA: who stands behind the agent (advisory identity, anti-replay on aud) ──
  const kyaJwt = b64({ alg: 'ES256' }) + '.' + b64({ iss: 'https://api.skyfire.xyz', sub: 'agent:' + npub.slice(0, 8),
    aud: 'merchant:cafe-central', exp: Math.floor(Date.now() / 1000) + 3600, owner: 'business: ACME Robotics (KYB)' }) + '.sig';
  const kya = kyaLens(kyaJwt, { verified: true, expectedAudience: 'merchant:cafe-central' });
  console.log('\n[2] KYA       ' + (kya.attested ? kya.issuer + ' vouches — backer: ' + kya.kyaClaims.owner : 'not attested'));
  console.log('    (advisory: WHO backs the agent, not "safe to pay" — the address still runs the triangle)');

  // ── 3. TRUST: is the merchant safe to pay? local floor + trust-core, decisive without any oracle ──
  const floorPath = path.join(__dirname, '..', 'data', 'known-bad.json');
  const KNOWN_BAD = fs.existsSync(floorPath) ? loadScreen(JSON.parse(fs.readFileSync(floorPath, 'utf8'))) : loadScreen(null);
  const assess = (addr, label) => {
    const scr = screenAddress(addr, KNOWN_BAD);
    const v = verdict({ deny: { available: KNOWN_BAD.available, entry: scr.blocked ? { reason: scr.reason, severity: 'high' } : null } }, null, { trustedSignals: true });
    console.log('    ' + label.padEnd(20) + ' → ' + v.decision + (v.allowed ? '' : '  (REFUSED)'));
    return v;
  };
  console.log('\n[3] TRUST (local, no oracle — holds even if MainStreet is down):');
  const knownBadAddr = KNOWN_BAD.available ? [...KNOWN_BAD.set][0] : '0x' + 'de'.repeat(20);
  assess(knownBadAddr, 'a known-bad address');                      // BLOCK — decisive
  const merchant = '0x' + 'cafe'.repeat(10);
  const clean = assess(merchant, 'the clean merchant');            // PROCEED_LOW_VALUE — honest cold start
  if (!clean.allowed) return console.log('    → not safe, aborting.');

  // ── 4. PAY: an EIP-681 charge the agent's OWN wallet executes (BIII signs nothing) ──
  const charge = T.createCharge({ to: merchant, amountUsd: '12.50', label: 'API credits', nowMs: Date.now() });
  console.log('\n[4] PAY       ' + T.paymentURI(charge));
  console.log('    (the agent wallet executes this intent — BIII holds no key, moves no funds)');

  // ── 5. SETTLE + RECEIPT: field-for-field verified, anchored to the tx (here: a simulated settlement) ──
  const fact = { txHash: '0x' + 'f'.repeat(64), from: agentAddress, to: merchant, valueMicro: charge.amountMicro,
    token: T.USDC_BASE, chainId: 8453, confirmations: 3, blockTime: Math.floor(Date.now() / 1000) };
  const paid = T.verifyPayment(charge, fact);
  const receipt = T.receipt(charge, paid, { merchantName: 'Café Central' });
  console.log('\n[5] RECEIPT   paid=' + paid.paid + '  ' + receipt.amountUsd + ' USDC  tx ' + receipt.txHash.slice(0, 12) + '…');
  console.log('    re-verify: ' + receipt.explorer);

  // ── 6. BACK TO buzz: the receipt as a signed event — payment in the SAME log as the collaboration ──
  const buzzEvent = { kind: 40700, /* biii-payment-receipt */ pubkey: npub, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', npub], ['tx', receipt.txHash], ['amount', receipt.amountUsd]], content: JSON.stringify(receipt) };
  console.log('\n[6] BUZZ EVENT  kind:' + buzzEvent.kind + ' (biii-payment-receipt) — the payment lands in the');
  console.log('    same signed, auditable log as the patch/review/merge. "Why the code exists" + "who paid".');

  line();
  console.log('WEDGE: buzz(collab) + gitlawb(sovereign git) + BIII(safe-to-pay + receipt). Zero new code for buzz.');
  console.log('Partnership ask: your agents load biii-mcp; they can pay real merchants/agents safely, with receipts.');
}

if (require.main === module) { try { main(); } catch (e) { console.error('demo error: ' + e.message); process.exit(1); } }
module.exports = { main };
