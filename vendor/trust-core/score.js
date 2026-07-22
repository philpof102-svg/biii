'use strict';
/**
 * trust-core/score — the SCORE half of MainStreet's judgment, extracted PURE.
 * ================================================================================================
 * MainStreet's 0-100 numbers are computed by pure formulas over injected metrics; the only impurity
 * in the hosted source (avisradar oracle.js) was a single `process.env.MAINSTREET_OUTCOME_ADJUST`
 * read inside computeActivityScore — parameterized here as `{ outcomeAdjust }` so the scorer is
 * fully deterministic: same metrics (+ same options) ⇒ same score on any node, offline.
 *
 * Formulas are kept BYTE-IDENTICAL to the hosted implementation (drift here would silently change
 * every ranking). The metrics themselves are OBSERVATION (indexer aggregates: settlements, SLA,
 * proofs, outcomes) — that stays a service; only the scoring judgment is decentralized. A score is
 * ADVISORY by design: it can raise trust, but the fail-closed shield (index.js) always gates first.
 */

const SUBJECT_TYPES = {
  BUSINESS_GOOGLE: 'business-google',
  AGENT_ONCHAIN: 'agent-onchain',
  DEPLOYER_ONCHAIN: 'deployer-onchain',
};

/** Business (Google rating + review volume) → 0-100. */
function computeScoreBusiness(snapshot) {
  const rating = Number(snapshot?.rating) || 0;
  const reviewCount = Number(snapshot?.reviewCount) || 0;
  const ratingPart = Math.max(0, Math.min(60, (rating / 5) * 60));
  const volumePart = Math.max(0, Math.min(40, Math.log10(Math.max(1, reviewCount)) * 10));
  return Math.round(ratingPart + volumePart);
}

/** AI agent (successRate 50 · usdcVolume 30 · recency 20), sample-confidence guarded → 0-100. */
function computeScoreAgent(metrics) {
  // ?? 0 not || 0 — daysSinceLastJob can legitimately be 0 (active today)
  const successRate = Math.max(0, Math.min(1, Number(metrics?.successRate ?? 0)));
  const usdcVolume = Math.max(0, Number(metrics?.usdcVolume ?? 0));
  const daysSinceLastJob = Math.max(0, Number(metrics?.daysSinceLastJob ?? 365));
  const jobCount = Math.max(0, Number(metrics?.jobCount ?? 0));

  // Success rate: 50 pts, penalized under 10 jobs so 1 success ≠ a perfect score.
  const sampleConfidence = Math.min(1, jobCount / 10);
  const successPart = successRate * 50 * sampleConfidence;

  // Volume: log10($) capped at 5 (= $100k cumulative) → 30 pts max
  const volumePart = Math.min(30, Math.log10(Math.max(1, usdcVolume)) * 6);

  // Recency: 30-day decay, 20 pts if < 1 day, 0 if > 30
  const recencyPart = Math.max(0, 20 * Math.exp(-daysSinceLastJob / 15));

  return Math.round(successPart + volumePart + recencyPart);
}

/**
 * Composite activity rank (public leaderboard) → 0-100.
 * opts.outcomeAdjust replaces the hosted `process.env.MAINSTREET_OUTCOME_ADJUST === '1'` read —
 * the ONE impurity removed in extraction. The hosted adapter passes the env read as this option.
 */
function computeActivityScore(metrics, { outcomeAdjust = false } = {}) {
  const jobCount = Math.max(0, Number(metrics?.jobCount ?? 0));
  const daysSinceLastJob = Math.max(0, Number(metrics?.daysSinceLastJob ?? 30));
  const successRate = metrics?.successRate == null ? null : Math.max(0, Math.min(1, Number(metrics.successRate)));
  const alive = metrics?.alive;
  // Longevity signals — agent has been around for a while + showed up consistently
  const ageDays = Math.max(0, Number(metrics?.ageDays ?? 0));
  const snapshotDays = Math.max(0, Number(metrics?.snapshotDaysLast30 ?? 0));
  // Diversity — number of distinct tags / categories surfaced in Bazaar metadata
  const tagCount = Math.max(0, Number(metrics?.tagCount ?? 0));

  // Activity (40 pts max)
  const activityPart = Math.min(40, Math.log10(Math.max(1, jobCount)) * 10);

  // Recency (15 pts max)
  const recencyPart = Math.max(0, 15 * Math.exp(-daysSinceLastJob / 15));

  // Reputation (30 pts max)
  let reputationPart = 0;
  if (successRate != null) {
    const sampleConfidence = Math.min(1, jobCount / 10);
    reputationPart = successRate * 30 * sampleConfidence;
  }

  // Health (-3 to +5)
  let healthPart = 0;
  if (alive === true) healthPart = 5;
  else if (alive === false) healthPart = -3;

  // Longevity & diversity (10 pts max)
  let agePart = 0;
  if (ageDays >= 30) agePart = 3;
  else if (ageDays >= 14) agePart = 2;
  else if (ageDays >= 7) agePart = 1;

  let consistencyPart = 0;
  if (snapshotDays >= 21) consistencyPart = 3;
  else if (snapshotDays >= 10) consistencyPart = 2;
  else if (snapshotDays >= 5) consistencyPart = 1;

  let diversityPart = 0;
  if (tagCount >= 5) diversityPart = 4;
  else if (tagCount >= 2) diversityPart = 2;

  const longevityPart = agePart + consistencyPart + diversityPart;

  // Multi-source identity proofs, capped at +15 for activity (vs +25 for deployer).
  const proofs = Array.isArray(metrics?.proofs) ? metrics.proofs : [];
  const proofBonus = Math.min(15, proofs.reduce((s, p) => s + (Number(p?.weight) || 5), 0));

  // Outcome history adjustment (option-gated; the hosted adapter wires its env flag here).
  // Bonus: +3 per graduated (cap +6), Malus: -10 per rugged (cap -20). Abandoned: informational only.
  let outcomePart = 0;
  if (outcomeAdjust && metrics?.outcomeHistory) {
    const oh = metrics.outcomeHistory;
    outcomePart = Math.min(6, 3 * (Number(oh.graduated) || 0))
                - Math.min(20, 10 * (Number(oh.rugged) || 0));
  }

  return Math.max(0, Math.min(100, Math.round(
    activityPart + recencyPart + reputationPart + healthPart + longevityPart + proofBonus + outcomePart
  )));
}

/** LawGecko conduct penalty on a deployer score. Penalty-only; CLEAN/UNKNOWN/none = 0. */
function conductScorePenalty(conduct) {
  switch (String(conduct && conduct.conduct || '').toUpperCase()) {
    case 'ABUSIVE': return 25; // majority of deployed tokens are honeypots/rugs
    case 'RISKY': return 12;
    case 'MIXED': return 4;
    default: return 0;         // CLEAN / UNKNOWN / none
  }
}

/** Token-deployer reputation (survival · liquidity · recency×survival · diversity · age · proofs − conduct) → 0-100. */
function computeScoreDeployer(m) {
  const launchCount = Math.max(0, Number(m?.launchCount ?? 0));
  // Identity-only path: no launches but external proofs — proof bonus counts standalone.
  if (launchCount === 0) {
    const proofs = Array.isArray(m?.proofs) ? m.proofs : [];
    const bonus = Math.min(40, proofs.reduce((s, p) => s + (Number(p?.weight) || 5), 0));
    return bonus;
  }
  const survivalRate = Math.max(0, Math.min(1, Number(m?.survivalRate ?? 0)));
  const liquidity = Math.max(0, Number(m?.cumulativeLiquidityUsd ?? 0));
  const daysSinceLast = Math.max(0, Number(m?.daysSinceLastLaunch ?? 365));
  const diversity = Math.max(0, Number(m?.platformDiversity ?? 0));
  const ageDays = Math.max(0, Number(m?.walletAgeDays ?? 0));

  // Sample confidence — 1 launch at 100% survival ≠ 50 launches at 100%.
  const sampleConfidence = Math.min(1, launchCount / 5);

  const survivalPart = survivalRate * 40 * sampleConfidence;
  const liquidityPart = Math.min(25, Math.log10(Math.max(1, liquidity)) * 4.2);
  // Recency ATTENUATED by survivalRate — a serial rugger that launched yesterday earns no boost.
  const recencyPart = Math.max(0, 15 * Math.exp(-daysSinceLast / 30) * survivalRate);
  const diversityPart = diversity >= 3 ? 10 : (diversity === 2 ? 6 : (diversity === 1 ? 2 : 0));
  const agePart = Math.min(10, Math.log10(Math.max(1, ageDays)) * 3.6);
  const proofs = Array.isArray(m?.proofs) ? m.proofs : [];
  const proofBonus = Math.min(25, proofs.reduce((s, p) => s + (Number(p?.weight) || 5), 0));
  const conductPenalty = conductScorePenalty(m?.onchainConduct);

  return Math.max(0, Math.min(100, Math.round(
    survivalPart + liquidityPart + recencyPart + diversityPart + agePart + proofBonus - conductPenalty
  )));
}

/** Dispatcher — routes on subjectType (options forwarded for computeActivityScore-style callers). */
function computeScore(subject) {
  if (subject?.subjectType === SUBJECT_TYPES.AGENT_ONCHAIN) return computeScoreAgent(subject);
  if (subject?.subjectType === SUBJECT_TYPES.DEPLOYER_ONCHAIN) return computeScoreDeployer(subject);
  return computeScoreBusiness(subject);
}

module.exports = { SUBJECT_TYPES, computeScoreBusiness, computeScoreAgent, computeActivityScore,
  conductScorePenalty, computeScoreDeployer, computeScore };
