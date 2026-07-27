'use strict';
/**
 * scorecard.js — grading our own calls, including the part that flatters nobody.
 * =============================================================================
 * Extracted from token-radar.js so the numbers we PUBLISH can be tested without a network round trip. The
 * radar is a cron script wrapped in an IIFE: requiring it runs it. That meant the arithmetic behind our
 * headline figure had never been exercised by a test, which is a strange place to leave the one number a
 * buyer would act on.
 *
 * ═══ THE THREE MISTAKES THIS FILE IS THE FIX FOR ═══
 *
 * 1. TWO DEFINITIONS OF "A CALL" (fixed 2026-07-26). `strong` counted rug_ready OR high_risk as a win, while
 *    the false-alarm filter counted rug_ready only. A high_risk verdict therefore scored when it was right
 *    and cost nothing when it was wrong. One shared predicate now, not two filters that agree today.
 *
 * 2. A ZERO WITH NO DENOMINATOR. `missedOutright` — rugs we had called `clean` — sat proudly at 0. It was 0
 *    because `clean` has been emitted ZERO times, ever. You cannot miss with a verdict you never give, so
 *    `cleanVerdictsEmitted` travels with it permanently.
 *
 * 3. OPEN CALLS SCORED AS ERRORS. Every still-live flagged token counted as a false alarm, including one
 *    flagged forty minutes ago. Rugs resolve fast (median ~1h) and false alarms only prove themselves by
 *    surviving, so the figure was permanently depressed by calls that had not had time to answer.
 *
 * The naive repair for (3) — grade only what is closed — measured 1.00 when tried, and 1.00 is not a result,
 * it is the shape of a young dataset: wins bank in an hour, losses defer for half a day. So this reports
 * BOTH bounds and the open count, and neither number can be quoted alone.
 *
 * Pure and deterministic: takes the token records and a timestamp, returns the card. No clock, no disk, no
 * network — `now` is injected so a test can place a token at any age it likes.
 */

/** ONE definition of "a strong call", used on BOTH sides of the ledger. */
const isStrongCall = (t) => t.firstVerdict === 'rug_ready' || t.firstVerdict === 'high_risk';

const HOURS = 3600000;

/**
 * @param all   array of token records: { firstVerdict, outcome, firstSeen, ruggedAt, ... }
 * @param now   ISO string — injected, never read from the clock, so this is testable at any age.
 */
function scoreCalls(all, now, opts = {}) {
  const rows = Array.isArray(all) ? all : Object.values(all || {});

  /* HOURS WE WERE NOT WATCHING.
   *
   * The harvest only ever shows pools that exist RIGHT NOW. A token that launched and died while the radar
   * was down was never seen, never counted as a rug, and never can be — so during a blackout every number
   * here is a FLOOR, and a blackout reads exactly like a quiet market.
   *
   * Measured 2026-07-27: a 9.3h gap when the machine slept and the Hermes gateway restarted, and nothing
   * anywhere said so. `rugsObserved` looked like a complete count of the period. It was a count of what
   * survived long enough to still be visible when we came back. */
  const blackouts = Array.isArray(opts.blackouts) ? opts.blackouts : [];
  const unwatchedHours = blackouts.reduce((s, b) => s + (Number(b.hours) || 0), 0);
  const rugged = rows.filter((t) => t.outcome === 'rugged');

  const strong = rugged.filter(isStrongCall);
  const soft = rugged.filter((t) => t.firstVerdict === 'caution');
  const silent = rugged.filter((t) => t.firstVerdict === 'unknown');
  const missed = rugged.filter((t) => t.firstVerdict === 'clean');
  const stillLive = rows.filter((t) => t.outcome === 'live');

  /* THE MATURITY WINDOW IS DERIVED, NOT CHOSEN — AND IT IS A QUANTILE, NOT A MAXIMUM.
   *
   * Choosing the window by hand would repeat the error that killed two escalation rules here. But the first
   * derived version used the SLOWEST rug ever observed, and that was its own kind of self-flattery, caught
   * the same evening it shipped:
   *
   *   One token (MECHACOIN) rugged at 26.3h. That single observation widened the window from 15h to 27h,
   *   and both of our confirmed false alarms — DINO and SOAS, alive at 18.3h — fell back from "resolved
   *   wrong" to "still open". Precision rose from 0.93 to 1.00 without a single call improving.
   *
   * A maximum is the least robust statistic there is: one outlier moves it arbitrarily far, it moves in the
   * direction that erases our errors, and it makes the metric non-monotonic — a resolved call can become
   * unresolved. Measured on this dataset, removing one observation moves the max by 12.1h and the 95th
   * percentile by 0.1h.
   *
   * So: p95, rounded up. The cost is explicit and points the right way — about 4% of rugs land beyond it, so
   * a few tokens counted as false alarms are really slow catches. We take that loss rather than the one
   * where a slow rug quietly deletes our mistakes. `beyondWindowRugs` publishes exactly how many. */
  const ruggedLifetimesH = rugged
    .map((t) => (Date.parse(t.ruggedAt) - Date.parse(t.firstSeen)) / HOURS)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
  const p95RugH = quantile(ruggedLifetimesH, 0.95);
  const slowestRugH = ruggedLifetimesH.length ? ruggedLifetimesH[ruggedLifetimesH.length - 1] : null;
  const maturityH = p95RugH == null ? null : Math.max(1, Math.ceil(p95RugH));
  const beyondWindow = maturityH == null ? 0 : ruggedLifetimesH.filter((h) => h > maturityH).length;

  const liveStrong = stillLive.filter(isStrongCall);
  /* An unreadable or missing firstSeen counts AGAINST us — it resolves as a false alarm, never as open.
   *
   * We cannot prove such a token is still too young, and letting "I don't know" quietly lift a candidate
   * error out of the denominator is the precise move this scorecard exists to refuse. Fail-closed here means
   * failing toward the number that hurts. */
  const survivedWindow = (t) => {
    if (maturityH == null) return false;           // no rug observed yet: nothing can be resolved
    const age = (Date.parse(now) - Date.parse(t.firstSeen)) / HOURS;
    return !Number.isFinite(age) || age >= maturityH;
  };
  const falseAlarms = liveStrong.filter(survivedWindow);
  const openCalls = liveStrong.filter((t) => !survivedWindow(t));

  const resolvedStrong = strong.length + falseAlarms.length;
  const everStrong = liveStrong.length + strong.length;
  const warned = strong.length + soft.length;

  return {
    updatedAt: now,
    tokensTracked: rows.length,
    rugsObserved: rugged.length,
    warnedBeforeTheRug: warned,
    ofWhichStrong: strong.length,
    ofWhichCautionOnly: soft.length,
    abstained: silent.length,
    missedOutright: missed.length,
    warnRate: rugged.length ? +(warned / rugged.length).toFixed(2) : null,
    strongRate: rugged.length ? +(strong.length / rugged.length).toFixed(2) : null,

    /* Raw counts first, ratios after — the sample is small and a bare ratio invites more confidence than it
     * has earned. `flaggedButStillAlive` is every live flagged token, resolved or not; the split below says
     * which of them have actually answered. */
    flaggedButStillAlive: liveStrong.length,
    strongCallsTotal: everStrong,
    strongCallsRight: strong.length,
    strongCallsWrong: falseAlarms.length,
    strongCallsOpen: openCalls.length,
    strongCallsResolved: resolvedStrong,

    maturityWindowHours: maturityH,
    /* How many observed rugs landed AFTER the window — i.e. how many of our "false alarms" may in fact be
     * slow catches. Published because a window is a tradeoff and hiding its cost would make it look free. */
    beyondWindowRugs: beyondWindow,
    slowestRugHours: slowestRugH == null ? null : +slowestRugH.toFixed(1),
    maturityWindowBasis: maturityH == null
      ? 'no rug observed yet — nothing can be resolved as a false alarm, so every live flag stays open'
      : '95th percentile of observed rug lifetimes, rounded up (' + maturityH + 'h; slowest ever seen '
        + slowestRugH.toFixed(1) + 'h). A quantile rather than the maximum, because one slow rug used to widen '
        + 'the window enough to reclassify our own confirmed false alarms as "still open" — precision rose '
        + 'with no call improving. ' + beyondWindow + ' of ' + ruggedLifetimesH.length + ' observed rugs landed '
        + 'beyond this window, so roughly that share of what we count against ourselves are slow catches. '
        + 'That is the deliberate side to be wrong on.',

    /* TWO figures, deliberately, because either one alone is a lie in a different direction.
     *
     *   Resolved  — of the strong calls whose outcome is known, how many were right. OPTIMISTIC: it excludes
     *               the young ones, and wins land far faster than losses do.
     *   WorstCase — the same wins over EVERY strong call ever made, i.e. every open call assumed wrong.
     *               PESSIMISTIC: it scores as failures tokens that have not had time to answer.
     *
     * The truth is between them and moves as the open ones resolve. A buyer acting today reads the worst
     * case; a claim about the method quotes both. */
    strongPrecisionResolved: resolvedStrong ? +(strong.length / resolvedStrong).toFixed(2) : null,
    strongPrecisionWorstCase: everStrong ? +(strong.length / everStrong).toFixed(2) : null,

    /* THE DENOMINATOR BEHIND `missedOutright`, published because without it that zero is worthless. */
    cleanVerdictsEmitted: rows.filter((t) => t.firstVerdict === 'clean').length,

    /* THE TOP TIER, and whether anything still reaches it.
     *
     * `rug_ready` used to come entirely from the symbol-impersonation rule — 13 of 13 — and that rule was
     * measured on 2026-07-26 to have NO lift over the base rate, and to score WORSE than random (67% vs
     * 81%) on the cases the funder signal did not already catch. It was moved to its own identity axis, so
     * from that date nothing new reaches this tier.
     *
     * The historical rug_ready calls are LEFT ON THE LEDGER. They were made, they are graded, and rewriting
     * them would be the arranged record this project refuses everywhere else. But a tier nothing can reach
     * has to say so out loud, exactly as `cleanVerdictsEmitted` does for the other end of the scale: a
     * hierarchy whose top level is silently unreachable misleads by shape alone. */
    rugReadyVerdictsEmitted: rows.filter((t) => t.firstVerdict === 'rug_ready').length,

    /* THE FOUNDING SIGNAL, and whether it has ever fired.
     *
     * This project's thesis is that a dangerous power only counts if someone can still fire it — mintable
     * with a live owner is an armed rug, mintable with ownership renounced is inert. `armedAtFirstSight`
     * carries that judgement, and it is EMPTY on every token we have ever seen.
     *
     * Measured 2026-07-26 rather than assumed: GoPlus returns `owner_address` for roughly one token in ten
     * on Base, so `ownerState` is almost always `unknown`, and the three-state rule (correctly) refuses to
     * call a flag "armed" when it cannot show anyone able to fire it. The thesis is not wrong — it is
     * UNOBSERVABLE through this source at the moment a buyer needs it, which is a different and heavier
     * problem than a bug.
     *
     * Published for the same reason `cleanVerdictsEmitted` is: a signal that has never fired looks identical
     * to a market with no danger, and only the denominator tells them apart. `ownerStateReadable` counts the
     * rows where we could see who owns the contract at all; `basisRecorded` is how many rows carry their
     * decision inputs, since anything older than 2026-07-26 cannot be audited at all. */
    /* The watch's own coverage. Published beside the counts it caps, because the alternative is a scorecard
     * that quietly presents "what we saw" as "what happened". */
    watchGaps: blackouts.length,
    hoursUnwatched: +unwatchedHours.toFixed(1),
    longestGapHours: blackouts.length ? Math.max(...blackouts.map((b) => Number(b.hours) || 0)) : 0,
    coverageNote: blackouts.length
      ? blackouts.length + ' gap(s) totalling ' + unwatchedHours.toFixed(1) + 'h when nothing was observed. '
        + 'A launch that appeared AND died inside a gap was never seen and cannot be recovered — the harvest '
        + 'only shows pools that exist now. Every count here is a FLOOR for those periods, and an unwatched '
        + 'hour looks exactly like a quiet one.'
      : 'No observation gap recorded — every count here covers a continuously watched period.',

    armedPowersObserved: rows.filter((t) => Array.isArray(t.armedAtFirstSight) && t.armedAtFirstSight.length > 0).length,
    basisRecorded: rows.filter((t) => t.basisAtFirstSight).length,
    ownerStateReadable: rows.filter((t) => t.basisAtFirstSight && t.basisAtFirstSight.ownerState
      && t.basisAtFirstSight.ownerState !== 'unknown').length,

    note: 'warnRate = share of observed rugs carrying ANY warning at first sight; strongRate = share we '
      + 'called rug_ready or high_risk. Both are published because they say different things: a caution that '
      + 'rugs means the warning was there but too quiet to act on. abstained = rugs we had called unknown, '
      + 'which is honest but useless to a buyer. missedOutright = rugs we had called clean, the only truly '
      + 'damaging error — but read cleanVerdictsEmitted first: at 0 clean verdicts ever given, a 0 there is '
      + 'trivial rather than earned. THE PRECISION FIGURES: there are two and neither may be quoted alone. A '
      + 'strong call on a token that has not rugged is not an error yet, it is OPEN (strongCallsOpen) — rugs '
      + 'resolve in about an hour while a false alarm only proves itself by surviving maturityWindowHours, so '
      + 'counting every live flag as a miss permanently depressed the number with calls that had not had time '
      + 'to answer. strongPrecisionResolved grades only the calls whose outcome is known and is therefore '
      + 'optimistic; strongPrecisionWorstCase assumes every open call is wrong and is therefore pessimistic. '
      + 'The truth is between them, and it moves as the open ones resolve. A buyer acting today should read '
      + 'the worst case.',
  };
}

module.exports = { scoreCalls, isStrongCall };
