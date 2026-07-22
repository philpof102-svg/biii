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

async function rpc(url, method, params, f, timeoutMs = 8000) {
  // BOUND the outbound call: a free public RPC that accepts the connection but stalls (rate-limited/overloaded)
  // would otherwise hang /status forever — the PWA polls every 3s, so hung requests pile up instead of the
  // intended fast, honest 502 degrade. Mirrors the AbortSignal.timeout(8000) used in bin/biii-mcp.js.
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
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
async function findPayment({ to, minMicro = '0', fromBlock, lookbackBlocks = 900, excludeTxHashes,
  rpcUrl = process.env.BASE_RPC_URL || DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw new Error('findPayment needs the merchant address');
  // txHashes already applied to ANOTHER charge — so one on-chain transfer can satisfy at most one charge
  // (the two-register / cross-charge false-PAID guard; the server owns this set). Newest UNCONSUMED wins.
  const skip = excludeTxHashes instanceof Set ? excludeTxHashes
    : new Set((excludeTxHashes || []).map((h) => String(h).toLowerCase()));
  const head = BigInt(await rpc(rpcUrl, 'eth_blockNumber', [], f));
  const from = fromBlock != null ? BigInt(fromBlock) : (head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n);
  const logs = await rpc(rpcUrl, 'eth_getLogs', [{
    address: USDC_BASE, fromBlock: hex(from), toBlock: 'latest',
    topics: [TRANSFER_TOPIC, null, addrTopic(to)],               // Transfer(*, to=merchant)
  }], f);
  let best = null;
  const want = BigInt(String(minMicro || '0'));
  const toLc = String(to).toLowerCase();
  for (const log of logs || []) {
    try {
      if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;  // malformed log — skip
      // VERIFY the log's OWN contract (log.address) is USDC — never trust the RPC's `address` filter alone.
      // A misfiltering/hostile RPC returning a Transfer from a SCAM token (same event signature) to the
      // merchant must NOT be stamped as a USDC payment (the fact hardcodes token:USDC_BASE below).
      if (String(log.address || '').toLowerCase() !== USDC_BASE) continue;
      // VERIFY the log's OWN recipient (topic[2]) — never trust the RPC's topic filter alone. A misfiltering
      // or hostile RPC returning a Transfer to a DIFFERENT address must NOT be stamped as paid-to-merchant.
      const logTo = ('0x' + String(log.topics[2]).slice(26)).toLowerCase();
      if (logTo !== toLc) continue;
      if (skip.has(String(log.transactionHash || '').toLowerCase())) continue;   // already applied to another charge
      const valueMicro = BigInt(log.data).toString();               // malformed data → throws → caught → skip
      if (BigInt(valueMicro) < want) continue;                      // too small for this charge
      const bn = BigInt(log.blockNumber);
      const fact = {
        txHash: log.transactionHash, chainId: 8453, token: USDC_BASE,
        to: logTo, from: ('0x' + String(log.topics[1]).slice(26)).toLowerCase(),
        valueMicro, blockNumber: Number(bn),
        confirmations: Number(head - bn + 1n),
      };
      if (!best || bn > BigInt(best.blockNumber)) best = fact;     // newest matching transfer wins
    } catch { /* one malformed log can neither crash the poll nor forge a fact */ }
  }
  return best;
}

module.exports = { findPayment, TRANSFER_TOPIC, DEFAULT_RPC };
