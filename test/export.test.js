'use strict';
// BIII accounting export — the accountant-ready CSV finance teams need. Pure + offline.
// Run: node test/export.test.js
const assert = require('node:assert');
const { toCsv, buildExport, csvField, COLUMNS, normalizeRows } = require('../lib/export');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// a verified receipt, as till.receipt() produces
const rcpt = (over = {}) => ({
  v: 1, kind: 'basetill-receipt',
  merchant: { name: 'Café Central', address: '0x' + 'a'.repeat(40) },
  label: 'flat white', orderId: 'ord-7',
  amountUsd: '4.50', amountMicro: '4500000',
  paidMicro: '5000000', overpaidMicro: '500000',
  token: 'USDC', chainId: 8453,
  txHash: '0x' + '1'.repeat(64), payer: '0x' + 'b'.repeat(40), tier: 'exact',
  blockTime: 1_752_000_000, // a fixed unix ts
  explorer: 'https://basescan.org/tx/0x' + '1'.repeat(64),
});

console.log('BIII accounting export (accountant-ready, re-verifiable CSV):');

t('CSV has the fixed header + one settled line per receipt, with the right amounts', () => {
  const csv = toCsv([{ no: 'R-0001', receipt: rcpt() }]);
  const [header, row] = csv.trimEnd().split('\r\n');
  assert.equal(header, COLUMNS.join(','));
  const cells = row.split(',');
  const col = (name) => cells[COLUMNS.indexOf(name)];
  assert.equal(col('gross_usdc'), '5.00', 'gross = what actually arrived (paidMicro)');
  assert.equal(col('tip_usdc'), '0.50', 'tip = overpay');
  assert.equal(col('charged_usdc'), '4.50', 'charged = requested');
  assert.equal(col('token'), 'USDC');
  assert.equal(col('date'), '2025-07-08', 'settlement date from blockTime');
  assert.equal(col('status'), 'settled');
});

t('EVERY row is re-verifiable: it carries its txHash + Basescan link (the non-custodial moat)', () => {
  const csv = toCsv([{ no: 'R-0001', receipt: rcpt() }]);
  const row = csv.trimEnd().split('\r\n')[1].split(',');
  assert.equal(row[COLUMNS.indexOf('tx_hash')], '0x' + '1'.repeat(64));
  assert.equal(row[COLUMNS.indexOf('basescan_url')], 'https://basescan.org/tx/0x' + '1'.repeat(64));
});

t('RFC-4180: a field with a comma/quote/newline is quoted and inner quotes doubled', () => {
  assert.equal(csvField('flat, white'), '"flat, white"');
  assert.equal(csvField('the "best" coffee'), '"the ""best"" coffee"');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('plain'), 'plain');
  // and it holds end-to-end: a comma in the label doesn't break the column count
  const csv = toCsv([{ no: 'R1', receipt: rcpt({}) && Object.assign(rcpt(), { label: 'flat, white' }) }]);
  const row = csv.trimEnd().split('\r\n')[1];
  assert.ok(row.includes('"flat, white"'), 'comma label is quoted');
});

t('dedup by txHash — a tx pays once, so it books once (matches the provable till roll)', () => {
  const r = rcpt();
  const csv = toCsv([{ receipt: r }, { receipt: r }, { receipt: Object.assign(rcpt(), { txHash: '0x' + '2'.repeat(64) }) }]);
  const dataRows = csv.trimEnd().split('\r\n').length - 1; // minus header
  assert.equal(dataRows, 2, 'the repeated txHash is not double-counted');
});

t('window filters by on-chain blockTime (same semantics as the provable books)', () => {
  const early = Object.assign(rcpt(), { txHash: '0x' + '3'.repeat(64), blockTime: 1000 });
  const late = Object.assign(rcpt(), { txHash: '0x' + '4'.repeat(64), blockTime: 9_999_999_999 });
  const csv = toCsv([{ receipt: early }, { receipt: late }], { window: { fromBlockTime: 5000 } });
  const rows = csv.trimEnd().split('\r\n');
  assert.equal(rows.length - 1, 1, 'only the in-window receipt is exported');
});

t('accepts raw receipts OR ledger rows; empty input → header-only CSV', () => {
  assert.equal(normalizeRows([rcpt()]).length, 1, 'raw receipt normalized');
  assert.equal(normalizeRows([{ no: 'R1', receipt: rcpt() }]).length, 1, 'ledger row normalized');
  assert.equal(normalizeRows([{ junk: true }, null, {}]).length, 0, 'garbage without a txHash is dropped');
  const empty = toCsv([]);
  assert.equal(empty.trimEnd(), COLUMNS.join(','), 'empty books = header only, honest count 0');
});

t('buildExport bundles csv + re-checkable totals + non-custodial disclosure + a brandable filename', () => {
  const ex = buildExport([{ receipt: rcpt() }], { brand: 'Kev Pay' });
  assert.equal(ex.format, 'csv');
  assert.deepStrictEqual(ex.columns, COLUMNS);
  assert.equal(ex.summary.count, 1);
  assert.equal(ex.summary.grossUsd, '5.00');
  assert.equal(ex.summary.tipsUsd, '0.50');
  assert.equal(ex.summary.txHashes.length, 1, 'totals carry the txHashes (re-checkable)');
  assert.ok(/non-custodial/i.test(ex.disclosure) && /re-verify/i.test(ex.disclosure), 'discloses the discipline');
  assert.ok(/quickbooks|xero|excel/i.test(ex.disclosure), 'names the tools it imports into');
  assert.equal(ex.filename, 'kev-pay-biii-books.csv', 'white-label brand slugs the filename');
  assert.equal(buildExport([{ receipt: rcpt() }]).filename, 'biii-books.csv', 'default filename with no brand');
});

// ── MCP wiring: till_export is a declared tool and callTool returns the export ──────────────────
const { callTool, TOOLS } = require('../bin/biii-mcp.js');
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

(async () => {
  await tA('till_export is a declared MCP tool, honest + non-custodial in its description', async () => {
    const tool = TOOLS.find((x) => x.name === 'till_export');
    assert.ok(tool, 'till_export declared');
    assert.ok(/accountant|quickbooks|xero/i.test(tool.description), 'names the accounting job');
    assert.ok(/non-custodial|re-verif/i.test(tool.description), 'keeps the discipline in the copy');
    assert.deepStrictEqual(tool.inputSchema.required, ['receipts']);
  });

  await tA('callTool(till_export) folds receipts → CSV + summary + disclosure (dedup honored)', async () => {
    const out = await callTool('till_export', { receipts: [rcpt(), rcpt(), Object.assign(rcpt(), { txHash: '0x' + '9'.repeat(64) })] });
    assert.equal(out.format, 'csv');
    assert.ok(out.csv.startsWith(COLUMNS.join(',')), 'CSV starts with the header');
    assert.equal(out.summary.count, 2, 'the repeated txHash is deduped');
    assert.ok(/basescan/i.test(out.csv), 'rows carry the re-verify link');
    assert.ok(/quickbooks|xero|excel/i.test(out.note));
    const empty = await callTool('till_export', { receipts: [] });
    assert.equal(empty.summary.count, 0, 'empty books = honest count 0');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
