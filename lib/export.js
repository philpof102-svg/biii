'use strict';
/**
 * BIII export — the accounting export finance teams need to adopt (COMPETITION.md: "don't skip
 * accounting export — Request/Stripe win partly because they push journal entries to QuickBooks/Xero").
 * ================================================================================================
 * This turns the provable till roll into an ACCOUNTANT-READY CSV that QuickBooks / Xero / Excel all
 * import. The BIII discipline holds: every row carries its own txHash + Basescan link, so the accountant
 * (or the tax office) RE-VERIFIES each amount on Base themselves — the export is a POINTER to the chain,
 * the only source of truth, never a book you must trust (the moat vs centralized books). Non-custodial:
 * BIII moved no funds; this is a read of chain-anchored receipts. Pure/deterministic, RFC-4180, offline.
 */

const T = require('./till');
const { summary, receiptNo } = require('./ledger');

// The columns, in a fixed order. Amounts are plain decimals (USDC) so a spreadsheet sums them directly;
// gross = what actually arrived, tip = overpay, charged = what was requested. Every row re-verifiable.
const COLUMNS = ['date', 'receipt_no', 'reference', 'description', 'payer',
  'gross_usdc', 'tip_usdc', 'charged_usdc', 'token', 'chain', 'tx_hash', 'basescan_url', 'status'];

// RFC-4180: a field is quoted iff it contains a comma, quote, CR or LF; inner quotes are doubled.
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// settlement date from the on-chain block time (unix seconds) → YYYY-MM-DD; empty if unknown.
function isoDate(blockTime) {
  const t = Number(blockTime) || 0;
  return t > 0 ? new Date(t * 1000).toISOString().slice(0, 10) : '';
}

// Accept EITHER ledger rows [{no, receipt}] OR raw receipts [{txHash,…}]. Dedup by txHash (a tx pays
// once — same honesty as the provable till roll), preserving the ledger's receipt number when present.
function normalizeRows(rows) {
  const seen = new Set();
  const out = [];
  let i = 0;
  for (const e of Array.isArray(rows) ? rows : []) {
    const receipt = e && e.receipt ? e.receipt : e;
    if (!receipt || !receipt.txHash) continue;
    const h = String(receipt.txHash).toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    i += 1;
    out.push({ no: (e && e.no) || receiptNo(i), receipt });
  }
  return out;
}

function inWindow(receipt, window) {
  const bt = Number(receipt.blockTime) || 0;
  return bt >= ((window && window.fromBlockTime) || 0) && bt <= ((window && window.toBlockTime) || Infinity);
}

/** One accounting line (as an object) from a verified receipt + its ledger number. */
function rowFor(no, r) {
  const grossMicro = String(r.paidMicro || r.amountMicro || '0');
  return {
    date: isoDate(r.blockTime),
    receipt_no: no || '',
    reference: r.orderId || '',
    description: r.label || (r.merchant && r.merchant.name) || '',
    payer: r.payer || '',
    gross_usdc: T.microToUsd(grossMicro),
    tip_usdc: T.microToUsd(String(r.overpaidMicro || '0')),
    charged_usdc: T.microToUsd(String(r.amountMicro || grossMicro)),
    token: r.token || 'USDC',
    chain: 'Base(' + (r.chainId || 8453) + ')',
    tx_hash: r.txHash,
    basescan_url: r.explorer || (r.txHash ? 'https://basescan.org/tx/' + r.txHash : ''),
    status: 'settled',
  };
}

/**
 * toCsv — the accountant-ready CSV string (RFC-4180, CRLF line endings, header row + one line per
 * settled receipt in the window). Deterministic; dedup by txHash; window filters by on-chain blockTime.
 */
function toCsv(rows, { window } = {}) {
  const kept = normalizeRows(rows).filter((e) => inWindow(e.receipt, window));
  const header = COLUMNS.join(',');
  const lines = kept.map((e) => COLUMNS.map((c) => csvField(rowFor(e.no, e.receipt)[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * export — the full accounting-export object for the MCP tool / a download: the CSV, the columns, the
 * re-checkable totals (reusing the provable-books summary), and the non-custodial re-verify disclosure.
 */
function buildExport(rows, { window, brand } = {}) {
  const s = summary(normalizeRows(rows), window || {});
  const label = brand ? (typeof brand === 'string' ? brand : brand.name) : null;
  return {
    format: 'csv',
    columns: COLUMNS,
    csv: toCsv(rows, { window }),
    summary: { count: s.count, grossUsd: s.grossUsd, tipsUsd: s.tipsUsd, txHashes: s.txHashes },
    filename: (label ? String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' : '') + 'biii-books.csv',
    disclosure: 'ACCOUNTANT-READY export. Every row carries its txHash + Basescan link — re-verify each '
      + 'amount on Base yourself; this is a pointer to the chain (the only source of truth), not a book to '
      + 'trust. Non-custodial: BIII moved no funds. Imports into QuickBooks / Xero / Excel.',
  };
}

module.exports = { toCsv, buildExport, csvField, COLUMNS, normalizeRows };
