#!/usr/bin/env node
'use strict';
/**
 * examples/hermes-base-trust.js — the Hermes skill in action: the verdict layer the blockchain skills lack.
 * ================================================================================================
 * The official Hermes Base/EVM skills READ the chain; none JUDGE it. This runs the `base-token-trust` skill's
 * core decisions (hermes/skills/base-token-trust/SKILL.md) with the real BIII libs — offline, non-custodial:
 *   1. vet a TOKEN contract  → genuine (issuer-official) / impersonation / unknown  (till_vet_asset)
 *   2. vet a WALLET          → known-bad BLOCK / not-known-bad                       (till_vet_merchant)
 * so a Hermes agent checks authenticity + safe-to-pay BEFORE it buys, swaps, or pays. Every verdict is
 * fail-closed and re-verifiable on-chain — a look-alike of a real tokenized stock is caught, not guessed at.
 *
 * Run: node examples/hermes-base-trust.js
 */
const { assessAsset } = require('../lib/asset');
const { loadAssetRegistry } = require('../lib/asset-registry');
const { loadFloor } = require('../lib/vet');
const { screenAddress } = require('../lib/screen');

const line = () => console.log('─'.repeat(72));

function main() {
  console.log('\n=== Hermes × BIII — the base-token-trust skill (authenticity + safe-to-pay) ===\n');
  console.log('The Hermes Base skills read the chain. BIII judges it: is this token genuine, is this wallet safe.');
  console.log('Everything below is OFFLINE, non-custodial, and re-verifiable on-chain.\n');

  const REG = loadAssetRegistry().entries || [];
  const FLOOR = loadFloor();
  const vetAsset = (o) => assessAsset(o, { registry: REG });
  const badge = (v) => v.status === 'genuine' ? (v.provenance === 'issuer-official' ? '✓ issuer-verified' : '~ listed (aggregator)')
    : v.status === 'impersonation' ? '🚨 IMPERSONATION' : v.status === 'unsafe' ? '✗ unsafe' : '? unknown';

  // ── 1. a GENUINE tokenized stock: Dinari dAAPL on Base (on-chain-verified in our issuer registry) ──
  const dAAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
  const g = vetAsset({ token: dAAPL, claimedSymbol: 'AAPL' });
  console.log('[1] TOKEN  ' + dAAPL.slice(0, 12) + '…  (a user pasted "AAPL on Base")');
  console.log('    → ' + badge(g) + '  — ' + (g.issuer ? g.issuer + ' ' + g.symbol : g.reason));

  // ── 2. the DANGEROUS case: the SAME real contract, but a listing CLAIMS it's BlackRock's ──
  const imp = vetAsset({ token: dAAPL, claimedIssuer: 'BlackRock' });
  console.log('\n[2] TOKEN  same contract, but a listing claims issuer = BlackRock');
  console.log('    → ' + badge(imp) + '  — ' + imp.reason);
  console.log('    (a heuristic honeypot filter would MISS this — the bytecode is fine; the CLAIM is the fraud)');

  // ── 3. an UNKNOWN contract: fail-closed, never a false "genuine" ──
  const unk = vetAsset({ token: '0x' + 'ab'.repeat(20), claimedSymbol: 'AAPL' });
  console.log('\n[3] TOKEN  0xabab…  claims "AAPL" but is in no verified registry');
  console.log('    → ' + badge(unk) + '  — ' + unk.reason);

  // ── 4. the WALLET before you pay it: known-bad is decisive, no oracle needed ──
  console.log('\n[4] WALLET safe-to-pay (local known-bad floor — holds with zero network):');
  const bad = FLOOR.available ? [...FLOOR.set][0] : '0x' + 'de'.repeat(20);
  const scrBad = screenAddress(bad, FLOOR);
  console.log('    a sanctioned/known-bad wallet → ' + (scrBad.blocked ? '✗ BLOCKED — do not pay' : '(floor unavailable)'));
  const clean = '0x' + 'c1'.repeat(20);
  const scrClean = screenAddress(clean, FLOOR);
  console.log('    a clean wallet                → ' + (scrClean.blocked ? 'BLOCKED' : '~ not known-bad (NOT a clean bill — stay cautious)'));

  line();
  console.log('BOOST: Hermes reads Base; BIII is the fail-closed VERDICT (genuine vs look-alike + safe-to-pay).');
  console.log('Wire it: hermes/skills/base-token-trust/ + the mcp_servers.biii block (hermes/config-snippet.yaml).');
}

if (require.main === module) { try { main(); } catch (e) { console.error('demo error: ' + e.message); process.exit(1); } }
module.exports = { main };
