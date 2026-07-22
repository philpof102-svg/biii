'use strict';
// BIII × ERC-8004 reputation lens — SEPARATE, advisory, re-verifiable, sybil-honest. Pure + offline.
// Run: node test/erc8004.test.js
const assert = require('node:assert');
const { erc8004Lens, reVerifyPointer, ERC_8004_BASE } = require('../lib/erc8004');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII × ERC-8004 lens (interop, never rival; advisory, never payable-deciding):');

t('absent summary → available:false, and the disclosure says absence is not trust', () => {
  const l = erc8004Lens(null, { agentId: 42 });
  assert.equal(l.available, false);
  assert.match(l.disclosure, /absence.*never trust/i);
  assert.ok(l.reVerify && l.reVerify.agentId === '42', 'still points to re-verify on Base');
});

t('count 0 → status none: no feedback yet is UNVERIFIED, never proven safe', () => {
  const l = erc8004Lens({ count: 0, summaryValue: 0, summaryValueDecimals: 0 }, { agentId: 7 });
  assert.equal(l.available, true);
  assert.equal(l.status, 'none');
  assert.equal(l.value, null);
  assert.match(l.disclosure, /unverified|not proven safe/i);
});

t('count > 0 → status reported, value normalized by decimals, and it is ADVISORY', () => {
  const l = erc8004Lens({ count: 12, summaryValue: 4500, summaryValueDecimals: 3 }, { agentId: 9 });
  assert.equal(l.status, 'reported');
  assert.equal(l.count, 12);
  assert.equal(l.value, 4.5, '4500 / 10^3');
  assert.equal(l.advisory, true, 'never payable-deciding');
});

t('the SYBIL caveat is present for all-clients feedback, and dropped only when trustedClientsOnly', () => {
  const all = erc8004Lens({ count: 100, summaryValue: 5, summaryValueDecimals: 0 }, { agentId: 1 });
  assert.equal(all.sybilCaveat, true);
  assert.match(all.disclosure, /sybil-farmable|advisory only/i);
  const trusted = erc8004Lens({ count: 100, summaryValue: 5, summaryValueDecimals: 0 }, { agentId: 1, trustedClientsOnly: true });
  assert.equal(trusted.sybilCaveat, false);
  assert.match(trusted.disclosure, /trust/i);
  assert.match(trusted.disclosure, /still advisory|never overrides/i, 'even trusted-filtered stays advisory over the floor');
});

t('every lens carries a re-verify pointer (registry + agentId + getSummary) — trust the chain, not the field', () => {
  const l = erc8004Lens({ count: 3, summaryValue: 1, summaryValueDecimals: 0 }, { agentId: 55 });
  assert.equal(l.reVerify.registry, ERC_8004_BASE.reputationRegistry);
  assert.equal(l.reVerify.agentId, '55');
  assert.match(l.reVerify.method, /getSummary/);
  assert.match(l.reVerify.chain, /Base/);
});

t('a registry override is honored (verify against your own deployment)', () => {
  const l = erc8004Lens({ count: 1, summaryValue: 1, summaryValueDecimals: 0 }, { agentId: 2, registry: '0xDEAD' });
  assert.equal(l.reVerify.registry, '0xDEAD');
});

t('malformed summary values never throw and never invent trust', () => {
  const l = erc8004Lens({ count: 'abc', summaryValue: 'xyz', summaryValueDecimals: 'q' }, { agentId: 3 });
  // count coerces to 0 (NaN→0) → treated as "no feedback", never a positive
  assert.equal(l.status, 'none');
  assert.equal(l.value, null);
});

t('no agentId → still a valid lens, just no re-verify pointer', () => {
  const l = erc8004Lens({ count: 5, summaryValue: 10, summaryValueDecimals: 0 });
  assert.equal(l.status, 'reported');
  assert.equal(l.reVerify, null);
  assert.equal(reVerifyPointer(null), null);
});

// ── MCP wiring: till_trust surfaces the erc8004 lens on opt-in, omits it otherwise ──────────────
const { callTool, TOOLS } = require('../bin/biii-mcp.js');
const KB = require('../data/known-bad.json').addresses[0];   // known-bad ⇒ local BLOCK short-circuits the oracle (no network)
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

(async () => {
  await tA('till_trust declares the ERC-8004 opt-in params (agentId / erc8004Summary / trustedClients)', async () => {
    const props = TOOLS.find((x) => x.name === 'till_trust').inputSchema.properties;
    assert.ok(props.agentId && props.erc8004Summary && props.erc8004TrustedClients, 'opt-in params declared');
    assert.match(props.agentId.description, /erc-8004|interop/i);
  });

  await tA('till_trust surfaces sources.erc8004 (advisory, re-verifiable) when opted in — never in the triangle', async () => {
    const out = await callTool('till_trust', { counterparty: KB, agentId: '123', erc8004Summary: { count: 10, summaryValue: 40, summaryValueDecimals: 1 } });
    assert.ok(out.sources.erc8004, 'erc8004 lens surfaced');
    assert.equal(out.sources.erc8004.status, 'reported');
    assert.equal(out.sources.erc8004.value, 4, '40 / 10^1');
    assert.equal(out.sources.erc8004.advisory, true);
    // the known-bad address is still unsafe: the advisory ERC-8004 lens does NOT rescue it
    assert.equal(out.triangle.trust, 'unsafe', 'ERC-8004 never overrides the known-bad floor');
    assert.equal(out.triangle.payable, false);
  });

  await tA('till_trust OMITS erc8004 when the caller does not opt in (absence is never trust)', async () => {
    const out = await callTool('till_trust', { counterparty: KB });
    assert.equal(out.sources.erc8004, undefined, 'no opt-in ⇒ no erc8004 lens');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
