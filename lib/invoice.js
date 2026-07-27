'use strict';
/**
 * BIII invoice — the SAME registry, now for classic Web2-style invoices.
 * =====================================================================
 * Phil's product insight (2026-07-21): the sellable thing is the REGISTRY that wires into any
 * merchant — and the very same registry should handle a normal Web2 invoice "avec la même
 * facilité". So an invoice here is NOT a new payment system. It is a charge with a human bill on
 * top: an invoice number, issue/due dates, line items, a bill-to — that is
 *   • paid by the EXACT same EIP-681 intent            (invoiceURI === till.paymentURI)
 *   • verified the EXACT same field-for-field way       (verifyInvoice === till.verifyPayment)
 *   • recorded in the EXACT same provable till roll      (invoiceReceipt is a ledger entry)
 *   • judged by the EXACT same trust triangle            (its verdict feeds assessTriangle)
 *
 * Competitors (researched, see COMPETITION.md): Request Finance / Stripe own crypto+Web2 invoicing
 * but on CENTRALISED books you must trust and (Stripe) custodially. BIII's difference is that the
 * invoice's proof is the on-chain tx anyone can re-check, and it is non-custodial. We do NOT rebuild
 * their AP/AR suite — we are the trust+registry layer under it, and we export to the same books.
 *
 * Pure & deterministic like the rest of lib/: dates are INJECTED (issueDateMs/dueDateMs/nowMs), the
 * caller owns the clock. No key, no funds, no network here.
 */
const T = require('./till');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/**
 * Normalise one line item to exact micro. Accepts either:
 *   { description, amountUsd }                         → a flat line
 *   { description, qty, unitUsd }                      → qty × unit
 * Returns { description, qty, unitMicro, amountMicro, amountUsd }.
 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') throw new Error('each line item must be an object');
  const description = clip(it.description || it.desc || it.label, 80) || 'Item';
  if (it.qty != null || it.unitUsd != null) {
    const qty = Number(it.qty == null ? 1 : it.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`line "${description}": qty must be a positive integer`);
    const unitMicro = BigInt(T.usdToMicro(it.unitUsd));
    const amountMicro = (unitMicro * BigInt(qty)).toString();
    return { description, qty, unitMicro: unitMicro.toString(), amountMicro, amountUsd: T.microToUsd(amountMicro) };
  }
  const amountMicro = T.usdToMicro(it.amountUsd); // throws on bad input — fail-closed like the core
  return { description, qty: 1, unitMicro: amountMicro, amountMicro, amountUsd: T.microToUsd(amountMicro) };
}

/**
 * createInvoice — a Web2 bill over a non-custodial BIII charge.
 * { to, lineItems[], number?, issueDateMs?, dueDateMs?, billTo?, merchantName?, orderId?, nowMs? }
 * The total is the exact micro sum of the line items; the underlying charge is what actually gets paid.
 */
function createInvoice({ to, lineItems, number, issueDateMs, dueDateMs, billTo, merchantName, orderId, nowMs } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw new Error('an invoice needs at least one line item');
  const items = lineItems.map(normalizeItem);
  const totalMicro = items.reduce((s, it) => s + BigInt(it.amountMicro), 0n).toString();
  const at = Number(nowMs) || null;
  // reuse the core charge — non-custodial by construction, same money math, same rail
  const charge = T.createCharge({ to, amountMicro: totalMicro, label: 'Invoice ' + (number || ''), orderId, nowMs: at });
  const num = clip(number, 40) || ('INV-' + (at || 0).toString(36).toUpperCase().slice(-6).padStart(6, '0'));
  return {
    v: 1, kind: 'biii-invoice', number: num,
    issueDateMs: Number(issueDateMs) || at || null,
    dueDateMs: Number(dueDateMs) || null,
    billTo: clip(billTo, 80) || null,
    merchant: { name: clip(merchantName, 60) || null, address: charge.to },
    lineItems: items,
    totalMicro, totalUsd: charge.amountUsd,
    token: 'USDC', chainId: T.BASE_CHAIN_ID,
    charge,               // the thing actually paid (EIP-681 target)
    status: 'issued',
  };
}

/** The universal QR — the SAME EIP-681 intent as any BIII charge (every major wallet scans it). */
function invoiceURI(invoice) {
  if (!invoice || !invoice.charge) throw new Error('invoiceURI needs an invoice');
  return T.paymentURI(invoice.charge);
}

/** VERIFY — delegates to the one function allowed to say "paid": the chain decides, field-for-field. */
function verifyInvoice(invoice, fact) {
  if (!invoice || !invoice.charge) throw new Error('verifyInvoice needs an invoice');
  return T.verifyPayment(invoice.charge, fact);
}

/** Le seul rail que BIII sache LIRE. Tout le reste doit venir des livres du commercant. */
const WITNESSABLE_RAILS = new Set(['base', 'usdc-base', 'base-usdc']);

/**
 * STATUS lifecycle — issued → (overdue if past due & unpaid) → settled when the chain confirms.
 * verdict = verifyInvoice() | null; nowMs injected so this stays pure/testable.
 *
 * ═══ « OVERDUE — PAST DUE, UNPAID » ETAIT UNE ACCUSATION, PAS UN CONSTAT ═══
 * Mesure du 2026-07-27: une facture Web2 reglee PAR CARTE, echue depuis deux jours, ressortait en
 * `overdue / past due, unpaid`. Le client avait paye. BIII avait simplement regarde Base, n'y avait rien
 * vu — et a declare un impaye.
 *
 * C'est la faute la plus lourde de cette famille dans tout le produit, parce que la sortie n'est pas un
 * score: c'est une phrase sur une PERSONNE, dans un outil dont la forme annoncee est « en personne +
 * factures Web2 + agents ». Une facture reglee en especes, par virement ou par carte n'apparaitra jamais
 * sur Base; l'absence de trace n'y est pas une information sur le client.
 *
 * `not_observable` dit la seule chose vraie: cette facture se regle sur un rail que BIII ne sait pas
 * lire, donc son etat de paiement doit venir des livres du commercant. Ce n'est ni « payee » ni
 * « impayee » — c'est hors de notre vue.
 *
 * FAIL-CLOSED SUR LE NOM DU RAIL, comme dans till_trust: seuls les rails qu'on sait lire prennent le
 * chemin on-chain. Se tromper dans ce sens fait dire « je ne peux pas voir »; dans l'autre, ca produit
 * l'accusation qu'on vient de retirer.
 */
function invoiceStatus(invoice, verdict, nowMs) {
  if (verdict && verdict.paid === true) return { status: 'settled', tier: verdict.tier, txHash: verdict.txHash || null };

  const rail = invoice && invoice.rail != null && invoice.rail !== ''
    ? String(invoice.rail).trim().toLowerCase() : null;
  if (rail && !WITNESSABLE_RAILS.has(rail)) {
    return { status: 'not_observable', rail,
      reason: 'this invoice settles on a rail BIII cannot read (' + rail + '), so its payment state must '
        + 'come from the merchant\'s own records. NOT "unpaid": the absence of an on-chain transfer says '
        + 'nothing about a customer who paid by card, transfer or cash.' };
  }

  const now = Number(nowMs) || null;
  if (invoice.dueDateMs && now && now > invoice.dueDateMs) return { status: 'overdue', reason: 'past due, unpaid' };
  return { status: 'issued', reason: verdict ? verdict.reason || 'unpaid' : 'unpaid' };
}

/**
 * invoiceReceipt — the receipt for a PAID invoice. It is a normal `basetill-receipt` (so the same
 * ledger.appendReceipt / summary / renderReceipt work on it unchanged), plus the invoice fields.
 * That is the whole point: an invoice receipt and a café receipt live in ONE provable till roll.
 */
function invoiceReceipt(invoice, verdict, { merchantName } = {}) {
  const base = T.receipt(invoice.charge, verdict, { merchantName: merchantName || (invoice.merchant && invoice.merchant.name) });
  return {
    ...base,
    invoiceNumber: invoice.number,
    billTo: invoice.billTo || null,
    dueDateMs: invoice.dueDateMs || null,
    lineItems: invoice.lineItems,
  };
}

/**
 * renderInvoice — the human-readable BILL (before payment), EN/FR, fixed-width like the receipt.
 * A non-crypto customer reads line items + total + how to pay (scan the EIP-681). Mirrors the till roll.
 */
function renderInvoice(invoice, { lang = 'en' } = {}) {
  if (!invoice || invoice.kind !== 'biii-invoice') throw new Error('renderInvoice needs a BIII invoice');
  const L = lang === 'fr'
    ? { inv: 'FACTURE', from: 'De', to: 'Pour', issued: 'Émise', due: 'Échéance', total: 'TOTAL', pay: 'Payer (scanner ce QR)', net: 'USDC sur Base', foot: 'Réglée quand la chaîne confirme' }
    : { inv: 'INVOICE', from: 'From', to: 'Bill to', issued: 'Issued', due: 'Due', total: 'TOTAL', pay: 'Pay (scan this QR)', net: 'USDC on Base', foot: 'Settled when the chain confirms' };
  const W = 40, line = '─'.repeat(W);
  const date = (ms) => ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '—';
  const row = (k, v) => `${k}${' '.repeat(Math.max(1, W - k.length - String(v).length))}${v}`;
  const merchant = (invoice.merchant && invoice.merchant.name) || (invoice.merchant && invoice.merchant.address) || 'Merchant';
  const itemRow = (it) => {
    const label = it.qty > 1 ? `${it.description} ×${it.qty}` : it.description;
    return row('  ' + clip(label, 26), it.amountUsd);
  };
  const out = [
    center(`${L.inv}  ${invoice.number}`, W), line,
    row(L.from + ':', clip(merchant, 28)),
    invoice.billTo ? row(L.to + ':', clip(invoice.billTo, 28)) : null,
    row(L.issued + ':', date(invoice.issueDateMs)),
    invoice.dueDateMs ? row(L.due + ':', date(invoice.dueDateMs)) : null,
    line,
    ...invoice.lineItems.map(itemRow),
    line,
    row(L.total + ':', invoice.totalUsd + ' USDC'),
    center(L.net, W), line,
    L.pay + ':', invoiceURI(invoice),
    '', center(L.foot, W), center('via BIII', W),
  ].filter((x) => x !== null);
  return out.join('\n');
}
function center(s, w) { const p = Math.max(0, Math.floor((w - s.length) / 2)); return ' '.repeat(p) + s; }

module.exports = { createInvoice, normalizeItem, invoiceURI, verifyInvoice, invoiceStatus, invoiceReceipt, renderInvoice };
