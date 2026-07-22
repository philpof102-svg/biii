'use strict';
/**
 * trust-core — MainStreet's trust JUDGMENT, decentralized.
 * ================================================================================================
 * MainStreet does two separable things: it OBSERVES the world (an indexer watching x402/Base/the bazaar
 * fills its tables) and it JUDGES (a pure classifier turns those signals into a verdict). The observation
 * needs a service — you cannot decentralize watching the chain. The JUDGMENT does not: given the same
 * signals, anyone computes the same verdict. This package is that judgment, extracted PURE — no DB, no
 * network, no deps — so any node runs the classifier locally instead of trusting one operator's hosted
 * endpoint. Feed it signals (from your own known-bad screen + whatever you observe or inject); it returns
 * the same shield + decision the hosted MainStreet returns. Observation stays a reproducible service whose
 * data is re-verifiable (settlements are on-chain, known-bad is public).
 *
 * PARITY: flag keys/severities, detail strings, flag ORDER, reasonShort/explainer formats and the color
 * rollup are kept BYTE-IDENTICAL to the hosted classifier (avisradar trust-shield.js) ON WELL-FORMED
 * DATA, so the hosted service can delegate here with a provable fixture diff (see PARITY.md). The
 * deliberate exceptions are safety HARDENING: the positive-availability deny gate, the trustedSignals
 * allowlist gate, and the malformed-lens guards. The malformed guards ARE reachable through a real DB
 * adapter — SQLite's dynamic typing lets corrupt/tampered rows produce Infinity volumes or TEXT block
 * numbers (an adversarial pass proved it) — which is exactly why they are severity HIGH: corrupted
 * observation must never grade below the risk it masks. Each exception yields extra caution, never
 * extra trust; on corrupt data this classifier is deliberately STRICTER than the legacy one.
 *
 * THE ONE INVARIANT (fail-CLOSED, never open): the known-bad DENY signal is safety-critical, so its
 * ABSENCE must read as "screening unavailable → refuse", NOT as "not denylisted → clear". Every other
 * signal is a risk ENHANCER (it can only add caution); its absence honestly means "unverified", which
 * yields green-unverified / PROCEED_LOW_VALUE, never a confident green. A decentralized classifier that
 * fails open is worse than a centralized one — this file exists to make it fail closed.
 */

// ── URL heuristics — VERBATIM from the hosted classifier (KNOWN_GOOD_HOSTS + SAFE_SUFFIXES over the
//    last-two host labels; an unparseable URL is SUSPICIOUS, never silently clean). ─────────────────
// Domains we've seen ship real x402 services. Add when traffic confirms safe.
const KNOWN_GOOD_HOSTS = new Set([
  'fly.dev', 'onrender.com', 'vercel.app', 'workers.dev',
  'railway.app', 'up.railway.app', 'render.com', 'pages.dev',
  'replit.app', 'replit.dev', 'modal.run', 'fly.io',
]);
// Hosts that legitimately publish from a "registry" subdomain — never flag.
const SAFE_SUFFIXES = ['.com', '.io', '.xyz', '.dev', '.ai', '.app', '.net', '.so', '.fyi', '.cc', '.tech'];

function tldOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // .fly.dev, .vercel.app etc — keep the platform suffix
    for (const known of KNOWN_GOOD_HOSTS) {
      if (host.endsWith('.' + known) || host === known) return known;
    }
    const parts = host.split('.');
    if (parts.length >= 2) return '.' + parts.slice(-2).join('.');
    return host;
  } catch { return null; }
}

function isSuspiciousTld(url) {
  const tld = tldOf(url);
  if (!tld) return true;
  if (KNOWN_GOOD_HOSTS.has(tld)) return false;
  for (const suf of SAFE_SUFFIXES) if (tld.endsWith(suf)) return false;
  return true;
}

/**
 * buildShield — the PURE trust shield. Same logic as MainStreet's buildTrustShield, but over INJECTED
 * signals instead of DB rows. Returns { color:'red'|'yellow'|'green', flags[], reasonShort, explainer,
 * denylisted?, denylistUnavailable?, allowlisted?, allowlistLabel? }.
 *
 * signals = {
 *   deny:   { available:boolean, entry:{reason,severity}|null, errorMessage?, asOf? },  // REQUIRED lens; anything but available===true ⇒ fail-closed red
 *   allow:  { entry:{label,reason,source}|null } | null,
 *   settlement: { payerShares:number[], totalVol:number, count:number, firstBlock:number, lastBlock:number, headBlock:number } | null,
 *   sla:    { n:number, oks:number } | null,
 *   bazaar: { resourcePath:string } | null,
 *   sniper: { launchesSniped:number, lastSeen:string } | null,   // lens PRESENCE flags (row-presence semantics)
 *   negativeReceipts: number | null,
 *   lawgeckoFlag: {key,severity,detail} | null,
 * }
 *
 * opts.trustedSignals — attests the bag comes from a locally-trusted source (the operator's own DB or
 * this node's own observation). Required for the operator-allowlist green short-circuit: in a relayed
 * bag, `allow` is attacker-fabricable, so without the attestation it degrades to advisory.
 */
function buildShield(signals = {}, { trustedSignals = false } = {}) {
  const flags = [];
  const s = signals || {};

  // 0a) DENY — safety-critical, checked FIRST and FAIL-CLOSED. The gate is POSITIVE: the caller must
  //     PROVE screening actually ran (deny.available === true, a real boolean). EVERY other state —
  //     omitted, null, {}, available:'false'|0|undefined, or any non-true value — reads as "screening
  //     unavailable → refuse", never a fall-through that could reach green. Absence of screening is
  //     never absence of risk. When the observation layer DID try and failed, it passes errorMessage
  //     and gets the hosted classifier's exact fail-closed strings (parity); the generic strings cover
  //     the absent/unproven-lens branch the hosted DB adapter can never reach.
  const deny = s.deny;
  if (!deny || deny.available !== true) {
    const em = deny && deny.errorMessage;
    return {
      color: 'red',
      flags: [em
        ? { key: 'denylist-unavailable', severity: 'high', detail: `Denylist check failed (${em}) — cannot confirm this address is not known-bad.` }
        : { key: 'denylist-unavailable', severity: 'high', detail: 'Known-bad screening unavailable — cannot confirm this address is not known-bad; refusing by default.' }],
      reasonShort: 'denylist-unavailable',
      explainer: em
        ? 'BLOCKED (fail-closed): the known-bad denylist could not be checked, so this address cannot be confirmed safe — refusing by default.'
        : 'BLOCKED (fail-closed): the known-bad screen could not be consulted, so this address cannot be confirmed safe.',
      denylistUnavailable: true,
      ...(deny && deny.asOf ? { asOf: deny.asOf } : {}),
    };
  }
  if (deny.entry) {
    return {
      color: 'red',
      flags: [{ key: 'denylisted', severity: deny.entry.severity || 'high', detail: `Denylisted: ${deny.entry.reason}` }],
      reasonShort: 'denylisted',
      explainer: `BLOCKED: ${deny.entry.reason}. Do not pay this address — confirmed unsafe.`,
      denylisted: true,
    };
  }

  // 0b) ALLOW — an OPERATOR entry forces green, but ONLY when the caller attests the signal bag is
  //     locally trusted (opts.trustedSignals; the hosted DB adapter always passes true — its allowlist
  //     table IS the operator's own store). In an untrusted/relayed bag `allow` is just another field an
  //     attacker can forge, so absent the attestation an operator entry degrades to advisory and falls
  //     through to the risk checks. An 'auto-allowlist' entry is ALWAYS advisory (derived from
  //     attacker-manufacturable score+jobCount) and falls through, exactly as hosted.
  const allowEntry = s.allow && s.allow.entry;
  if (trustedSignals && allowEntry && allowEntry.source !== 'auto-allowlist') {
    return {
      color: 'green',
      flags: [{ key: 'allowlisted', severity: 'positive', detail: `Allowlisted (${allowEntry.label}): ${allowEntry.reason} · source: ${allowEntry.source}` }],
      reasonShort: 'allowlisted',
      explainer: `TRUSTED: ${allowEntry.label}. ${allowEntry.reason}.`,
      allowlisted: true,
      allowlistLabel: allowEntry.label,
    };
  }
  let autoAllowlisted = false, autoAllowLabel = null;
  if (allowEntry) {
    if (allowEntry.source === 'auto-allowlist') {
      autoAllowlisted = true; autoAllowLabel = allowEntry.label;
      flags.push({ key: 'auto-allowlisted', severity: 'positive', detail: `Auto-allowlisted (${allowEntry.label}): ${allowEntry.reason} — advisory only, risk checks still apply.` });
    } else {
      // untrusted operator entry — hosted can never emit this key (its DB is intrinsically trusted)
      flags.push({ key: 'allowlist-advisory', severity: 'positive', detail: `Allowlist hint (${allowEntry.label}, source: ${allowEntry.source}) — signals untrusted, advisory only; risk checks still apply.` });
    }
  }

  // 1) single-payer / concentrated-payer (from observed settlements). Absent ⇒ skipped (unverified).
  //    Present-but-malformed (non-finite shares) ⇒ 'settlement-malformed' (do-not-clear), a guard the
  //    hosted adapter never triggers (it zero-guards vol/total itself).
  const st = s.settlement;
  let singlePayer = false;
  if (st && Array.isArray(st.payerShares) && st.payerShares.length) {
    const shares = st.payerShares.map(Number);
    const total = Number(st.totalVol) || 0;
    if (shares.some((x) => !Number.isFinite(x))) {
      // HIGH, not medium: a malformed payer-share lens means the observation data is corrupted or
      // tampered (e.g. a hostile TEXT amount CASTing to Infinity), and the sybil check it replaces is
      // itself a HIGH flag — grading corruption below the risk it hides was a proven fail-open vs the
      // legacy classifier (Infinity single-payer: legacy BLOCK, malformed-medium only CAUTION).
      flags.push({ key: 'settlement-malformed', severity: 'high', detail: 'Settlement payer-share lens present but malformed (non-numeric shares) — cannot assess payer concentration; refusing (corrupted observation is not unverified, it is untrustworthy).' });
    } else {
      const top = Math.max(...shares);
      if (shares.length === 1 && total > 0.5) { flags.push({ key: 'single-payer', severity: 'high', detail: `100% of $${total.toFixed(2)} volume from 1 buyer — sybil signal.` }); singlePayer = true; }
      else if (top > 0.8 && total > 1) flags.push({ key: 'concentrated-payer', severity: 'medium', detail: `${Math.round(top * 100)}% of volume from 1 buyer.` });
    }
  }

  // 2) fresh-operator (block-derived: Base seals a block every 2s). Absent bounds ⇒ skipped.
  const BASE_BLOCKS_PER_DAY = 43200; // 86400s / 2s
  let freshOperator = false;
  if (st && Number(st.headBlock) && Number(st.firstBlock)) {
    const ageDays = (st.headBlock - st.firstBlock) / BASE_BLOCKS_PER_DAY;
    if (ageDays < 7) {
      flags.push({ key: 'fresh-operator', severity: 'medium', detail: `Operator first seen ~${ageDays.toFixed(1)} days ago (block-derived).` });
      freshOperator = true;
    }
  }

  // 3) SLA probes. Guard the NaN escape: a present lens with n>0 but a non-finite oks must NOT silently
  //    skip the all-probes-failed check. A present-but-malformed count is 'sla-malformed' (do-not-clear)
  //    — unreachable via the hosted adapter (COUNT/SUM always return numbers).
  const sla = s.sla;
  if (sla != null) {
    const n = Number(sla.n), oks = Number(sla.oks);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(oks)) {
      if (oks === 0) flags.push({ key: 'all-probes-failed', severity: 'high', detail: `Every SLA probe (${n} samples) failed — endpoint dead or hostile.` });
    } else if (Number.isFinite(n) && n === 0) {
      flags.push({ key: 'no-probes-yet', severity: 'low', detail: 'No SLA probes recorded yet — endpoint unverified.' });
    } else {
      // HIGH for the same reason as settlement-malformed: the check this corruption hides
      // (all-probes-failed) is itself HIGH — corruption must never grade below the risk it masks.
      flags.push({ key: 'sla-malformed', severity: 'high', detail: 'SLA probe lens present but malformed (non-numeric counts) — cannot confirm probes passed; refusing (corrupted observation is not unverified, it is untrustworthy).' });
    }
  }

  // 4) resource path: http / suspicious TLD / admin route (all three can fire on one path)
  const path = s.bazaar && s.bazaar.resourcePath;
  if (path) {
    if (String(path).startsWith('http://')) flags.push({ key: 'http-not-https', severity: 'high', detail: 'Resource served over plain HTTP — credentials would leak.' });
    if (isSuspiciousTld(path)) flags.push({ key: 'suspicious-tld', severity: 'medium', detail: `Unusual TLD: ${tldOf(path)}` });
    if (/\/(admin|internal|debug|drop)\b/i.test(path)) flags.push({ key: 'admin-path', severity: 'medium', detail: 'Resource path contains admin/internal/debug — unusual for a paid service.' });
  }

  // 5) dormant (block-derived, received side)
  if (st && Number(st.headBlock) && Number(st.lastBlock)) {
    const days = (st.headBlock - st.lastBlock) / BASE_BLOCKS_PER_DAY;
    if (days > 30) flags.push({ key: 'dormant', severity: 'low', detail: `No settlements for ~${Math.floor(days)} days (block-derived).` });
  }

  // 6) zero-history (never any settlement — different from dormant). Fires only on a REAL observed zero:
  //    count null/undefined/non-numeric means "not observed", which must not assert never-paid.
  if (st && st.count != null && Number(st.count) === 0) flags.push({ key: 'never-paid', severity: 'medium', detail: 'No x402 settlement ever received — endpoint exists but never actually used.' });

  // 7) known sniper — row-presence semantics, exactly as hosted (a sniper row flags even at 0 sniped).
  if (s.sniper != null) {
    const sev = Number(s.sniper.launchesSniped) >= 5 ? 'high' : 'medium';
    flags.push({ key: 'known-sniper', severity: sev, detail: `Sniped ${s.sniper.launchesSniped} token launches within first 10 blocks. Last seen ${s.sniper.lastSeen}.` });
  }

  // 8) negative ERC-8004 feedback
  if (Number(s.negativeReceipts) > 0) flags.push({ key: 'negative-feedback', severity: 'high', detail: `${s.negativeReceipts} negative on-chain receipt(s) about this agent.` });

  // 9) LawGecko deployer conduct (injected verbatim from conductFlag(); the severity guard is
  //    unreachable when the adapter passes conductFlag output, which always sets severity)
  if (s.lawgeckoFlag && s.lawgeckoFlag.severity) flags.push(s.lawgeckoFlag);

  // Aggregate color — identical thresholds to MainStreet.
  const highCount = flags.filter((f) => f.severity === 'high').length;
  const medCount = flags.filter((f) => f.severity === 'medium').length;
  let color = 'green';
  if (highCount >= 1 || medCount >= 3) color = 'red';
  else if (medCount >= 1 || (singlePayer && freshOperator)) color = 'yellow';
  if (flags.length === 0) color = 'green';

  // Presentation — hosted formats verbatim, with ONE honest exception: when the behavioral lenses were
  // never OBSERVED at all (no settlement AND no sla lens supplied — the decentralized cold start), an
  // empty shield says 'green-unverified', never hosted's confident 'No risk signals detected'. The hosted
  // adapter always supplies both lenses (observed zeros), so this branch is unreachable there and the
  // fixture diff stays clean.
  const unverified = flags.length === 0 && s.settlement == null && s.sla == null;
  const reasons = unverified ? 'green-unverified' : (flags.map((f) => `${f.severity}:${f.key}`).join(', ') || 'no flags');
  return {
    color, // 'green' | 'yellow' | 'red'
    flags,
    reasonShort: reasons,
    explainer: unverified
      ? 'No signals yet — unverified, not proven safe.'
      : color === 'red'
        ? 'Multiple risk signals — DO NOT pay this agent without HITL review.'
        : color === 'yellow'
          ? 'Some risk signals — proceed with caution or low-value test call first.'
          : 'No risk signals detected. Standard x402 trust assumptions apply.',
    // Only surface the allowlist badge for an AUTO entry if it actually survived the risk checks
    // (ended green). A sybil-flagged auto entry is yellow/red and must not carry a "trusted" badge.
    ...(autoAllowlisted && color === 'green' ? { allowlisted: true, allowlistLabel: autoAllowLabel } : {}),
  };
}

// preflightDecision — VERBATIM from MainStreet's preflight-core.js (already pure). decision ∈
// BLOCK | CAUTION | PROCEED | PROCEED_LOW_VALUE.
function preflightDecision(shield, scoreRow) {
  let decision, reasoning;
  if (shield.denylisted || shield.denylistUnavailable) {
    decision = 'BLOCK';
    reasoning = shield.explainer || `Red shield (${shield.reasonShort}).`;
  } else if (shield.color === 'red') {
    decision = 'BLOCK';
    reasoning = `Red shield (${shield.reasonShort}). Do not pay without human review.`;
  } else if (shield.color === 'yellow' && (!scoreRow || scoreRow.score < 30)) {
    decision = 'CAUTION';
    reasoning = `Yellow shield + low/no score. Start with the smallest possible payment to test the endpoint before committing more.`;
  } else if (shield.color === 'yellow') {
    decision = 'CAUTION';
    reasoning = `Yellow shield (${shield.reasonShort}). Score=${(scoreRow && scoreRow.score) || 'unranked'} suggests OK to proceed but watch for issues.`;
  } else if (scoreRow && scoreRow.score >= 50) {
    decision = 'PROCEED';
    reasoning = `Green shield + score ${scoreRow.score}/100 + ${scoreRow.job_count} prior jobs. Standard trust assumptions apply.`;
  } else if (scoreRow && scoreRow.score >= 30) {
    decision = 'PROCEED';
    reasoning = `Green shield + moderate score ${scoreRow.score}/100. Safe but not yet proven at scale.`;
  } else {
    decision = 'PROCEED_LOW_VALUE';
    reasoning = `Green shield but no/low score. Use only for low-value calls until proof builds up.`;
  }
  return { decision, reasoning };
}

// isAllowed — VERBATIM gate semantics: BLOCK always refused; CAUTION refused below minScore; PROCEED* ok.
function isAllowed(decision, score, minScore = 30) {
  if (decision === 'BLOCK') return false;
  if (decision === 'CAUTION' && (score == null || Number(score) < minScore)) return false;
  return true;
}

/** verdict — the whole judgment in one call: signals → shield → decision. Pure, offline, deterministic.
 *  opts.trustedSignals attests the signal bag came from a locally-trusted source (the operator's own DB
 *  or this node's own observation) — required to honor the operator-allowlist green short-circuit. */
function verdict(signals, scoreRow, { minScore = 30, trustedSignals = false } = {}) {
  const shield = buildShield(signals, { trustedSignals });
  const d = preflightDecision(shield, scoreRow);
  return { decision: d.decision, reasoning: d.reasoning, allowed: isAllowed(d.decision, scoreRow && scoreRow.score, minScore), shield };
}

const score = require('./score');

module.exports = { buildShield, preflightDecision, isAllowed, verdict, isSuspiciousTld, tldOf, KNOWN_GOOD_HOSTS, SAFE_SUFFIXES, ...score };
