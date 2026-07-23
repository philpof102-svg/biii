'use strict';
const { checkHoldersHealth, computeHealthMetrics } = require('../lib/holders-health');

// Mock fetch for testing
async function mockFetch(url, options) {
  const body = JSON.parse(options.body);
  const method = body.method;

  if (method === 'eth_blockNumber') {
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1234567' })
    };
  }

  if (method === 'eth_getLogs') {
    // Mock transfer events for a fake token
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: [
          {
            address: '0xfakeTokenAddress',
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000000000000000000000000000000000000000000000',
              '0x0000000000000000000000001234567890123456789012345678901234567890'
            ],
            data: '0x' + (1000e18).toString(16).padStart(64, '0'),
            blockNumber: '0x1234560'
          },
          {
            address: '0xfakeTokenAddress',
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000001234567890123456789012345678901234567890',
              '0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd'
            ],
            data: '0x' + (500e18).toString(16).padStart(64, '0'),
            blockNumber: '0x1234561'
          }
        ]
      })
    };
  }

  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
}

async function testHealthCheck() {
  console.log('Testing holders-health...');

  // Test computeHealthMetrics
  const metrics = computeHealthMetrics([
    { from: '0x0', to: '0x123...', value: 1000n, blockNumber: 1 },
    { from: '0x123...', to: '0xabc...', value: 500n, blockNumber: 2 }
  ]);
  console.log('Metrics:', metrics);

  // Test checkHoldersHealth with mock
  const result = await checkHoldersHealth('0xfakeTokenAddress', { fetchImpl: mockFetch });
  console.log('Health check result:', result);

  console.log('✓ holders-health tests passed');
  process.exit(0);
}

testHealthCheck().catch((e) => {
  console.error('✗ holders-health test failed:', e.message);
  process.exit(1);
});
