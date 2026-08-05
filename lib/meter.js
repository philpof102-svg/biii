'use strict';
/**
 * BIII meter — the usage → bill mechanic a white-label pilot needs, in the BIII discipline.
 * ================================================================================================
 * PRICING.md's honest catch: "metering bps needs trusting their volume report." So this meter splits
 * usage into what is RE-VERIFIABLE and what is SELF-REPORTED, and never blurs them:
 *   - SETTLED RECEIPTS are on-chain: each carries a txHash, so the count + volume are re-checkable on
 *     Base by anyone (dedup by txHash — a tx pays once). This is the provable half.
 *   - VERDICTS (till_trust / till_vet_merchant calls) are advisory API reads, NOT chain artifacts, so a
 *     verdict count can only be SELF-REPORTED by the operator. The meter counts it but LABELS it as such.
 * The plan is INJECTED (the partner brings their pricing, like the white-label brand) — pure/deterministic,
 * offline, stateless. BIII holds no ledger and moves no funds; the operator re-verifies every settled line.
 */

const T = require('./till');
const { normalizeRows } = require('./export');   // same dedup-by-txHash + window semantics as the books
const { windowRows, undatedNote } = require('./ledger');   // LA regle de fenetre, partagee avec les livres

// A plan is plain data (all amounts in whole USD): monthly base + what's included + overage unit prices.
// includedReceipts/includedVerdicts default to Infinity/0 — a partner overrides with their own tiers.
const DEFAULT_PLAN = {
  name: 'pilot',
  monthlyBaseUsd: 750,
  includedVerdicts: 5000, verdictOverageUsd: 0.25,
  includedReceipts: Infinity, receiptOverageUsd: 0.03,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function mergePlan(plan) {
  const p = plan && typeof plan === 'object' ? plan : {};
  return {
    name: p.name || DEFAULT_PLAN.name,
    monthlyBaseUsd: Number(p.monthlyBaseUsd ?? DEFAULT_PLAN.monthlyBaseUsd),
    includedVerdicts: Number(p.includedVerdicts ?? DEFAULT_PLAN.includedVerdicts),
    verdictOverageUsd: Number(p.verdictOverageUsd ?? DEFAULT_PLAN.verdictOverageUsd),
    includedReceipts: p.includedReceipts === undefined ? DEFAULT_PLAN.includedReceipts : Number(p.includedReceipts),
    receiptOverageUsd: Number(p.receiptOverageUsd ?? DEFAULT_PLAN.receiptOverageUsd),
  };
}

/**
 * meterUsage — turn a month's verified receipts (+ an optional self-reported verdict count) into a bill.
 *   receipts:    the verified receipt objects (from till_receipt) — deduped by txHash, optional window.
 *   opts.plan:   the pricing plan (injected; DEFAULT_PLAN if absent).
 *   opts.verdictCount: operator-reported number of trust verdicts served (advisory — not chain-provable).
 *   opts.window: { fromBlockTime, toBlockTime } — same block-time window as the books.
 * Returns { plan, provable:{settledReceipts, settledVolumeUsd, txHashes}, selfReported:{verdicts},
 *           charges:[…], totalUsd, disclosure }.
 */
function meterUsage(receipts, { plan, verdictCount, window } = {}) {
  const P = mergePlan(plan);
  /* MEME regle de fenetre que les livres (ledger.windowRows) — la coercition locale `Number(bt) || 0` qui
   * vivait ici datait un recu sans horodatage a 1970 et le sortait de tout mois facture, EN SILENCE. Sur
   * une facture, l'erreur va dans les deux sens selon le camp: un recu escamote SOUS-FACTURE l'operateur,
   * et personne ne verifie a la baisse. `undatedExcluded` remonte donc jusque dans la facture. */
  const { kept: rows, undatedExcluded } = windowRows(normalizeRows(receipts), window);

  // provable half — settled receipts, on-chain, re-checkable
  let volMicro = 0n;
  for (const e of rows) volMicro += BigInt(e.receipt.paidMicro || e.receipt.amountMicro || '0');
  const settledReceipts = rows.length;
  const settledVolumeUsd = T.microToUsd(volMicro.toString());

  // self-reported half — verdicts (advisory API calls, not chain artifacts)
  const verdicts = Math.max(0, Math.floor(Number(verdictCount) || 0));

  const charges = [{ item: 'monthly base (' + P.name + ')', qty: 1, unitUsd: P.monthlyBaseUsd, amountUsd: round2(P.monthlyBaseUsd), basis: 'plan' }];

  const receiptOver = Number.isFinite(P.includedReceipts) ? Math.max(0, settledReceipts - P.includedReceipts) : 0;
  if (receiptOver > 0) charges.push({ item: 'receipts over quota', qty: receiptOver, unitUsd: P.receiptOverageUsd,
    amountUsd: round2(receiptOver * P.receiptOverageUsd), basis: 'provable (on-chain settled receipts)' });

  const verdictOver = Math.max(0, verdicts - P.includedVerdicts);
  if (verdictOver > 0) charges.push({ item: 'verdicts over quota', qty: verdictOver, unitUsd: P.verdictOverageUsd,
    amountUsd: round2(verdictOver * P.verdictOverageUsd), basis: 'SELF-REPORTED (verdicts are advisory API calls, not on-chain)' });

  const totalUsd = round2(charges.reduce((s, c) => s + c.amountUsd, 0));

  return {
    plan: P,
    provable: { settledReceipts, settledVolumeUsd, txHashes: rows.map((e) => e.receipt.txHash), undatedExcluded },
    selfReported: { verdicts },
    charges, totalUsd,
    disclosure: (undatedExcluded ? undatedNote(undatedExcluded, 'en') + ' ' : '')
      + 'Usage split by trust: the ' + settledReceipts + ' settled receipt(s) are ON-CHAIN — re-verify each '
      + 'txHash on Base (the provable basis for receipt charges). The verdict count is SELF-REPORTED by the '
      + 'operator (verdicts are advisory reads, not chain artifacts) — bill on it only with a trusted volume '
      + 'report. Non-custodial: BIII holds no ledger and moved no funds; this is a computation over your own receipts.',
  };
}

module.exports = { meterUsage, mergePlan, DEFAULT_PLAN };
