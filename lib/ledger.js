'use strict';
/**
 * BIII ledger — the till roll: human-readable receipts + provable books.
 * =====================================================================
 * Phil's idea (checked: doesn't exist for in-person USDC — Request Network does B2B invoices,
 * explorers show raw txs, but no consumer "here is your receipt" ticket + a merchant's day
 * roll): make a payment something a NON-crypto human instantly understands, AND make the
 * merchant's books PROVABLE. Every receipt is anchored to a txHash, so anyone can re-confirm
 * it on-chain — a receipt that cannot be faked, and a day's sales that cannot be padded.
 *
 * Pure & deterministic: receipts/ledger in, formatted strings + summaries out. Persistence
 * (localStorage in the PWA, or a file/db on a server) is an adapter around this.
 */
const T = require('./till');

const pad2 = (n) => String(n).padStart(2, '0');
/** a stable, human receipt number from the ledger position + the tx (no clock needed). */
const receiptNo = (n) => 'B3-' + String(n).padStart(4, '0');

const HHMM = (blockTimeSec) => {
  if (!blockTimeSec) return '--:--';
  const d = new Date(Number(blockTimeSec) * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
};

/**
 * renderReceipt — the paper-ticket a human reads. Fixed-width, printer/share friendly.
 * receipt = the object from till.receipt(); opts.number = its ledger position.
 */
function renderReceipt(receipt, { number = 1, lang = 'en' } = {}) {
  if (!receipt || receipt.kind !== 'basetill-receipt') throw new Error('renderReceipt needs a verified BIII receipt');
  const L = lang === 'fr'
    ? { paid: 'PAYÉ', amount: 'Montant', tip: 'Pourboire', item: 'Article', when: 'Heure', by: 'Payé par', verify: 'Vérifiable sur', thanks: 'Merci !' }
    : { paid: 'PAID', amount: 'Amount', tip: 'Tip', item: 'Item', when: 'Time', by: 'Paid by', verify: 'Verify on-chain', thanks: 'Thank you!' };
  const merchant = (receipt.merchant && receipt.merchant.name) || 'Merchant';
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
  const tip = BigInt(receipt.overpaidMicro || '0');
  const W = 34, line = '─'.repeat(W);
  const row = (k, v) => `${k}${' '.repeat(Math.max(1, W - k.length - String(v).length))}${v}`;
  const out = [
    center(merchant, W), center(receiptNo(number), W), line,
    receipt.label ? row(L.item + ':', receipt.label) : null,
    row(L.amount + ':', receipt.amountUsd + ' USDC'),
    tip > 0n ? row(L.tip + ':', T.microToUsd(tip.toString()) + ' USDC') : null,
    row(L.when + ':', HHMM(receipt.blockTime)),
    row(L.by + ':', short(receipt.payer)),
    line,
    center(`✓ ${L.paid} · USDC on Base`, W),
    receipt.tier === 'final' ? center('(final)', W) : center('(confirmed)', W),
    line,
    L.verify + ':', receipt.explorer || short(receipt.txHash),
    '', center(L.thanks, W), center('via BIII', W),
  ].filter((x) => x !== null);
  return out.join('\n');
}
function center(s, w) { const p = Math.max(0, Math.floor((w - s.length) / 2)); return ' '.repeat(p) + s; }

/**
 * APPEND to the till roll — receipts are append-only (a receipt is never edited or removed;
 * a correction is a new counter-entry, like real accounting). Returns the new rows + entry.
 * A receipt's txHash can appear at most once (a tx pays once) — silent dedup keeps books honest.
 */
function appendReceipt(rows, receipt) {
  const r = Array.isArray(rows) ? rows : [];
  if (!receipt || !receipt.txHash) throw new Error('a ledger entry needs a verified receipt (with a txHash)');
  if (r.some((e) => e.receipt.txHash === receipt.txHash)) return { rows: r, entry: null, duplicate: true };
  const entry = { n: r.length + 1, no: receiptNo(r.length + 1), receipt };
  return { rows: [...r, entry], entry, duplicate: false };
}

/** DAY SUMMARY — the merchant's provable books for a window. Sums in micro (exact), plus USD. */
function summary(rows, { fromBlockTime = 0, toBlockTime = Infinity } = {}) {
  const inWin = (Array.isArray(rows) ? rows : []).filter((e) => {
    const bt = Number(e.receipt.blockTime) || 0;
    return bt >= fromBlockTime && bt <= toBlockTime;
  });
  let gross = 0n, tips = 0n;
  for (const e of inWin) { gross += BigInt(e.receipt.paidMicro || e.receipt.amountMicro || '0'); tips += BigInt(e.receipt.overpaidMicro || '0'); }
  return {
    count: inWin.length,
    grossMicro: gross.toString(), grossUsd: T.microToUsd(gross.toString()),
    tipsMicro: tips.toString(), tipsUsd: T.microToUsd(tips.toString()),
    txHashes: inWin.map((e) => e.receipt.txHash),          // every line re-checkable on-chain
  };
}

/** RE-VERIFY a past ledger entry against a fresh chain fact — books that anyone can audit.
 *  Rebuilds the charge from the receipt and re-runs the field-for-field check. */
function reverify(entry, fact) {
  if (!entry || !entry.receipt) throw new Error('reverify needs a ledger entry');
  const rec = entry.receipt;
  const charge = { to: rec.merchant.address, amountMicro: rec.amountMicro, amountUsd: rec.amountUsd, token: T.USDC_BASE, chainId: T.BASE_CHAIN_ID };
  const v = T.verifyPayment(charge, fact);
  return { ok: v.paid === true && (fact && (fact.txHash || '').toLowerCase() === (rec.txHash || '').toLowerCase()),
    verdict: v, expectedTx: rec.txHash };
}

module.exports = { renderReceipt, appendReceipt, summary, reverify, receiptNo };
