'use strict';
// BIII invoice — the SAME registry for Web2-style bills. Run: node test/invoice.test.js
const assert = require('node:assert');
const T = require('../lib/till');
const I = require('../lib/invoice');
const L = require('../lib/ledger');
const { assessTriangle } = require('../lib/trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const MERCHANT = '0x' + 'ab'.repeat(20);
const NOW = 1753100000000; // injected clock — the core never reads Date.now()
const inv = () => I.createInvoice({
  to: MERCHANT, number: 'INV-2026-041', merchantName: 'Atelier Dupont',
  billTo: 'Acme SARL', issueDateMs: NOW, dueDateMs: NOW + 14 * 86400000,
  lineItems: [
    { description: 'Site vitrine', amountUsd: '1200' },
    { description: 'Maintenance', qty: 3, unitUsd: '90.50' },
  ],
  nowMs: NOW,
});

console.log('BIII invoice — a Web2 bill on the same non-custodial registry:');

t('line items sum EXACTLY in micro (qty × unit, no float drift) and drive the charge', () => {
  const v = inv();
  assert.equal(v.totalMicro, (1200_000000n + 3n * 90_500000n).toString()); // 1471.50
  assert.equal(v.totalUsd, '1471.50');
  assert.equal(v.charge.amountMicro, v.totalMicro);           // the charge IS the invoice total
  assert.equal(v.charge.to, MERCHANT.toLowerCase());          // non-custodial: merchant's own address
  assert.equal(v.status, 'issued');
});

t('bad line items fail closed (negative, zero qty, garbage amounts)', () => {
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', amountUsd: '-5' }], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', qty: 0, unitUsd: '5' }], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', qty: 1.5, unitUsd: '5' }], nowMs: NOW }));
});

t('invoiceURI IS the same EIP-681 rail as any BIII charge', () => {
  const v = inv();
  assert.equal(I.invoiceURI(v), T.paymentURI(v.charge));
  assert.ok(I.invoiceURI(v).startsWith('ethereum:' + T.USDC_BASE + '@8453/transfer?address='));
});

t('verifyInvoice = the same field-for-field chain discipline (underpay ⇒ NOT paid)', () => {
  const v = inv();
  const under = I.verifyInvoice(v, { txHash: '0x1', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: '1471000000', confirmations: 3 });
  assert.equal(under.paid, false);
  assert.match(under.reason, /underpaid/);
  const ok = I.verifyInvoice(v, { txHash: '0x2', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 3, blockTime: 1753100400 });
  assert.equal(ok.paid, true);
});

t('status lifecycle: issued → overdue (past due, unpaid) → settled (chain confirms)', () => {
  const v = inv();
  assert.equal(I.invoiceStatus(v, null, NOW + 1000).status, 'issued');
  assert.equal(I.invoiceStatus(v, null, NOW + 15 * 86400000).status, 'overdue');
  const paid = I.verifyInvoice(v, { txHash: '0x2', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 12 });
  const st = I.invoiceStatus(v, paid, NOW + 20 * 86400000);   // paid late is still SETTLED
  assert.equal(st.status, 'settled');
  assert.equal(st.tier, 'final');
});

t('ONE till roll: an invoice receipt and a café receipt land in the SAME provable ledger', () => {
  const v = inv();
  const paid = I.verifyInvoice(v, { txHash: '0x' + 'aa'.repeat(32), chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 3, blockTime: 1753100400, from: '0x' + 'cc'.repeat(20) });
  const invoiceRec = I.invoiceReceipt(v, paid);
  assert.equal(invoiceRec.kind, 'basetill-receipt');          // it IS a normal registry receipt
  assert.equal(invoiceRec.invoiceNumber, 'INV-2026-041');     // …with the bill on top

  // café sale in the same roll
  const charge = T.createCharge({ to: MERCHANT, amountUsd: '4.50', label: 'Flat white', nowMs: NOW });
  const cafePaid = T.verifyPayment(charge, { txHash: '0x' + 'bb'.repeat(32), chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: '5000000', confirmations: 1, blockTime: 1753100500 });
  const cafeRec = T.receipt(charge, cafePaid, { merchantName: 'Atelier Dupont' });

  let rows = [];
  ({ rows } = L.appendReceipt(rows, invoiceRec));
  ({ rows } = L.appendReceipt(rows, cafeRec));
  assert.equal(rows.length, 2);
  const s = L.summary(rows);
  assert.equal(s.count, 2);
  assert.equal(s.grossMicro, (BigInt(v.totalMicro) + 5000000n).toString());  // both flows, one book
  assert.equal(s.tipsUsd, '0.50');                                           // café overpay = tip
  // and the SAME trust triangle judges the invoice's settlement
  const tri = assessTriangle({ settlement: paid });
  assert.equal(tri.trust, 'settled');
  assert.equal(tri.vertices.settlement.txHash, paid.txHash);
});

t('renderInvoice: a non-crypto human reads the bill (FR too), pay line is the EIP-681', () => {
  const v = inv();
  const en = I.renderInvoice(v);
  assert.match(en, /INVOICE {2}INV-2026-041/);
  assert.match(en, /Maintenance ×3/);
  assert.match(en, /TOTAL:.*1471\.50 USDC/);
  assert.ok(en.includes(I.invoiceURI(v)));
  const fr = I.renderInvoice(v, { lang: 'fr' });
  assert.match(fr, /FACTURE/); assert.match(fr, /Échéance/);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
