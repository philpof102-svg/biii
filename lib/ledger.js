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
 * brandLine — WHITE-LABEL: the small attribution at the foot of a ticket/roll. A partner ships receipts
 * under their own brand ("via <Partner>"), optionally keeping a "· powered by BIII" tag. This NEVER
 * touches the honest bits — the ✓ PAID·USDC·on-Base line and the non-custodial disclosure stay, because
 * they are facts, not branding. `brand` = string | { name, poweredBy? }; absent ⇒ "via BIII" (default).
 */
function brandLine(brand) {
  if (!brand) return 'via BIII';
  const name = (typeof brand === 'string' ? brand : String((brand && brand.name) || '')).slice(0, 28).trim();
  if (!name) return 'via BIII';
  return 'via ' + name + (brand && brand.poweredBy ? ' · powered by BIII' : '');
}

/**
 * renderReceipt — the paper-ticket a human reads. Fixed-width, printer/share friendly.
 * receipt = the object from till.receipt(); opts.number = its ledger position; opts.brand = white-label.
 */
function renderReceipt(receipt, { number = 1, lang = 'en', brand } = {}) {
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
    '', center(L.thanks, W), center(brandLine(brand), W),
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
  const h = String(receipt.txHash || '').toLowerCase();   // case-insensitive, matching reverify() — a tx
  if (r.some((e) => String(e.receipt.txHash || '').toLowerCase() === h)) return { rows: r, entry: null, duplicate: true }; // in mixed casing must not double-count
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

/**
 * PORTABLE PROVABLE BOOKS — the shareable till roll an EXCLUDED merchant/agent can hand to anyone.
 * When they left Stripe/PayPal they lost the settlement statement + the dispute trail; an irreversible
 * crypto rail gives neither. This is the substitute: a plain statement where EVERY line carries its own
 * on-chain txHash + explorer link, so the reader re-verifies each one against Base themselves — trust no
 * one, not even the merchant, not even BIII. Pure/deterministic; the reader supplies the chain facts.
 */
function renderRoll(rows, { merchantName = 'Merchant', lang = 'en', window, brand } = {}) {
  const s = summary(rows, window || {});
  const inWin = (Array.isArray(rows) ? rows : []).filter((e) => {
    const bt = Number(e.receipt.blockTime) || 0;
    return bt >= ((window && window.fromBlockTime) || 0) && bt <= ((window && window.toBlockTime) || Infinity);
  });
  const L = lang === 'fr'
    ? { roll: 'REGISTRE DE CAISSE — PROUVABLE', line: 'Reçu', amt: 'Montant', when: 'Heure', tx: 'Tx', gross: 'Total', tips: 'Pourboires', n: 'Reçus', foot: 'Re-vérifiez CHAQUE ligne sur Base — ne faites confiance à personne. Non-custodial : BIII ne détient aucun fonds.' }
    : { roll: 'PROVABLE TILL ROLL', line: 'Receipt', amt: 'Amount', when: 'Time', tx: 'Tx', gross: 'Gross', tips: 'Tips', n: 'Receipts', foot: 'Re-verify EVERY line on Base — trust no one. Non-custodial: BIII holds no funds.' };
  const short = (a) => a ? String(a).slice(0, 10) + '…' + String(a).slice(-6) : '—';
  const lines = inWin.map((e) => `  ${e.no}  ${String(e.receipt.amountUsd + ' USDC').padEnd(12)} ${HHMM(e.receipt.blockTime).padEnd(10)} ${short(e.receipt.txHash)}`);
  return [
    merchantName, L.roll,
    // WHITE-LABEL: a partner's brand sits in the header; the non-custodial disclosure (L.foot) is a FACT
    // and stays whatever the brand — white-labeling never edits the honesty line.
    ...(brand ? [brandLine(brand)] : []), '',
    `${L.n}: ${s.count}   ${L.gross}: ${s.grossUsd} USDC   ${L.tips}: ${s.tipsUsd} USDC`, '',
    ...lines, '',
    L.foot,
  ].join('\n');
}

/**
 * RE-VERIFY the WHOLE roll against fresh chain facts — the "books anyone can audit" made batch.
 * facts: a Map<txHashLower, fact>, or a function (txHash) => fact | null. Returns a per-line result and
 * the honest headline: allVerified only if EVERY line re-checks field-for-field on Base (fail-closed —
 * a missing/mismatched fact fails that line, never passes it).
 */
function reverifyRoll(rows, facts) {
  const getFact = typeof facts === 'function'
    ? facts
    : (h) => { const m = facts; const k = String(h || '').toLowerCase(); return m && (typeof m.get === 'function' ? m.get(k) : m[k]) || null; };
  const results = (Array.isArray(rows) ? rows : []).map((entry) => {
    const h = entry && entry.receipt && entry.receipt.txHash;
    const r = reverify(entry, getFact(h));
    return { no: entry.no, txHash: h, ok: r.ok, verdict: r.verdict };
  });
  const verified = results.filter((r) => r.ok).length;
  return { total: results.length, verified, allVerified: results.length > 0 && verified === results.length, results };
}

module.exports = { renderReceipt, appendReceipt, summary, reverify, reverifyRoll, renderRoll, brandLine, receiptNo };
