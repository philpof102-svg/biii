'use strict';
/**
 * basetill chain watcher — turns the Base chain into the till's source of truth.
 * =============================================================================
 * One job: find the USDC Transfer that pays a charge, as an immutable FACT the core can
 * verify (lib/till.verifyPayment stays the only judge). Injectable fetch, no key, read-only.
 * RPC discipline from the mainstreet indexer war: default to mainnet.base.org, tolerate
 * rate limits by narrowing ranges, never trust a fact below the requested confirmations.
 */
const { USDC_BASE } = require('./till');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';

const hex = (n) => '0x' + BigInt(n).toString(16);
const addrTopic = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().slice(2);

async function rpc(url, method, params, f) {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * Look once for a Transfer of ≥ minMicro USDC to `to` since `fromBlock` (or the last ~N
 * blocks). Returns the BEST fact ({txHash, chainId, token, to, from, valueMicro,
 * confirmations, blockNumber}) or null. The caller re-polls; we never invent.
 */
async function findPayment({ to, minMicro = '0', fromBlock, lookbackBlocks = 900,
  rpcUrl = process.env.BASE_RPC_URL || DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw new Error('findPayment needs the merchant address');
  const head = BigInt(await rpc(rpcUrl, 'eth_blockNumber', [], f));
  const from = fromBlock != null ? BigInt(fromBlock) : (head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n);
  const logs = await rpc(rpcUrl, 'eth_getLogs', [{
    address: USDC_BASE, fromBlock: hex(from), toBlock: 'latest',
    topics: [TRANSFER_TOPIC, null, addrTopic(to)],               // Transfer(*, to=merchant)
  }], f);
  let best = null;
  for (const log of logs || []) {
    const valueMicro = BigInt(log.data).toString();
    if (BigInt(valueMicro) < BigInt(String(minMicro))) continue; // too small for this charge
    const bn = BigInt(log.blockNumber);
    const fact = {
      txHash: log.transactionHash, chainId: 8453, token: USDC_BASE,
      to: String(to).toLowerCase(), from: '0x' + log.topics[1].slice(26),
      valueMicro, blockNumber: Number(bn),
      confirmations: Number(head - bn + 1n),
    };
    if (!best || bn > BigInt(best.blockNumber)) best = fact;     // newest matching transfer wins
  }
  return best;
}

module.exports = { findPayment, TRANSFER_TOPIC, DEFAULT_RPC };
