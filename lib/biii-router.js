'use strict';
/**
 * biii-router.js — BIII safe-to-pay router using USDC transfer log filter
 * ======================================================================
 * Routes BIII calls ONLY to addresses with >$1k daily settlement (strategist idea).
 * Uses lib/usdc-filter.js to track daily volumes from Base RPC eth_getLogs.
 *
 * Integration: call shouldRoute(payeeAddress) before processing a BIII payment.
 * If returns false, the address is not an active payee → reject or flag.
 */

const { isActivePayee, scanTransfers, getActivePayees } = require('./usdc-filter');
const { USDC_BASE } = require('./till');

const DEFAULT_RPC = 'https://mainnet.base.org';
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let scanRunning = false;
let lastScan = 0;

/**
 * Check if a payee address should be routed (has >$1k daily USDC volume)
 * @param {string} address - Payee address to check
 * @returns {boolean} true if safe to pay, false otherwise
 */
function shouldRoute(address) {
  if (!address || typeof address !== 'string') return false;
  return isActivePayee(address);
}

/**
 * Get all active payees (addresses with >$1k daily volume)
 * @returns {Array} List of { address, volume, blocks }
 */
function getActivePayeesList() {
  return getActivePayees();
}

/**
 * Background scan of recent USDC transfers to update daily volumes
 * Call this periodically (every 30 min) to keep the router fresh.
 * @param {object} options - { rpcUrl, fetchImpl }
 */
async function backgroundScan(options = {}) {
  if (scanRunning) return;
  scanRunning = true;

  try {
    const rpcUrl = options.rpcUrl || DEFAULT_RPC;
    const f = options.fetchImpl || fetch;

    // Get current block number
    const headResp = await f(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(8000)
    });
    if (!headResp.ok) throw new Error(`Failed to get block number: HTTP ${headResp.status}`);
    const headJson = await headResp.json();
    if (headJson.error) throw new Error(`eth_blockNumber: ${headJson.error.message}`);
    const head = parseInt(headJson.result, 16);

    const fromBlock = '0x' + Math.max(0, head - 900).toString(16); // ~3 hours
    const toBlock = '0x' + head.toString(16);

    const count = await scanTransfers({ fromBlock, toBlock, rpcUrl, fetchImpl: f });
    lastScan = Date.now();
    console.log(`[biii-router] Scanned ${count} USDC transfers, ${getActivePayeesList().length} active payees`);
  } catch (err) {
    console.error('[biii-router] Background scan failed:', err.message);
  } finally {
    scanRunning = false;
  }
}

/**
 * Start the background scanner (call once when server starts)
 * @param {object} options - { rpcUrl, fetchImpl, intervalMs }
 */
function startBackgroundScan(options = {}) {
  const intervalMs = options.intervalMs || SCAN_INTERVAL_MS;

  // Initial scan
  backgroundScan(options);

  // Periodic scan
  setInterval(() => {
    backgroundScan(options);
  }, intervalMs);

  console.log(`[biii-router] Background scanner started (interval: ${intervalMs / 60000} min)`);
}

module.exports = {
  shouldRoute,
  getActivePayeesList,
  backgroundScan,
  startBackgroundScan
};
