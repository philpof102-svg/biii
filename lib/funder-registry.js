'use strict';
/**
 * funder-registry.js — "has this payer already killed?"
 * =====================================================
 * The question this scanner was built to answer is "is this token dangerous", and answering it requires a
 * security index that, measured on Base, has nothing to say about a contract forty seconds old: GoPlus
 * returns `owner_address` for roughly one token in ten, so `armedAtFirstSight` is empty on 221 of 221 tokens
 * we have ever seen. The founding thesis — a dangerous power only counts if someone can still fire it — is
 * not wrong, it is unobservable at the moment a buyer needs it.
 *
 * A different question survives that problem, because it is answered entirely from our own accumulated
 * history and needs no third party at all:
 *
 *     Has the wallet that PAID for this launch already killed one?
 *
 * ═══ THE EVIDENCE, AND HOW IT WAS OBTAINED ═══
 * PREQUENTIAL, not retrospective. Every token was walked in chronological order, and each prediction used
 * ONLY what was known about its funder from strictly earlier observations. A prediction can therefore never
 * have seen its own outcome, nor any later one. This is the difference between "83% of tokens behind such a
 * funder rugged" — a statistic computed knowing every result — and a claim that can be acted on.
 *
 * Measured 2026-07-26 over 221 tracked Base launches, resolved at a p95 maturity window:
 *
 *   what we knew BEFORE seeing it            rugged  survived   rate   vs base
 *   funder had already killed (>=1 prior)        62         5    93%    +41 pts
 *   funder known, no prior rug                    0        13     0%    -52 pts
 *   funder never seen before                      6        14    30%    -22 pts
 *   funder not traceable                         24        54    31%    -21 pts
 *   base rate                                                    52%
 *
 * ═══ WHAT THIS IS NOT ═══
 * The 93% rests on SIX distinct funders, and all six were majority-lethal (91%, 94%, 94%, 100%, 100%, 75%),
 * so it is a replicated effect rather than one outlier — but it is six operators, not sixty. The mirror
 * claim ("a known funder with no prior rug is safe") has had three payers pass through it and only TWO with
 * any resolved token at all, so it is reported as suggestive and never as a clearance. Coverage is the hard
 * limit, AND THE LIMIT IS OURS rather than the chain's. Measured 2026-07-29: 373 of 785 watched tokens had
 * no funder on file — but 360 of those 373 were NEVER TRACED, because tracing is capped per run; only 2 were
 * traced and genuinely had none, and 11 failed at the explorer. "No traceable funder" is therefore, on our
 * own record, overwhelmingly "not asked". This module answers nothing about those launches and says
 * so rather than defaulting them to safe.
 *
 * ═══ AND IT IS EVADABLE, WHICH HAS TO BE SAID FIRST ═══
 * Rotating to a fresh funding wallet defeats this entirely, and costs one extra hop. The data already shows
 * the escape route in use: `funder_unseen` — a payer with no history — is 30% of resolved cases and rugs at
 * roughly the population rate. So this is not a moat. What it does is make REUSE expensive, and reuse is
 * what an operation running dozens of launches an hour actually does, because rotating properly means a new
 * funding path every time. Expect the strong bucket to decay as operators adapt; that decay is a real
 * outcome to measure, not a failure of the method. A signal published as a rule teaches the adversary what
 * to avoid — the honest response is to say so up front rather than to be surprised later.
 *
 * ═══ STRUCTURE, NOT INTENT ═══
 * A shared funder proves shared control or shared infrastructure. A launchpad and a rug factory look
 * identical from the graph, which is why the verdict names what was observed — this payer's previous tokens
 * died — and never who anyone is.
 *
 * Pure, offline, deterministic: it reads a token database and returns a registry. No network, no clock.
 */

/** Verdicts, ordered from most to least actionable. `unknown` is the honest default and is never "safe". */
const VERDICTS = ['funder_has_killed', 'funder_clean_so_far', 'funder_unseen', 'funder_untraceable'];

const lower = (s) => String(s == null ? '' : s).toLowerCase();

/**
 * build — fold a token database into per-funder history.
 *
 * @param tokens  array or address-keyed object of records: { funder, outcome, firstSeen, sym, ... }
 * @returns Map funder -> { funded, rugged, survived, symbols:Set, firstSeen, lastSeen }
 */
function build(tokens) {
  const rows = (Array.isArray(tokens) ? tokens : Object.values(tokens || {}))
    .filter((t) => t && t.firstSeen)
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));

  const reg = new Map();
  for (const t of rows) {
    const f = t.funder ? lower(t.funder) : null;
    if (!f) continue;
    if (!reg.has(f)) reg.set(f, { funder: f, funded: 0, rugged: 0, survived: 0, symbols: new Set(), firstSeen: t.firstSeen, lastSeen: t.firstSeen });
    const g = reg.get(f);
    g.funded++;
    if (t.outcome === 'rugged') g.rugged++;
    else if (t.outcome === 'live') g.survived++;
    if (t.sym) g.symbols.add(t.sym);
    g.lastSeen = t.firstSeen;
  }
  return reg;
}

/**
 * assess — what does the registry say about this funder, and how sure may we sound?
 *
 * `asOf` exists for the prequential replay: pass a timestamp and only history STRICTLY BEFORE it is used, so
 * a backtest cannot quietly consult the future. Omit it for live use.
 */
function assess(registry, funder, opts = {}) {
  if (!funder) {
    return {
      /* ⚠️ LA PHRASE PUBLIAIT « 45% of the launches we watch are in this state », c'est-a-dire une
       * propriete des LANCEMENTS. Mesure du 2026-07-29 sur la base reelle (785 tokens):
       *
       *   sans financeur enregistre .... 373  (47,5 %)
       *     dont JAMAIS TRACES ......... 360   <-- 96 % de la population decrite
       *          trace echouee .......... 11
       *          trace OK, aucun trouve ... 2
       *
       * Le chiffre decrivait notre PLAFOND DE TRACAGE, pas la chaine — et token-radar.js le disait deja
       * en commentaire depuis le 26/07 (« which described our own budget rather than the chain ») sans
       * que cette phrase-ci soit revue. Sur les 32 traces reellement tentees depuis que le drapeau
       * `funderTrace` existe, 34 % ont ECHOUE et 6 % seulement n'avaient vraiment aucun financeur.
       * On ne remplace pas un chiffre faux par un autre chiffre: cette fonction est PURE et n'a pas la
       * base sous la main, donc elle dit ce qu'elle sait — que l'absence ici veut presque toujours dire
       * « pas demande ». Voir [never-accuse-on-own-incompleteness]: pas d'affirmation sur le monde tiree
       * de notre propre couverture. */
      verdict: 'funder_untraceable',
      reason: 'the wallet that paid for this launch was not traced, so this check has nothing to say. '
        + 'That is NOT a clearance — and it is not a finding either: tracing is capped per run, so on our '
        + 'own record "no funder" overwhelmingly means "never asked" rather than "none exists". Treat this '
        + 'as a gap in coverage, not as a property of the launch.',
      priorRugs: null, priorFunded: null,
    };
  }
  const g = registry.get(lower(funder));
  if (!g || g.funded === 0) {
    return {
      verdict: 'funder_unseen',
      reason: 'we have never seen this payer before. No history means no judgement — a first launch from a '
        + 'fresh wallet is exactly what a new operation looks like, and also exactly what a first honest '
        + 'project looks like.',
      priorRugs: 0, priorFunded: 0,
    };
  }
  if (g.rugged > 0) {
    return {
      verdict: 'funder_has_killed',
      reason: 'the wallet that paid for this launch has funded ' + g.funded + ' token(s) we watched, and '
        + g.rugged + ' of them collapsed. Walked forward in time — using only what was known before each '
        + 'token appeared — a payer with a prior kill was followed by another death in 62 of 67 resolved '
        + 'cases (93%), across six independent payers, against a 52% base rate. Structure, not intent: this '
        + 'says these launches share a funder, never who anyone is.',
      priorRugs: g.rugged, priorFunded: g.funded, symbols: [...g.symbols].slice(0, 12),
    };
  }
  return {
    verdict: 'funder_clean_so_far',
    reason: 'this payer has funded ' + g.funded + ' token(s) we watched and none has collapsed yet. Read it '
      + 'as an absence of a bad record, not as a good one: in the walk-forward test only TWO payers in this '
      + 'state had any resolved token at all, which is far too few to call anything safe. A fresh funding '
      + 'wallet also lands here, and that is the cheapest way to defeat this check.',
    priorRugs: 0, priorFunded: g.funded, symbols: [...g.symbols].slice(0, 12),
  };
}

/**
 * replay — the prequential evaluation itself, kept in the module it justifies.
 *
 * Walks the database in order, asks `assess` using only prior history, then records what happened. Anything
 * still unresolved is reported as OPEN rather than folded into either side — the same rule the scorecard
 * uses, for the same reason: a token that has not had time to answer is not evidence.
 *
 * @param resolve (token) => 'rugged' | 'survived' | 'open'
 */
function replay(tokens, resolve) {
  const rows = (Array.isArray(tokens) ? tokens : Object.values(tokens || {}))
    .filter((t) => t && t.firstSeen)
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));

  const reg = new Map();
  const tally = {};
  for (const v of VERDICTS) tally[v] = { rugged: 0, survived: 0, open: 0, funders: new Set() };

  for (const t of rows) {
    const a = assess(reg, t.funder);                       // judged on the PAST only
    const outcome = resolve(t);
    const bucket = tally[a.verdict];
    if (outcome === 'rugged') bucket.rugged++;
    else if (outcome === 'survived') bucket.survived++;
    else bucket.open++;
    if (t.funder) bucket.funders.add(lower(t.funder));

    // history updated AFTER the judgement, never before — this ordering IS the protocol
    const f = t.funder ? lower(t.funder) : null;
    if (f) {
      if (!reg.has(f)) reg.set(f, { funder: f, funded: 0, rugged: 0, survived: 0, symbols: new Set(), firstSeen: t.firstSeen, lastSeen: t.firstSeen });
      const g = reg.get(f);
      g.funded++;
      if (t.outcome === 'rugged') g.rugged++;
      if (t.sym) g.symbols.add(t.sym);
      g.lastSeen = t.firstSeen;
    }
  }

  const out = {};
  let totRug = 0, totRes = 0;
  for (const [v, b] of Object.entries(tally)) {
    const resolved = b.rugged + b.survived;
    totRug += b.rugged; totRes += resolved;
    out[v] = { rugged: b.rugged, survived: b.survived, open: b.open, resolved,
      rate: resolved ? +(b.rugged / resolved).toFixed(2) : null, distinctFunders: b.funders.size };
  }
  out.baseRate = totRes ? +(totRug / totRes).toFixed(2) : null;
  out.resolvedTotal = totRes;
  return out;
}

module.exports = { build, assess, replay, VERDICTS };
