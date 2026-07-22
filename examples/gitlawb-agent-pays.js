#!/usr/bin/env node
'use strict';
/**
 * examples/gitlawb-agent-pays.js — the gitlawb wedge: safe-to-pay BEFORE an escrow release.
 * ================================================================================================
 * gitlawb (Kevin's decentralized git network) already has MONEY: bounties with escrow (5% fee) and
 * delegated tasks, and agents-as-DIDs (did:key, Ed25519). What it does NOT have is a COUNTERPARTY TRUST
 * layer — nothing tells the escrow holder whether the claimant they are about to release funds to is safe.
 * That is the single riskiest moment in any escrow: the RELEASE. BIII is exactly that check, and a gitlawb
 * agent already loads MCP servers (`gl mcp serve` = 30+ tools), so the integration is ZERO new code: add
 * biii-mcp alongside gl.
 *
 * This is the SHARPER story than a chain with no payments at all: gitlawb isn't missing a rail, it's missing
 * a brake. BIII is the brake — fail-closed, non-custodial, and re-verifiable.
 *
 * Runs the whole flow OFFLINE with the real BIII libs — no keys, no funds, no network:
 *   1. a gitlawb agent claims a bounty; resolve its did:key → a payable Base address (bidirectional attest)
 *   2. read its Skyfire KYA identity (who backs it) — advisory, never "safe to pay"
 *   3. BEFORE releasing escrow: is the claimant's address safe? local known-bad floor + trust-core verdict
 *   4. release: an EIP-681 charge the escrow's OWN wallet executes (BIII holds no key, moves no funds)
 *   5. receipt: field-for-field verified, anchored to the txHash
 *   6. back to gitlawb: the receipt attaches to the bounty as proof-of-payout in gitlawb's own signed log
 *
 * Run: node examples/gitlawb-agent-pays.js
 */
const T = require('../lib/till');
const { bindingLens } = require('../lib/identity');
const { kyaLens } = require('../lib/skyfire');
const { loadScreen, screenAddress } = require('../lib/screen');
const { verdict } = require('trust-core');
const fs = require('node:fs'), path = require('node:path');

const line = () => console.log('─'.repeat(72));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function main() {
  console.log('\n=== BIII × gitlawb — safe-to-pay BEFORE releasing a bounty escrow ===\n');
  console.log('gitlawb already has escrow + delegated tasks + agents-as-DIDs. It has no brake on the RELEASE.');
  console.log('BIII is the brake. Everything below is OFFLINE, non-custodial, and re-verifiable.\n');

  // A gitlawb bounty: escrow is funded, an agent claims it, and the holder is about to release. did:key
  // below is the W3C did:key TEST VECTOR (a public example — NOT anyone's real gitlawb account).
  const bounty = { id: 'glb:bounty/492', title: 'port the indexer to Bun', amountUsd: '250.00', escrowFeePct: 5 };

  // ── 1. IDENTITY: did:key ↔ Base (the claimant proved it owns the payout address; both keys signed) ──
  const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';   // gitlawb agent (Ed25519)
  const claimant = '0x' + 'ab'.repeat(20);
  const binding = bindingLens({ did, address: claimant, nonce: 'bounty-492-nonce', chainId: 8453,
    sigDid: '0x' + '3'.repeat(128), sigBase: '0x' + '2'.repeat(130), verified: true });   // verified upstream
  console.log('[1] IDENTITY  ' + did.slice(0, 22) + '… ⇄ ' + claimant);
  console.log('    bound: ' + binding.bound + '  (the did:key AND the Base key signed the same message — anyone re-verifies)');
  if (!binding.bound) return console.log('    → refusing to resolve: ' + binding.reason);
  console.log('    identities: ' + JSON.stringify(binding.identities));

  // ── 2. KYA: who stands behind the claimant (advisory identity, anti-replay on aud) ──
  const kyaJwt = b64({ alg: 'ES256' }) + '.' + b64({ iss: 'https://api.skyfire.xyz', sub: did,
    aud: 'gitlawb:escrow/492', exp: Math.floor(Date.now() / 1000) + 3600, owner: 'business: Bun Labs (KYB)' }) + '.sig';
  const kya = kyaLens(kyaJwt, { verified: true, expectedAudience: 'gitlawb:escrow/492' });
  console.log('\n[2] KYA       ' + (kya.attested ? kya.issuer + ' vouches — backer: ' + kya.kyaClaims.owner : 'not attested'));
  console.log('    posture: ' + JSON.stringify(kya.posture) + '  (advisory: WHO backs the agent, not "safe to release")');

  // ── 3. TRUST: BEFORE release — is the claimant's address safe? local floor + trust-core, no oracle ──
  const floorPath = path.join(__dirname, '..', 'data', 'known-bad.json');
  const KNOWN_BAD = fs.existsSync(floorPath) ? loadScreen(JSON.parse(fs.readFileSync(floorPath, 'utf8'))) : loadScreen(null);
  const assess = (addr, label) => {
    const scr = screenAddress(addr, KNOWN_BAD);
    const v = verdict({ deny: { available: KNOWN_BAD.available, entry: scr.blocked ? { reason: scr.reason, severity: 'high' } : null } }, null, { trustedSignals: true });
    console.log('    ' + label.padEnd(24) + ' → ' + v.decision + (v.allowed ? '' : '  (RELEASE BLOCKED)'));
    return v;
  };
  console.log('\n[3] TRUST (the brake, local — holds even if MainStreet is down):');
  const knownBadAddr = KNOWN_BAD.available ? [...KNOWN_BAD.set][0] : '0x' + 'de'.repeat(20);
  assess(knownBadAddr, 'a sanctioned claimant');                    // BLOCK — escrow is NOT released
  const clean = assess(claimant, 'this claimant');                 // honest cold-start verdict
  if (!clean.allowed) return console.log('    → not safe — escrow stays locked, holder is warned. This is the point.');

  // ── 4. RELEASE: an EIP-681 charge the escrow's OWN wallet executes (BIII signs nothing) ──
  const charge = T.createCharge({ to: claimant, amountUsd: bounty.amountUsd, label: 'bounty ' + bounty.id, nowMs: Date.now() });
  console.log('\n[4] RELEASE   ' + T.paymentURI(charge));
  console.log('    (the escrow wallet executes this intent — BIII holds no key, releases no funds itself)');

  // ── 5. RECEIPT: field-for-field verified, anchored to the tx (here: a simulated settlement) ──
  const fact = { txHash: '0x' + 'f'.repeat(64), from: '0x' + 'e5c0'.repeat(10), to: claimant, valueMicro: charge.amountMicro,
    token: T.USDC_BASE, chainId: 8453, confirmations: 3, blockTime: Math.floor(Date.now() / 1000) };
  const paid = T.verifyPayment(charge, fact);
  const receipt = T.receipt(charge, paid, { merchantName: bounty.title });
  console.log('\n[5] RECEIPT   paid=' + paid.paid + '  ' + receipt.amountUsd + ' USDC  tx ' + receipt.txHash.slice(0, 12) + '…');
  console.log('    re-verify: ' + receipt.explorer);

  // ── 6. BACK TO gitlawb: attach the receipt to the bounty — proof-of-payout in gitlawb's own log ──
  // Shape of the integration (via a gl mcp tool): the txHash-anchored receipt lands ON the bounty record,
  // so "who was paid for this task, and can I re-verify it on-chain?" lives in gitlawb's signed history —
  // right next to the commits that closed it. Same property as the receipt beside a merge.
  const gitlawbAttach = { on: bounty.id, type: 'biii-payout-receipt', did, txHash: receipt.txHash,
    amountUsd: receipt.amountUsd, explorer: receipt.explorer };
  console.log('\n[6] gitlawb   attach → ' + bounty.id + '  (' + gitlawbAttach.type + ', tx ' + receipt.txHash.slice(0, 10) + '…)');
  console.log('    the payout is now in the SAME signed log as the commits that closed the bounty.');

  line();
  console.log('WEDGE: gitlawb has the rail (escrow) — BIII is the brake (safe-to-pay) + the receipt (proof).');
  console.log('Ask to Kevin: gitlawb agents load biii-mcp; the holder runs the triangle BEFORE release. Zero new code.');
}

if (require.main === module) { try { main(); } catch (e) { console.error('demo error: ' + e.message); process.exit(1); } }
module.exports = { main };
