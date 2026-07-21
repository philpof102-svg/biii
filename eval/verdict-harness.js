'use strict';
/**
 * BIII verdict eval-harness — the trust verdict, held to a metric, pinned as a diffable artifact.
 * ==================================================================================================
 * Borrowed from the graph-engineering dig (DSPy: compile a policy offline against a metric, save it as a
 * reloadable JSON). BIII's verdict logic (lib/trust.assessTriangle + lib/asset.assessAsset) is DETERMINISTIC
 * and must stay fail-closed. This harness runs a LABELED corpus through it and enforces two non-negotiable
 * gates, then writes eval/policy.json — a behavioral snapshot (what the code actually decided) so a partner
 * can audit WHICH policy produced a verdict, and a reviewer can DIFF the day the behavior changes.
 *
 *   HARD GATE 1 — recall on known-bad = 100%: every negative (flagged reputation, denylisted or
 *                 impersonating asset) MUST come out non-payable / unsafe. A miss here BLESSES a scam.
 *   HARD GATE 2 — fail-closed held = 100%: every ambiguous case (CAUTION, unknown, low score, no data)
 *                 MUST NOT be payable on that signal alone. "Unknown is never safe" — enforced, not hoped.
 *   SOFT metric — positives payable: hand-built clean cases SHOULD pass; reported, not gated (a partner
 *                 tightens thresholds against their own false-positive tolerance).
 *
 * Run:  node eval/verdict-harness.js          (runs the corpus, enforces gates, (re)writes policy.json)
 *       node eval/verdict-harness.js --check   (CI mode: fails if policy.json drifted or a gate breaks)
 * Pure/offline: it imports the verdict code and calls it — it never touches the running server, the chain,
 * or the merchant key. Safe to run while a live till is serving.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assessTriangle } = require('../lib/trust');
const { assessAsset } = require('../lib/asset');

// REAL known-bad addresses (OFAC SDN extract, verified by the datasets scout 2026-07-21). Used as the
// denylist so the asset layer is tested against ground truth, not toy data.
const OFAC_SAMPLE = [
  '0x0330070fd38ec3bb94f58fa55d40368271e9e54a',
  '0x038989cbb1710c72b9920dc4fa529158f463e72c',
  '0xf4377eda661e04b6dda78969796ed31658d602d4',
];
const DENYLIST = new Set(OFAC_SAMPLE);
const REGISTRY = [
  { issuer: 'BlackRock', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity',
    chainId: 1, address: '0x7712c34205737192402172409a8f7ccef8aa2aec', source: 'seed' },
];
const GENUINE = REGISTRY[0].address;
const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };
const PROVEN = { paidMicro: '5000000' };

/* THE CORPUS. Each case: { name, label, run() → verdict, ok(verdict) → bool }.
 * label ∈ 'negative' (must be caught) | 'failclosed' (must not be payable) | 'positive' (should pass). */
const triangle = (rep, standing, settlement, opts) => assessTriangle({ reputation: rep, standing, settlement }, opts || {});
const asset = (token, claim) => assessAsset({ token, ...(claim || {}) }, { registry: REGISTRY, denylist: DENYLIST });

const CASES = [
  // ── NEGATIVES: a flagged counterparty must be unsafe & unpayable, even with every other green ──
  { name: 'BLOCK overrides proven standing + settled payment', label: 'negative',
    run: () => triangle({ decision: 'BLOCK', score: 90 }, PROVEN, PAID),
    ok: (v) => v.trust === 'unsafe' && v.payable === false },
  { name: 'REFUSE with nothing else is unsafe', label: 'negative',
    run: () => triangle({ decision: 'REFUSE' }, null, null), ok: (v) => v.trust === 'unsafe' && !v.payable },
  { name: 'AVOID overrides proven standing', label: 'negative',
    run: () => triangle({ decision: 'AVOID' }, PROVEN, null), ok: (v) => v.trust === 'unsafe' && !v.payable },
  { name: 'DENY / DECLINE / UNSAFE all flag', label: 'negative',
    run: () => ['DENY', 'DECLINE', 'UNSAFE'].map((d) => triangle({ decision: d }, null, null)),
    ok: (vs) => vs.every((v) => v.trust === 'unsafe' && !v.payable) },
  { name: 'whitespace-padded " BLOCK " still flags (trim)', label: 'negative',
    run: () => triangle({ decision: ' BLOCK ' }, PAID && PROVEN, PAID), ok: (v) => v.trust === 'unsafe' },
  { name: 'denylisted OFAC contract is unsafe to acquire', label: 'negative',
    run: () => OFAC_SAMPLE.map((a) => asset(a)), ok: (vs) => vs.every((v) => v.status === 'unsafe' && v.safeToAcquire === false) },
  { name: 'impersonation: claims BUIDL but is a lookalike address', label: 'negative',
    run: () => asset('0x' + 'ee'.repeat(20), { claimedSymbol: 'BUIDL' }),
    ok: (v) => v.status === 'impersonation' && v.safeToAcquire === false },

  // ── FAIL-CLOSED: ambiguous signals must never be payable on their own ──
  { name: 'CAUTION alone is not payable', label: 'failclosed',
    run: () => triangle({ decision: 'CAUTION', score: 80 }, null, null), ok: (v) => v.payable === false },
  { name: 'PROCEED but score below floor is weak, not payable alone', label: 'failclosed',
    run: () => triangle({ decision: 'PROCEED', score: 10 }, null, null, { minScore: 40 }), ok: (v) => v.payable === false },
  { name: 'no reputation data at all → unknown, not payable', label: 'failclosed',
    run: () => triangle(null, null, null), ok: (v) => v.trust === 'unknown' && !v.payable },
  { name: 'unknown decision string → not payable', label: 'failclosed',
    run: () => triangle({ decision: 'MAYBE' }, null, null), ok: (v) => v.payable === false },
  { name: 'unknown contract with no claim → not safe to acquire', label: 'failclosed',
    run: () => asset('0x' + 'ab'.repeat(20)), ok: (v) => v.status === 'unknown' && v.safeToAcquire === false },
  { name: 'non-finite score never clears', label: 'failclosed',
    run: () => triangle({ score: NaN }, null, null), ok: (v) => v.payable === false },

  // ── POSITIVES: clean cases should pass (soft) ──
  { name: 'PROCEED at/above floor is trusted & payable', label: 'positive',
    run: () => triangle({ decision: 'PROCEED', score: 71 }, null, null, { minScore: 40 }), ok: (v) => v.payable === true },
  { name: 'proven standing alone is trusted & payable', label: 'positive',
    run: () => triangle(null, PROVEN, null), ok: (v) => v.payable === true },
  { name: 'PROCEED + settled on-chain is settled & proven', label: 'positive',
    run: () => triangle({ decision: 'PROCEED', score: 71 }, null, PAID), ok: (v) => v.trust === 'settled' && v.proven === true },
  { name: 'genuine registry contract is safe to acquire', label: 'positive',
    run: () => asset(GENUINE, { claimedSymbol: 'BUIDL' }), ok: (v) => v.status === 'genuine' && v.safeToAcquire === true },
];

function runCorpus() {
  const byLabel = { negative: { total: 0, ok: 0 }, failclosed: { total: 0, ok: 0 }, positive: { total: 0, ok: 0 } };
  const failures = [];
  // behavioral snapshot of the reputation classifier — so policy.json reflects the CODE, not a copy
  const repSnapshot = {};
  for (const d of ['PROCEED', 'PROCEED_LOW_VALUE', 'CAUTION', 'BLOCK', 'REFUSE', 'AVOID', 'DENY', 'DECLINE', 'UNSAFE', 'MAYBE']) {
    repSnapshot[d] = triangle({ decision: d, score: 71 }, null, null).vertices.reputation.status;
  }
  for (const c of CASES) {
    const bucket = byLabel[c.label];
    bucket.total++;
    let pass = false;
    try { pass = !!c.ok(c.run()); } catch (e) { pass = false; }
    if (pass) bucket.ok++; else failures.push(c.label + ': ' + c.name);
  }
  const recall = byLabel.negative.total ? byLabel.negative.ok / byLabel.negative.total : 1;
  const failClosedHeld = byLabel.failclosed.total ? byLabel.failclosed.ok / byLabel.failclosed.total : 1;
  const positivesPayable = byLabel.positive.total ? byLabel.positive.ok / byLabel.positive.total : 1;
  return { byLabel, failures, recall, failClosedHeld, positivesPayable, repSnapshot };
}

// deterministic fingerprint of the corpus (names+labels) — a stable id for "which cases were run"
function corpusFingerprint() {
  const canon = CASES.map((c) => c.label + '|' + c.name).sort().join('\n');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function buildPolicy(r) {
  return {
    artifact: 'biii-verdict-policy',
    generatedFrom: 'lib/trust.assessTriangle + lib/asset.assessAsset',
    policy: {
      minScoreDefault: 40,
      reputationClassification: r.repSnapshot,               // decision → status, as the CODE decides it
      overrideRule: 'reputation.status==="unsafe" forces trust="unsafe" and payable=false, over any other green',
      failClosed: 'unknown / CAUTION / below-floor / non-finite-score are never payable on reputation alone',
      assetStatuses: ['genuine (payable)', 'impersonation/unsafe (blocked)', 'unknown (not payable)'],
      denylistSource: 'OFAC SDN extract (0xB10C) sample; production injects the full MainStreet denylist',
    },
    corpus: { fingerprint: corpusFingerprint(), size: CASES.length,
      negatives: r.byLabel.negative.total, failclosed: r.byLabel.failclosed.total, positives: r.byLabel.positive.total },
    metrics: { recall: r.recall, failClosedHeld: r.failClosedHeld, positivesPayable: r.positivesPayable },
    gates: { recall: 1, failClosedHeld: 1 },                 // the non-negotiable thresholds
  };
}

function main() {
  const check = process.argv.includes('--check');
  const r = runCorpus();
  const policy = buildPolicy(r);
  const outPath = path.join(__dirname, 'policy.json');
  const rendered = JSON.stringify(policy, null, 2) + '\n';

  console.log('BIII verdict eval-harness — ' + CASES.length + ' cases (fingerprint ' + policy.corpus.fingerprint + '):');
  for (const [label, b] of Object.entries(r.byLabel)) console.log('  ' + label.padEnd(11) + ' ' + b.ok + '/' + b.total);
  if (r.failures.length) { console.log('  FAILURES:'); for (const f of r.failures) console.log('   ✗ ' + f); }
  console.log('  metrics: recall=' + r.recall + ' failClosedHeld=' + r.failClosedHeld + ' positivesPayable=' + r.positivesPayable);

  // THE GATES — a scam blessed (recall<1) or an ambiguous case waved through (failClosedHeld<1) is fatal.
  const gateBreach = [];
  if (r.recall < 1) gateBreach.push('recall on known-bad = ' + r.recall + ' (< 1.0): a flagged counterparty/asset was NOT caught');
  if (r.failClosedHeld < 1) gateBreach.push('fail-closed held = ' + r.failClosedHeld + ' (< 1.0): an ambiguous case became payable');

  if (check) {
    let drift = null;
    try { const cur = fs.readFileSync(outPath, 'utf8'); if (cur !== rendered) drift = 'policy.json differs from the current verdict behavior'; }
    catch { drift = 'policy.json missing — run `node eval/verdict-harness.js` to generate it'; }
    if (gateBreach.length || drift) {
      for (const g of gateBreach) console.error('  ⛔ GATE: ' + g);
      if (drift) console.error('  ⛔ DRIFT: ' + drift);
      process.exit(1);
    }
    console.log('  ✅ --check: gates hold, policy.json matches current behavior');
    return;
  }

  if (gateBreach.length) { for (const g of gateBreach) console.error('  ⛔ GATE: ' + g); process.exit(1); }
  fs.writeFileSync(outPath, rendered);
  console.log('  ✅ gates hold — wrote ' + path.relative(process.cwd(), outPath));
}

main();
