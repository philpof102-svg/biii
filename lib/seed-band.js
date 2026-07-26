'use strict';
/**
 * seed-band.js — is there a seed size that survives, and can it be shown WITHOUT looking at the answers?
 * =====================================================================================================
 * Risk by initial liquidity is not monotonic in this dataset. By quintile of seed it runs 81% / 86% / 19% /
 * 3% / 71%: dangerous at both ends, quiet in the middle. Both ends make sense once named — a cheap rug seeds
 * small, and a well-funded factory seeds large (the openhuman cluster seeds at a $61k median) — so no single
 * threshold can express it and a BAND is the only shape that fits.
 *
 * A band fitted to outcomes it will then be scored against proves nothing, which is how two escalation rules
 * died here. So this module does not fit a band at all: it REPLAYS, deriving the bands at each step from
 * strictly earlier resolved outcomes and judging the next token against them.
 *
 * ═══ NO PARAMETER IS TUNED ═══
 * The bands are quintiles of prior seeds — a shape, not a choice. The prediction is positional ("this token
 * falls where the safest / riskiest prior quintile was"), so there is no margin, no cutoff and no smoothing
 * to quietly optimise. That is deliberate: every knob is a place to fit noise.
 *
 * ═══ WHAT IT MEASURED, AND WHY IT IS NOT SHIPPED ═══
 * The safe band held forward: 0 rugs in 30, over 147 predictions, against a 45% base rate. Strong — and
 * suspended anyway, because the independence check that killed the impersonation rule is inconclusive here:
 * 63% of the safe band has no traced funder, and a third of it IS the one funder with no prior rug. It may
 * simply be the funder registry seen from another angle, and 28 hours of data can describe a market regime
 * rather than a law. `distinctFunders` and `untraced` travel with the result so that stays visible.
 *
 * Pure and offline: takes records and a resolver, returns counts. No clock, no disk, no network.
 */

const MIN_BAND = 3;        // a quintile of one or two cases describes nothing
const QUINTILES = 5;

/**
 * bands — the safest and riskiest quintile of a set of ALREADY RESOLVED observations.
 * @param hist array of { liq, rug }
 * @returns { safe, risky, all, base } or null when the history cannot support bands yet
 */
function bands(hist) {
  const sorted = hist.slice().sort((a, b) => a.liq - b.liq);
  const size = Math.ceil(sorted.length / QUINTILES);
  const out = [];
  for (let i = 0; i < QUINTILES; i++) {
    const block = sorted.slice(i * size, (i + 1) * size);
    if (block.length < MIN_BAND) continue;
    const rugged = block.filter((x) => x.rug).length;
    out.push({ lo: block[0].liq, hi: block[block.length - 1].liq, n: block.length, rate: rugged / block.length });
  }
  if (out.length < 3) return null;      // fewer than three usable bands is not a distribution
  return {
    safe: out.reduce((m, b) => (b.rate < m.rate ? b : m)),
    risky: out.reduce((m, b) => (b.rate > m.rate ? b : m)),
    all: out,
    base: hist.filter((x) => x.rug).length / hist.length,
  };
}

/**
 * replay — walk forward, judging each token against bands built only from what preceded it.
 *
 * @param tokens   array or address-keyed object of records with { firstSeen, firstLiq, funder }
 * @param resolve  (token) => 'rugged' | 'survived' | 'open'
 * @param opts.warmup how many resolved observations before predictions begin (default 40)
 */
function replay(tokens, resolve, opts = {}) {
  const warmup = opts.warmup == null ? 40 : opts.warmup;
  const rows = (Array.isArray(tokens) ? tokens : Object.values(tokens || {}))
    .filter((t) => t && t.firstSeen && Number.isFinite(t.firstLiq))
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));

  const keys = ['safest_prior_band', 'riskiest_prior_band', 'between'];
  const tally = {};
  for (const k of keys) tally[k] = { rugged: 0, survived: 0, funders: new Set(), untraced: 0 };

  const hist = [];
  let predictions = 0, noBands = 0;

  for (const t of rows) {
    const outcome = resolve(t);
    if (hist.length >= warmup && outcome !== 'open') {
      const b = bands(hist);
      if (!b) noBands++;
      else {
        const inSafe = t.firstLiq >= b.safe.lo && t.firstLiq <= b.safe.hi;
        const inRisky = t.firstLiq >= b.risky.lo && t.firstLiq <= b.risky.hi;
        // A token inside BOTH (possible when history is thin and bands touch) is not evidence for either.
        const key = inSafe && !inRisky ? 'safest_prior_band' : inRisky && !inSafe ? 'riskiest_prior_band' : 'between';
        const bucket = tally[key];
        bucket[outcome === 'rugged' ? 'rugged' : 'survived']++;
        if (t.funder) bucket.funders.add(String(t.funder).toLowerCase()); else bucket.untraced++;
        predictions++;
      }
    }
    // history grows AFTER the judgement — this ordering is the protocol, not an implementation detail
    if (outcome !== 'open') hist.push({ liq: t.firstLiq, rug: outcome === 'rugged' });
  }

  const out = { predictions, noBands, warmup };
  let totRug = 0, totRes = 0;
  for (const k of keys) {
    const b = tally[k];
    const resolved = b.rugged + b.survived;
    totRug += b.rugged; totRes += resolved;
    out[k] = { rugged: b.rugged, survived: b.survived, resolved,
      rate: resolved ? +(b.rugged / resolved).toFixed(2) : null,
      /* Published beside every bucket because a rate over N tokens from two operators is a rate over two
       * operators. This is exactly the check that turned the impersonation rule from a signal into noise. */
      distinctFunders: b.funders.size, untraced: b.untraced };
  }
  out.baseRate = totRes ? +(totRug / totRes).toFixed(2) : null;
  out.resolvedTotal = totRes;
  return out;
}

module.exports = { bands, replay, MIN_BAND, QUINTILES };
