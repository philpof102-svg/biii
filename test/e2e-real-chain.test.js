'use strict';
// E2E against the REAL Base chain — proves the deployable core (chain watcher → verifyPayment → receipt)
// verifies an actual on-chain USDC payment, not a stub. NETWORK-GATED: if the public RPC is unreachable or
// returns nothing usable (offline CI, rate-limit), the test SKIPS (never fails) so `npm test` stays green
// offline. When the network is there, it is a real end-to-end proof. Run: node test/e2e-real-chain.test.js
const assert = require('node:assert');
const { findPayment } = require('../lib/chain');
const T = require('../lib/till');

let pass = 0, fail = 0, skipped = false;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
};

// find one real, recent USDC transfer on Base (recipient + value) to verify against. Returns null on any
// network trouble — the caller then SKIPS. Small block range keeps the public RPC response tiny.
async function aRecentTransfer() {
  const head = BigInt(await rpc('eth_blockNumber', []));
  const logs = await rpc('eth_getLogs', [{ address: USDC, fromBlock: '0x' + (head - 2n).toString(16), toBlock: 'latest', topics: [TOPIC] }]);
  const cands = (logs || [])
    .filter((l) => Array.isArray(l.topics) && l.topics.length >= 3 && String(l.address).toLowerCase() === USDC)
    .map((l) => ({ to: ('0x' + l.topics[2].slice(26)).toLowerCase(), micro: BigInt(l.data).toString(), block: Number(BigInt(l.blockNumber)) }))
    .filter((x) => BigInt(x.micro) >= 1_000_000n && BigInt(x.micro) <= 100_000_000_000n)
    .sort((a, b) => b.block - a.block);
  return cands[0] || null;
}

(async () => {
  console.log('BIII E2E — verify a REAL on-chain USDC payment on Base (network-gated):');
  let seed = null;
  try { seed = await aRecentTransfer(); }
  catch (e) { skipped = true; console.log('  ⊘ RPC unreachable / rate-limited (' + (e && e.message) + ') — E2E skipped (offline-safe)'); }
  if (!skipped && !seed) { skipped = true; console.log('  ⊘ no clean recent transfer in the sampled window — E2E skipped this run'); }

  if (!skipped) {
    await t('the chain watcher + verifyPayment stamp a real USDC transfer as PAID (real RPC, real tx)', async () => {
      // treat the real recipient as the merchant; a real transfer to it ≥ the amount must verify.
      const fact = await findPayment({ to: seed.to, minMicro: seed.micro, lookbackBlocks: 30 });
      assert.ok(fact, 'a real transfer to ' + seed.to + ' (≥ ' + seed.micro + ' micro) should be found on-chain');
      assert.match(String(fact.txHash), /^0x[0-9a-fA-F]{64}$/, 'a real 32-byte txHash');
      assert.equal(fact.to, seed.to, 'the fact is the transfer to OUR recipient (topic[2] re-verified)');
      assert.equal(fact.token, USDC, 'stamped as USDC');
      assert.ok(fact.confirmations >= 1, 'at least 1 confirmation');
      assert.ok(BigInt(fact.valueMicro) >= BigInt(seed.micro), 'value covers the charge');

      const charge = { to: seed.to, amountMicro: seed.micro, amountUsd: T.microToUsd(seed.micro), token: USDC, chainId: 8453 };
      const verdict = T.verifyPayment(charge, fact);
      assert.equal(verdict.paid, true, 'the real transfer verifies as PAID');
      const receipt = T.receipt(charge, verdict, { merchantName: 'E2E' });
      assert.ok(receipt.explorer.includes('basescan.org/tx/' + fact.txHash), 're-verifiable receipt anchored to the real tx');
    });

    await t('a charge NOT paid on-chain reads UNPAID against the real chain (no false-PAID)', async () => {
      // a random fresh address that never received this amount → null → not paid
      const empty = '0x' + '1234abcd'.repeat(5);
      const fact = await findPayment({ to: empty, minMicro: '999999999999', lookbackBlocks: 5 });
      const verdict = T.verifyPayment({ to: empty, amountMicro: '999999999999', token: USDC, chainId: 8453 }, fact);
      assert.equal(verdict.paid, false, 'an unpaid charge is never PAID, even against the real chain');
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skipped ? ' (E2E skipped — no network)' : ''));
  process.exit(fail ? 1 : 0);
})();
