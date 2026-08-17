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
// LA regle de fenetre ET LA lecture des montants, partagees avec les livres
const { windowRows, undatedNote, amountMicroOf, unreadableAmountNote } = require('./ledger');

// A plan is plain data (all amounts in whole USD): monthly base + what's included + overage unit prices.
// includedReceipts/includedVerdicts default to Infinity/0 — a partner overrides with their own tiers.
const DEFAULT_PLAN = {
  name: 'pilot',
  monthlyBaseUsd: 750,
  includedVerdicts: 5000, verdictOverageUsd: 0.25,
  includedReceipts: Infinity, receiptOverageUsd: 0.03,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * nombreFacture — un nombre de FACTURATION: absent (on prend le defaut), ou lisible. Un champ PRESENT et
 * illisible est REFUSE; il n'est jamais silencieusement coerce.
 *
 * ⚠️ MESURE DU 2026-08-11 A TRAVERS LE VRAI `callTool('till_meter')`, pas une fixture. `Number()` seul
 * rendait NaN sur tout champ illisible, et NaN traversait CHAQUE etape de la facture sans rien casser —
 * toujours dans le sens qui SOUS-FACTURE, c'est-a-dire celui que personne ne verifie:
 *
 *   plan valide, verdictCount 6000 ............ total $1000   <- la vraie facture
 *   verdictCount "6,000" (illisible) .......... total $750    <- MEME OCTET que « 0 verdict rendu »
 *   includedVerdicts "cinq mille" ............. total $750    <- Math.max(0, 6000-NaN) = NaN, NaN>0 faux
 *   monthlyBaseUsd "sept cents" ............... total $250    <- round2(NaN) = 0: abonnement facture $0
 *   verdictOverageUsd "un quart" .............. total $750    <- ligne de charge SERVIE a $0
 *
 * Le premier cas est la forme exacte que ce depot chasse: `verdictCount: "6,000"` et `verdictCount: 0` et
 * `verdictCount` ABSENT rendaient trois fois la MEME reponse octet pour octet. Une lecture ratee devenait
 * l'affirmation « l'operateur a rendu zero verdict ». Et ce module DIT deja, dix lignes plus bas, pourquoi
 * c'est le sens grave: « un recu escamote SOUS-FACTURE l'operateur, et personne ne verifie a la baisse ».
 * Il l'avait resolu pour les recus (windowRows/undatedExcluded) et pas pour ses propres chiffres de prix.
 *
 * ⛔ POURQUOI REFUSER PLUTOT QUE DIVULGUER — la decision n'est pas neuve, elle est REPRISE de
 * `ledger.boundStrict` (2026-08-09), et son raisonnement s'applique mot pour mot: divulguer « votre borne
 * a ete ignoree » tout en rendant quand meme le total expedie encore le mauvais chiffre. On ne consomme
 * pas la demande avant de l'avoir validee. `invalidParams` fait nommer le champ fautif en -32602 par le
 * catch generique de bin/biii-mcp.js:967 — un refus qui ne dit pas QUOI etait faux renvoie l'appelant
 * deviner.
 *
 * ⛔ POURQUOI PAS `boundStrict` DIRECTEMENT, malgre la regle « pas de copie plus faible du helper
 * canonique »: `boundStrict` refuse l'infini, et `includedReceipts` vaut `Infinity` PAR DEFAUT — c'est sa
 * facon d'ecrire « illimite ». Le helper canonique dirait donc non au plan par defaut de ce module. La
 * divergence est nommee ici pour qu'elle reste un choix et pas une derive: meme forme acceptee (nombre
 * fini, bigint, chaine decimale — les clients JSON-RPC envoient « 5000 », c'est MESURE et ca doit
 * continuer de marcher), meme drapeau de refus, plus l'infini la ou il veut dire quelque chose.
 */
/* `nom` est le chemin COMPLET du champ tel que l'appelant l'a ecrit (`plan.monthlyBaseUsd`, `verdictCount`)
 * et non son nom court: un refus qui nomme `plan.verdictCount` pour un argument de premier niveau envoie
 * corriger le mauvais objet, ce qui est une deuxieme facon de renvoyer l'appelant deviner. */
function nombreFacture(v, nom, { defaut, autoriseInfini = false } = {}) {
  const refus = (quoi) => {
    const e = new Error(`${nom} ${quoi} — refusing to compute a bill from it: a figure that cannot be `
      + 'read is not a figure, and every silent coercion here lands on the UNDER-charging side. '
      + 'Pass a number (or omit the field to take the default).');
    e.invalidParams = true; throw e;
  };
  if (v === undefined || v === null) return defaut;                 // absent: le defaut du plan s'applique
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
    if (v === Infinity && autoriseInfini) return v;                 // « illimite », la ou ca a un sens
    return refus(`is not a finite number (${String(v)})`);
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  if (autoriseInfini && v === 'Infinity') return Infinity;
  return refus(`is present but unreadable (${JSON.stringify(v)})`);
}

function mergePlan(plan) {
  const p = plan && typeof plan === 'object' ? plan : {};
  return {
    name: p.name || DEFAULT_PLAN.name,
    monthlyBaseUsd: nombreFacture(p.monthlyBaseUsd, 'plan.monthlyBaseUsd', { defaut: DEFAULT_PLAN.monthlyBaseUsd }),
    includedVerdicts: nombreFacture(p.includedVerdicts, 'plan.includedVerdicts', { defaut: DEFAULT_PLAN.includedVerdicts, autoriseInfini: true }),
    verdictOverageUsd: nombreFacture(p.verdictOverageUsd, 'plan.verdictOverageUsd', { defaut: DEFAULT_PLAN.verdictOverageUsd }),
    includedReceipts: nombreFacture(p.includedReceipts, 'plan.includedReceipts', { defaut: DEFAULT_PLAN.includedReceipts, autoriseInfini: true }),
    receiptOverageUsd: nombreFacture(p.receiptOverageUsd, 'plan.receiptOverageUsd', { defaut: DEFAULT_PLAN.receiptOverageUsd }),
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

  /* provable half — settled receipts, on-chain, re-checkable.
   * `BigInt(paidMicro || amountMicro || '0')` rendait ici le volume PROUVABLE d'un montant illisible egal
   * a celui d'un recu valant honnetement zero, et laissait un montant negatif SOUSTRAIRE du volume. La
   * lecture stricte vit dans ledger.amountMicroOf — LA definition, partagee avec les livres, pour qu'il
   * n'y ait plus de jumelle a diverger. Le refus du `verdictCount` negatif vingt lignes plus bas tenait
   * deja exactement cet argument, du cote declaratif. */
  let volMicro = 0n, unreadableAmounts = 0;
  for (const e of rows) {
    const m = amountMicroOf(e.receipt);
    if (m === null) unreadableAmounts += 1; else volMicro += m;
  }
  const settledReceipts = rows.length;
  const settledVolumeUsd = T.microToUsd(volMicro.toString());

  /* self-reported half — verdicts (advisory API calls, not chain artifacts).
   *
   * ⚠️ `Math.max(0, Math.floor(Number(verdictCount) || 0))` faisait DEUX choses fausses a la fois, et les
   * deux ecrivaient un chiffre a la place d'un aveu:
   *   · illisible -> 0. « 6,000 » (le separateur de milliers d'un humain) rendait la MEME facture que
   *     « l'operateur declare zero verdict » et que « l'operateur n'a rien declare ». Trois etats sur une
   *     seule sortie, dont deux faux.
   *   · negatif -> 0, en silence. Un compte negatif n'est pas un compte bas: c'est une demande malformee.
   *
   * ABSENT reste 0 et ne change pas: ne rien declarer est legitime, et ca ne facture aucun surplus. Ce qui
   * est refuse, c'est un champ PRESENT qu'on ne sait pas lire — la meme ligne que `plan.*` au-dessus. */
  const compte = nombreFacture(verdictCount, 'verdictCount', { defaut: 0 });
  if (compte < 0) {
    const e = new Error('verdictCount is negative (' + compte + ') — refusing: a negative count of verdicts '
      + 'served is not a low count, it is a malformed report, and clamping it to 0 would bill as if the '
      + 'operator had honestly declared zero.');
    e.invalidParams = true; throw e;
  }
  const verdicts = Math.floor(compte);

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
    provable: { settledReceipts, settledVolumeUsd, txHashes: rows.map((e) => e.receipt.txHash),
      undatedExcluded, unreadableAmounts },
    selfReported: { verdicts },
    charges, totalUsd,
    disclosure: (undatedExcluded ? undatedNote(undatedExcluded, 'en') + ' ' : '')
      + (unreadableAmounts ? unreadableAmountNote(unreadableAmounts, 'en') + ' ' : '')
      + 'Usage split by trust: the ' + settledReceipts + ' settled receipt(s) are ON-CHAIN — re-verify each '
      + 'txHash on Base (the provable basis for receipt charges). The verdict count is SELF-REPORTED by the '
      + 'operator (verdicts are advisory reads, not chain artifacts) — bill on it only with a trusted volume '
      + 'report. Non-custodial: BIII holds no ledger and moved no funds; this is a computation over your own receipts.',
  };
}

module.exports = { meterUsage, mergePlan, DEFAULT_PLAN };
