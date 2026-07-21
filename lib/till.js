'use strict';
/**
 * basetill — the real-world USDC till on Base. CORE (pure, offline, deterministic).
 * =================================================================================
 * THE GAP (researched 2026-07-21): Base Pay is online-checkout only (browser SDK); Lyzi/
 * BitPay/Binance Pay are custodial/PSP/terminal/enterprise; Shopify needs Shopify. Nobody
 * serves the independent real-world merchant (café, market stall, plumber, freelancer) who
 * wants to accept USDC on Base with JUST A PHONE — non-custodial (their own address), no
 * terminal, no KYB middleman, receipt included, confirmed in seconds.
 *
 * basetill = the Square/SumUp of USDC on Base:
 *   merchant types an amount → a CHARGE → a universal QR (EIP-681, every major wallet scans
 *   it) → customer pays from any wallet → we VERIFY the on-chain transfer field-for-field
 *   (same discipline as LAWBOR settle: no fact, no match ⇒ not paid, ever) → both sides get
 *   a receipt anchored to the txHash.
 *
 * This module is the deterministic core: charges, payment URIs, verification, receipts.
 * Chain reading, QR rendering and the phone UI are adapters around it. It holds no key,
 * never moves funds, and can't lie about a payment — the chain fact decides.
 */

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_CHAIN_ID = 8453;
// Retail UX vs safety: 1 conf on Base (~2s) is the coffee-counter default; `final` needs more.
const MIN_CONF_PAID = 1;
const MIN_CONF_FINAL = 12;

const lower = (s) => String(s || '').toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lower(a));

/** USD string/number → USDC micro units (6 decimals), exact, no float drift. */
function usdToMicro(usd) {
  const s = String(usd ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid USD amount "${usd}" (max 6 decimals)`);
  const [int, frac = ''] = s.split('.');
  const micro = BigInt(int) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  if (micro <= 0n) throw new Error('amount must be positive');
  if (micro > 1_000_000_000_000_000n) throw new Error('amount unreasonably large'); // 1B USDC sanity cap
  return micro.toString();
}
// Money DISPLAY: always at least 2 decimals ("4.50", not "4.5" — an invoice says 1471.50),
// exact beyond that when the micro amount needs it ("4.123456"). Math stays in micro.
const microToUsd = (micro) => {
  let m = BigInt(micro);
  const sign = m < 0n ? '-' : ''; if (m < 0n) m = -m;   // defensive: never render a negative as "-4.-5"
  const frac = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${m / 1_000_000n}.${frac}`;
};

/** A CHARGE — the merchant's payment request. Data only; nothing moves. */
function createCharge({ to, amountUsd, amountMicro, label, orderId, nowMs }) {
  if (!isAddr(to)) throw new Error('charge needs the merchant 0x address (their OWN wallet — basetill is non-custodial)');
  const micro = amountMicro != null ? String(amountMicro) : usdToMicro(amountUsd);
  if (!/^\d+$/.test(micro) || BigInt(micro) <= 0n) throw new Error('charge needs a positive amount');
  const at = Number(nowMs) || null;
  return {
    v: 1,
    id: 'ch_' + (at || 0).toString(36) + '_' + micro + '_' + lower(to).slice(2, 8),
    to: lower(to), token: USDC_BASE, chainId: BASE_CHAIN_ID,
    amountMicro: micro, amountUsd: microToUsd(micro),
    label: String(label || '').slice(0, 80) || null,
    orderId: String(orderId || '').slice(0, 40) || null,
    createdAtMs: at, status: 'pending',
  };
}

/** EIP-681 payment URI — the universal QR content (MetaMask, Coinbase Wallet, Rainbow,
 *  Trust… all scan this): an ERC-20 transfer of exactly the charge amount to the merchant. */
function paymentURI(charge) {
  if (!charge || !isAddr(charge.to)) throw new Error('paymentURI needs a valid charge');
  return `ethereum:${USDC_BASE}@${BASE_CHAIN_ID}/transfer?address=${charge.to}&uint256=${charge.amountMicro}`;
}

/**
 * VERIFY — the only function allowed to say "paid", and it only believes the CHAIN.
 * fact = an injected, immutable chain fact for a Transfer log:
 *   { txHash, chainId, token, to, valueMicro, confirmations, blockTime, from? }
 * Field-for-field, fail-closed (LAWBOR-settle discipline):
 *   wrong chain/token/recipient ⇒ not paid · value < amount ⇒ underpaid (never partial-paid)
 *   value ≥ amount ⇒ paid (tips/overpay are the merchant's win) · confirmations decide tier.
 */
function verifyPayment(charge, fact) {
  if (!charge) throw new Error('verify needs a charge');
  // FAIL-CLOSED on a non-positive/malformed charge amount. createCharge guards this, but /status and the
  // MCP build the charge inline — a slipped '' / '0' / '-5' amountMicro would make BigInt('')=0 and ANY
  // dust transfer read as paid. Guard here so every call site is safe.
  if (!/^\d+$/.test(String(charge.amountMicro)) || BigInt(charge.amountMicro) <= 0n)
    return { paid: false, reason: 'charge amount is not a positive integer (micro)' };
  if (!fact || typeof fact !== 'object') return { paid: false, reason: 'no chain fact — nothing verified, nothing paid' };
  if (Number(fact.chainId) !== BASE_CHAIN_ID) return { paid: false, reason: `wrong chain ${fact.chainId} (need Base ${BASE_CHAIN_ID})` };
  if (lower(fact.token) !== USDC_BASE) return { paid: false, reason: 'wrong token (need USDC on Base)' };
  if (lower(fact.to) !== charge.to) return { paid: false, reason: 'recipient is not this merchant' };
  // strict integer value — a decimal/scientific/negative valueMicro would THROW in BigInt() (crashing the
  // caller) or, unguarded, mis-compare. Reject anything that isn't a run of digits.
  const vm = String(fact.valueMicro ?? '');
  if (!/^\d+$/.test(vm)) return { paid: false, reason: 'malformed transfer value' };
  const got = BigInt(vm), want = BigInt(charge.amountMicro);
  if (got < want) return { paid: false, reason: `underpaid: got ${microToUsd(got.toString())} of ${charge.amountUsd} USDC` };
  // confirmations must be a real integer — Number(true)===1 would let a fact with confirmations:true pass.
  const cr = fact.confirmations;
  const conf = (typeof cr === 'number' && Number.isInteger(cr) && cr >= 0) ? cr
    : (typeof cr === 'string' && /^\d+$/.test(cr)) ? Number(cr) : -1;
  if (conf < MIN_CONF_PAID) return { paid: false, reason: 'not yet confirmed' };
  return {
    paid: true,
    tier: conf >= MIN_CONF_FINAL ? 'final' : 'confirmed',
    txHash: fact.txHash || null,
    paidMicro: got.toString(), overpaidMicro: (got - want).toString(),
    from: fact.from ? lower(fact.from) : null,
    blockTime: Number(fact.blockTime) || null,
  };
}

/** RECEIPT — one object both sides keep, anchored to the tx (refutable by anyone). */
function receipt(charge, verdict, { merchantName } = {}) {
  if (!verdict || verdict.paid !== true) throw new Error('no receipt without a verified payment');
  return {
    v: 1, kind: 'basetill-receipt',
    merchant: { name: String(merchantName || '').slice(0, 60) || null, address: charge.to },
    label: charge.label, orderId: charge.orderId,
    amountUsd: charge.amountUsd, amountMicro: charge.amountMicro,
    paidMicro: verdict.paidMicro, overpaidMicro: verdict.overpaidMicro,
    token: 'USDC', chainId: BASE_CHAIN_ID,
    txHash: verdict.txHash, payer: verdict.from, tier: verdict.tier,
    blockTime: verdict.blockTime,
    explorer: verdict.txHash ? 'https://basescan.org/tx/' + verdict.txHash : null,
  };
}

module.exports = {
  USDC_BASE, BASE_CHAIN_ID, MIN_CONF_PAID, MIN_CONF_FINAL,
  usdToMicro, microToUsd, createCharge, paymentURI, verifyPayment, receipt,
};
