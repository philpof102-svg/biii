'use strict';
// BIII decentralization — the known-bad floor holds when the MainStreet oracle is DOWN, even against a
// green vertex. This is the exact adversarial gate the design workflow surfaced: before the local floor,
// a known-bad address with proven standing/settlement was silently upgraded to 'trusted'/'settled' when
// the oracle timed out (fail-OPEN in the composed verdict). Run: node test/decentralize.test.js
const assert = require('node:assert');
const LAZARUS = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';   // in data/known-bad.json
const CLEAN = '0x' + '11'.repeat(20);

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// Route fetch by URL: MainStreet is DOWN (throws on every call); the LAWBOR /credit endpoint returns a
// GREEN proven-standing — the very green that used to upgrade a known-bad address to payable.
process.env.BIII_LAWBOR_URL = 'http://lawbor.test';
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('avisradar') || u.includes('/api/agent/preflight')) throw new Error('MainStreet DOWN');
  if (u.includes('/credit')) return { ok: true, json: async () => ({ directUsdcMicro: '5000000' }) };
  throw new Error('unexpected fetch ' + u);
};
const { callTool } = require('../bin/biii-mcp');

(async () => {
  console.log('BIII decentralization — the local floor holds with the oracle down:');

  await t('till_trust: Lazarus + MainStreet DOWN + a GREEN standing → STILL unsafe, not payable', async () => {
    const r = await callTool('till_trust', { counterparty: LAZARUS });
    assert.equal(r.triangle.trust, 'unsafe', 'the LOCAL known-bad BLOCK must override the green standing');
    assert.equal(r.triangle.payable, false);
    assert.equal(r.sources.reputation.source, 'local-known-bad', 'the block came from the local list, not the (down) oracle');
  });

  await t('till_vet_merchant: Lazarus + MainStreet DOWN → local BLOCK, and no crash on the timeout', async () => {
    const r = await callTool('till_vet_merchant', { address: LAZARUS });
    assert.equal(r.decision, 'BLOCK');
    assert.equal(r.source, 'local-known-bad');
  });

  await t('a CLEAN merchant + MainStreet DOWN degrades HONESTLY (advisory: UNKNOWN, never a false safe)', async () => {
    const r = await callTool('till_vet_merchant', { address: CLEAN });
    assert.equal(r.decision, undefined, 'no BLOCK for a not-known-bad address');
    assert.match(r.advisory, /UNKNOWN, not as safe/);
  });

  await t('SANITY: a clean address WITH proven on-chain standing is legitimately trusted (the floor only blocks known-bad)', async () => {
    const r = await callTool('till_trust', { counterparty: CLEAN });
    // clean + proven LAWBOR standing → trusted is CORRECT (standing is on-chain, needs no oracle); the fix
    // must not over-block. The point is only that KNOWN-BAD can never reach here.
    assert.notEqual(r.triangle.trust, 'unsafe');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
