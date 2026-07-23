'use strict';
const { scanTransfers, isActivePayee, getActivePayees, resetDailyVolumes } = require('../lib/usdc-filter');

// Mock fetch for testing
async function mockFetch(url, options) {
  const body = JSON.parse(options.body);
  const method = body.method;

  if (method === 'eth_getLogs') {
    // Return mock USDC transfer logs
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: [
          {
            address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000000000000000000000000000000000000000000000',
              '0x0000000000000000000000001234567890123456789012345678901234567890'
            ],
            data: '0x' + (1000e6).toString(16).padStart(64, '0'), // 1000 USDC
            transactionHash: '0xtest123',
            blockNumber: '0x1234567'
          }
        ]
      })
    };
  }

  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1234567' }) };
}

async function testScanTransfers() {
  resetDailyVolumes();
  const count = await scanTransfers({
    fromBlock: '0x1234560',
    toBlock: '0x1234567',
    fetchImpl: mockFetch
  });
  console.log('scanTransfers returned:', count);

  const isActive = isActivePayee('0x1234567890123456789012345678901234567890');
  console.log('isActivePayee (1000 USDC):', isActive); // Should be false (< $1k)

  const active = getActivePayees();
  console.log('Active payees:', active);
}

testScanTransfers().then(() => {
  console.log('✓ usdc-filter tests passed');
  process.exit(0);
}).catch((e) => {
  console.error('✗ usdc-filter test failed:', e.message);
  process.exit(1);
});
