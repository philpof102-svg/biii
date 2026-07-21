'use strict';
// BIII MCP — till_roll (provable books surfaced to an agent). Offline. Run: node test/mcp-roll.test.js
const assert = require('node:assert');
const { callTool, TOOLS } = require('../bin/biii-mcp');
const T = require('../lib/till');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const M = '0x' + 'ab'.repeat(20);
// a verified receipt the way an agent-merchant would produce one: charge → verify a chain fact → receipt
function mkReceipt(txHash, usd) {
  const charge = T.createCharge({ to: M, amountUsd: usd, nowMs: 1 });
  const fact = { txHash, chainId: 8453, token: T.USDC_BASE, to: M, valueMicro: charge.amountMicro, confirmations: 20, blockTime: 1700000000, from: '0x' + 'ee'.repeat(20) };
  return T.receipt(charge, T.verifyPayment(charge, fact), { merchantName: 'Agent IA #42' });
}

(async () => {
  console.log('BIII MCP — till_roll (provable books, re-verify on Base yourself):');

  await t('till_roll is a declared tool with an honest, non-custodial description', () => {
    const tool = TOOLS.find((x) => x.name === 'till_roll');
    assert.ok(tool, 'till_roll present in TOOLS');
    assert.match(tool.description, /trust no one/i);
    assert.match(tool.description, /non-custodial/i);
    assert.deepEqual(tool.inputSchema.required, ['receipts']);
  });

  await t('renders the provable statement + per-line txHashes + carries the disclaimer', async () => {
    const r = await callTool('till_roll', { receipts: [mkReceipt('0x' + '11'.repeat(32), '4.50'), mkReceipt('0x' + '22'.repeat(32), '3.00')], merchantName: 'Agent IA #42' });
    assert.match(r.statement, /PROVABLE TILL ROLL/);
    assert.match(r.statement, /trust no one/i);
    assert.equal(r.summary.count, 2);
    assert.equal(r.summary.grossUsd, '7.50');
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines.every((l) => /^0x[0-9a-f]{64}$/.test(l.txHash) && l.explorer.includes('basescan.org/tx/')));
    assert.match(r.note, /Re-verify EVERY txHash/);
    assert.match(r.note, /Non-custodial/);   // the RC's DISCLAIMER is carried through
  });

  await t('dedups a repeated txHash (honest books) and tolerates junk receipts', async () => {
    const rec = mkReceipt('0x' + '11'.repeat(32), '4.50');
    const r = await callTool('till_roll', { receipts: [rec, rec, { no: 'txHash-missing' }, null] });
    assert.equal(r.summary.count, 1, 'the same tx counts once; a receipt with no txHash is dropped, not crashed');
  });

  await t('an empty roll is honest (count 0), never invented', async () => {
    const r = await callTool('till_roll', { receipts: [] });
    assert.equal(r.summary.count, 0);
    assert.equal(r.lines.length, 0);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
