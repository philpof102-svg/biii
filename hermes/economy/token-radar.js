'use strict';
/**
 * token-radar.js — the market-watch daemon that BUILDS ITS OWN EVIDENCE BASE.
 * ===========================================================================
 * Every "token scanner" tells you what it thinks today and never tells you whether it was right. That is why
 * they are ignored: an opinion with no track record is indistinguishable from noise. This one keeps its own
 * git-tracked database and grades itself against what actually happened.
 *
 * Each run does three things:
 *   1. HARVEST  — pull the freshest launches (GeckoTerminal new pools, seconds old) + what is being paid to
 *                 promote (DexScreener boosts). New launches are where rugs live; boosts are where the paid
 *                 traps live. Both are free and keyless.
 *   2. JUDGE    — score each contract with `rugsignals` (can anyone still fire a rug power?) and, for known
 *                 symbols, `meme` (is this even the real contract?). Fail-closed throughout.
 *   3. LEARN    — re-check every token seen in previous runs. If liquidity collapsed against its own peak, we
 *                 record the OUTCOME and grade the call we made at first sight. That produces a falsifiable
 *                 scorecard: how many rugs we caught before they happened, and how many we missed.
 *
 * The scorecard is the whole point. It is the one asset a competitor cannot copy by reading our code — it only
 * accrues by having watched the market for a long time and having written down the misses too. We publish the
 * false negatives on purpose; a scanner that only reports its wins is marketing, not evidence.
 *
 * $0 to run: deterministic, no LLM. Wired as a Hermes `no_agent` cron.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { scanRug } = require('../../lib/rugsignals');
const { traceFeeder, SIBLING_ALERT } = require('../../lib/feeder');
const { vetMeme } = require('../../lib/meme');
const { classifyB20 } = require('../../lib/b20');

const DB_DIR = path.join(__dirname, '..', '..', 'data', 'token-radar');
const TOKENS = path.join(DB_DIR, 'tokens.json');          // per-token state (the memory)
const OBS = path.join(DB_DIR, 'observations.jsonl');      // append-only audit trail
const CARD = path.join(DB_DIR, 'scorecard.json');         // the falsifiable track record

const CHAIN = process.env.RADAR_CHAIN || 'base';
const MIN_LIQ_WATCH = 5000;      // below this a "pool" is dust, not a market worth tracking
const RUG_DROP = 0.80;           // >=80% off its own peak liquidity = the pool was pulled
const RUG_FLOOR = 2000;          // ...and what is left is not a market anymore
const MAX_NEW = 40;              // 2 GoPlus batches of 20. Raised from 20 after measuring the actual supply:
                                 // two pages of new_pools offered 40 unseen addresses against a cap of 20, so
                                 // half of what the source gave us was being dropped every run. scanRug already
                                 // chunks by 20, so this is two requests, not one oversized one.
const TRACE_MAX = 6;             // funding traces per run — 3 explorer calls each, on a free endpoint
const IMPOSTOR_MAX = 10;         // symbol checks per run — one search each
const INDUSTRIAL_FUNDER = 20;    // wallets bankrolled by one funder before it reads as an operation, not a person
                                 // (chosen by sweeping the threshold against known outcomes, not by intuition)

/**
 * Every call that did NOT answer this run. Read by the digest, because a run that could not look must not be
 * allowed to read like a run that looked and found nothing.
 */
const UNANSWERED = [];

/**
 * getJSON — null means "this call did not answer", and nothing else.
 *
 * The previous version never looked at `res.statusCode`. A 429 body is `{"errors":[…]}` — perfectly valid JSON —
 * so it parsed cleanly and came back as an object, and every harvester then did `((j && j.data) || [])` and got
 * an empty array. A throttled run therefore harvested zero tokens and the digest announced "0 fresh launches
 * judged, none with a fireable rug power": a green line manufactured by a failure, on the one asset here that
 * cannot be rebuilt by reading the code.
 *
 * Measured rather than suspected: four rapid calls to the pools endpoint return HTTP 200 with 20 entries, and
 * the fifth and sixth return HTTP 429 with a retry-after header. The API is honest. We were not listening.
 *
 * This is the same fault as counting an unread `allowance()` as a revoked approval, and as a scanner reporting
 * `holder_count: 0` when the index means "not computed". Third time today: an error rendered as a zero.
 */
function getJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => {
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          UNANSWERED.push({ url: url.split('?')[0], status: code, retryAfter: res.headers['retry-after'] || null });
          return resolve(null);
        }
        try { resolve(JSON.parse(d)); }
        catch { UNANSWERED.push({ url: url.split('?')[0], status: 'unparseable body' }); resolve(null); }
      });
    }).on('error', (e) => { UNANSWERED.push({ url: url.split('?')[0], status: e.message }); resolve(null); });
  });
}

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const pct = (n) => Math.round(n * 100) + '%';
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** Freshest launches on the chain — pools created minutes ago, before anyone has looked at them. */
async function harvestNewPools() {
  // Two pages, because the source offers more than one run consumes: measured 40 unseen addresses available
  // against a MAX_NEW of 20. Page 2 is attempted and its failure is recorded rather than smoothed over, so a
  // half-harvest never reads as a full one.
  const pages = [];
  for (const page of [1, 2]) {
    const j = await getJSON('https://api.geckoterminal.com/api/v2/networks/' + CHAIN + '/new_pools?page=' + page);
    if (j === null) break;                 // already recorded in UNANSWERED; stop rather than hammer a 429
    if (!Array.isArray(j.data)) { UNANSWERED.push({ url: 'new_pools page ' + page, status: 'no data array' }); break; }
    pages.push(...j.data);
    if (j.data.length === 0) break;        // genuinely the end of the list
  }
  const out = [];
  for (const p of pages) {
    const a = p.attributes || {}, rel = p.relationships || {};
    const liq = parseFloat(a.reserve_in_usd) || 0;
    const id = ((rel.base_token || {}).data || {}).id || '';       // e.g. "base_0xabc..."
    const addr = id.split('_')[1];
    if (!addr || liq < MIN_LIQ_WATCH) continue;
    // Liquidity in USD is only meaningful when the other side of the pool has a real market. OSDC entered
    // this database claiming $496,940,262 -- it was paired with ZORA and traded $55.40 in 24 hours, a
    // turnover of 0.00001%. The aggregator was not lying: it priced one thin token in another. A pool that
    // large with a real market moves millions, so the ratio is the check, and it costs nothing.
    const vol24 = parseFloat((a.volume_usd && a.volume_usd.h24) || 0) || 0;
    if (liq > 100000 && vol24 / liq < 0.001) {
      lines.push('💭 ' + (String(a.name || '?').split('/')[0].trim()) + ' claims ' + usd(liq) +
        ' of liquidity on ' + usd(vol24) + ' of 24h volume — nominal, not dollars. Skipped.');
      continue;
    }
    // A pool whose base token the aggregator labels "[invalid]" is not a parsing failure on our side — it
    // means the symbol could not be decoded at all, which happens when a name is deliberately built from
    // control characters or invisible glyphs to slip past text filters. Carrying that through as if it were
    // a ticker pollutes the database; naming it as the anomaly it is keeps the row useful.
    const raw = String(a.name || '').split('/')[0].trim();
    const undecodable = !raw || /^\[invalid\]$/i.test(raw);
    out.push({ addr: addr.toLowerCase(), sym: undecodable ? '⟨undecodable-symbol⟩' : raw, undecodable,
      liq, source: 'new_pool', createdAt: a.pool_created_at || null });
  }
  return out;
}

/** What someone is PAYING to promote right now — the paid-impersonation surface. */
async function harvestBoosts() {
  const j = await getJSON('https://api.dexscreener.com/token-boosts/latest/v1');
  const picks = (Array.isArray(j) ? j : []).filter((b) => b.chainId === CHAIN).slice(0, 10);
  const out = [];
  for (const b of picks) {
    const t = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + b.tokenAddress);
    const pair = t && t.pairs && t.pairs[0];
    if (!pair) continue;
    out.push({ addr: String(b.tokenAddress).toLowerCase(), sym: String((pair.baseToken || {}).symbol || '?').toUpperCase(),
      liq: (pair.liquidity && pair.liquidity.usd) || 0, source: 'boosted', createdAt: null });
  }
  return out;
}

/** Current liquidity for tokens we already track — batched 30 per request. */
async function currentLiquidity(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const j = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + addrs.slice(i, i + 30).join(','));
    for (const p of ((j && j.pairs) || [])) {
      const a = String(((p.baseToken || {}).address) || '').toLowerCase();
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      if (a && (out[a] == null || liq > out[a])) out[a] = liq;     // best pool represents the token
    }
  }
  return out;
}

(async () => {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = readJSON(TOKENS, {});
  const now = new Date().toISOString();
  const lines = [];
  let obsOut = '';

  // ---------- 3. LEARN FIRST: grade what we said about tokens we already track -------------------
  const tracked = Object.keys(db).filter((k) => db[k].outcome === 'live');
  const liqNow = tracked.length ? await currentLiquidity(tracked) : {};
  const newlyRugged = [];
  for (const addr of tracked) {
    const t = db[addr];
    const liq = liqNow[addr];
    if (liq == null) continue;                       // no pool returned = delisted/illiquid; needs 2 runs to confirm
    t.lastLiq = liq; t.lastSeen = now;
    if (liq > (t.peakLiq || 0)) t.peakLiq = liq;
    const drop = t.peakLiq > 0 ? 1 - liq / t.peakLiq : 0;
    if (drop >= RUG_DROP && liq < RUG_FLOOR) {
      t.outcome = 'rugged'; t.ruggedAt = now; t.dropPct = drop;
      newlyRugged.push({ addr, ...t });
    }
  }

  // ---------- 1b. RE-JUDGE THE ABSTENTIONS ------------------------------------------------------
  // An `unknown` was never a conclusion, it was a question asked too early. The curated index does not
  // refuse these tokens, it simply has not reached them yet: $MB was judged 25 minutes after its pool
  // opened, returned nothing, and was filed unknown forever — while two hours later the index held its
  // owner address, and by then nobody was asking. It rugged with $479k in it. So abstentions get asked
  // again while the token is still alive, and the first verdict is kept alongside so the scorecard still
  // grades what we said WHEN IT MATTERED, not what we learned afterwards.
  const stale = Object.keys(db).filter((k) => db[k].outcome === 'live' && db[k].firstVerdict === 'unknown'
    && !db[k].rejudgedAt).slice(0, 8);
  const rejudged = [];
  if (stale.length) {
    const again = await scanRug(CHAIN, stale);
    for (const addr of stale) {
      const v = again[addr];
      if (!v || v.verdict === 'unknown') continue;
      const t = db[addr];
      t.rejudgedAt = now; t.rejudgedVerdict = v.verdict; t.rejudgedReason = v.reason;
      rejudged.push({ addr, sym: t.sym, from: t.firstVerdict, to: v.verdict, reason: v.reason });
    }
  }

  // ---------- 1. HARVEST ------------------------------------------------------------------------
  const [fresh, boosted] = await Promise.all([harvestNewPools(), harvestBoosts()]);
  const seen = new Set();
  const candidates = [];
  for (const c of [...fresh, ...boosted]) {
    if (seen.has(c.addr)) continue;
    seen.add(c.addr);
    candidates.push(c);
  }
  const toJudge = candidates.filter((c) => !db[c.addr]).slice(0, MAX_NEW);

  // ---------- 2. JUDGE --------------------------------------------------------------------------
  const verdicts = toJudge.length ? await scanRug(CHAIN, toJudge.map((c) => c.addr)) : {};
  const armed = [], survivors = [], watch = [], relaunches = [];

  // B20 tokens are a STRUCTURAL blind spot for an ERC-20 scanner, and the numbers say so rather than a hunch:
  // in this database 88% of 0xb200-prefixed tokens came back `unknown` against 18% for everything else. That is
  // mechanical, not bad luck. A native B20 carries ONE byte of EVM code because its logic is a precompile, so
  // the curated security index has literally nothing to analyse and must abstain.
  //
  // The perverse part is that we abstain on the class whose danger we know EXACTLY. A native B20's issuer can
  // freeze and burn any holder's balance at the standard level. That is not missing information — it is a
  // certainty, disclosed by the standard, and reporting "not enough security data" about it is the worst answer
  // available: it reads quieter than the truth. And Base is migrating to B20, so this share only grows.
  //
  // So the prefix is checked directly. It is a cheap prefilter (one eth_getCode per matching address, and only
  // addresses starting 0xb200 match at all), and it splits into two very different findings:
  //   native_b20      -> a FLAG stating the issuer power. Never silently escalated to rug_ready: the power is
  //                      inherent to the standard and disclosed, so calling it a rug would flag every compliant
  //                      asset on the chain and get this muted.
  //   prefix_impostor -> ARMED. An ordinary ERC-20 that bought a vanity address to wear the compliant standard's
  //                      prefix is impersonating it, and impersonation is the fireable trap here.
  const b20Notes = [];
  for (const c of toJudge) {
    if (!/^0xb200/i.test(c.addr)) continue;
    let b; try { b = await classifyB20(CHAIN, c.addr); } catch { continue; }
    const v = verdicts[c.addr];
    if (b.verdict === 'prefix_impostor') {
      b20Notes.push({ c, kind: 'impostor', b });
      if (v) { v.verdict = 'rug_ready'; (v.armed = v.armed || []).unshift('wears the B20 address prefix (0xb200…) while carrying ' + b.codeBytes + ' bytes of ordinary ERC-20 code — it is not a B20, it bought an address that looks like one'); }
    } else if (b.verdict === 'native_b20') {
      b20Notes.push({ c, kind: 'native', b });
      if (v) {
        (v.flags = v.flags || []).push('native B20: its ISSUER can freeze and burn any holder\'s balance at the standard level — a power no ERC-20 scanner can see');
        // An abstention is no longer honest once we know this much about the token.
        if (v.verdict === 'unknown') { v.verdict = 'caution'; v.reason = 'no ERC-20 security record exists because this is a native B20 (' + b.codeBytes + ' byte of code, logic in a precompile) — but its issuer holds standard-level freeze-and-burn over holders, which is a certainty rather than a gap'; }
      }
    }
  }

  // A symbol already in this database, whose earlier instance died, is the strongest signal found so far:
  // 9 of 12 such tokens rugged against a 52% rate for first appearances. Deliberately NOT wired into the
  // verdict. Three rules were added on similar reasoning last night and all three were killed by replay, so
  // this one gets REPORTED and measured first. The number is also honest about its own weakness — the 84%
  // that first appeared in the data counted first appearances too, which are invisible at judgment time.
  const priorBySym = {};
  for (const t of Object.values(db)) {
    if (!t.sym) continue;
    (priorBySym[t.sym] = priorBySym[t.sym] || []).push(t);
  }
  for (const c of toJudge) {
    const v = verdicts[c.addr] || { verdict: 'unknown', reason: 'no verdict', armed: [], flags: [] };
    db[c.addr] = { sym: c.sym, chain: CHAIN, source: c.source, firstSeen: now, lastSeen: now,
      firstVerdict: v.verdict, firstReason: v.reason, armedAtFirstSight: v.armed, flagsAtFirstSight: v.flags,
      firstLiq: c.liq, peakLiq: c.liq, lastLiq: c.liq, outcome: 'live' };
    obsOut += JSON.stringify({ ts: now, addr: c.addr, sym: c.sym, chain: CHAIN, source: c.source, liq: c.liq, verdict: v.verdict, armed: v.armed, flags: v.flags }) + '\n';
    if (v.verdict === 'rug_ready') armed.push({ ...c, v });
    else if (v.verdict === 'clean') survivors.push({ ...c, v });
    else watch.push({ ...c, v });
    if (c.undecodable) lines.push('⚠️ ' + c.addr.slice(0, 10) + '… (' + usd(c.liq) + ') has NO decodable symbol — a name built to defeat text filters, which is a choice, not an accident.');
    const prior = (priorBySym[c.sym] || []).filter((p) => p.firstSeen && p.firstSeen < now);
    const priorRugged = prior.filter((p) => p.outcome === 'rugged');
    if (priorRugged.length) {
      relaunches.push({ ...c, priorCount: prior.length, ruggedCount: priorRugged.length });
      db[c.addr].relaunchOfRugged = priorRugged.length;
    }
  }

  // ---------- IS THIS TOKEN EVEN CLAIMING TO BE ITSELF? -----------------------------------------
  // Asked because of CORE, which appeared twice in this database seven minutes apart with near-identical
  // liquidity — $56,804 and $56,940 — and one of the two went to $1. The contract analysis found nothing
  // worse than a caution on the one that died, correctly: there was nothing malicious IN the contract. The
  // deception was positional, a clone borrowing a name that already had a dominant holder elsewhere. That
  // question was already answered by another module in this repository and the radar had simply never
  // asked it. Cheap, and only for tokens whose symbol can be decoded at all.
  const impostors = [];
  for (const c of toJudge.filter((x) => !x.undecodable && x.sym && x.sym.length <= 12).slice(0, IMPOSTOR_MAX)) {
    let m; try { m = await vetMeme({ symbol: c.sym, chainId: CHAIN, address: c.addr }); } catch { continue; }
    if (!m) continue;
    db[c.addr].symbolVerdict = m.status;
    if (m.status === 'impersonation') {
      impostors.push({ ...c, canonical: m.canonical });
      db[c.addr].firstVerdict = 'rug_ready';   // wearing another token's name IS the fireable trap here
      db[c.addr].firstReason = 'the symbol "' + c.sym + '" already has a dominant contract elsewhere — this one is not it';
    }
  }

  // ---------- FOLLOW THE MONEY: who paid for these launches, and what else did they pay for? -----
  // Capped deliberately. Three explorer calls per token on a free public endpoint adds up, and an unbounded
  // crawl is how we lose access to it — so we trace the biggest fresh launches and say what we skipped.
  const toTrace = toJudge.slice().sort((a, b) => b.liq - a.liq).slice(0, TRACE_MAX);
  const clusters = [];
  for (const c of toTrace) {
    let f; try { f = await traceFeeder(CHAIN, c.addr); } catch { continue; }
    if (!f || !f.ok || !f.funder) continue;
    db[c.addr].deployer = f.deployer; db[c.addr].funder = f.funder;
    db[c.addr].siblingCount = f.siblingCount; db[c.addr].freshDeployer = f.freshDeployer;
    if (f.identicalAmountSiblings >= SIBLING_ALERT || f.siblingCount >= SIBLING_ALERT) clusters.push({ ...c, f });

    // The one rule this session that survived its own backtest. Measured over 62 tokens with funding data:
    // a funder that has paid 20 or more wallets precedes a rug 83% of the time against a 56% base rate, and
    // raising the bar from 5 to 20 caught the SAME 40 rugs while sparing 3 survivors — strictly better, not a
    // trade-off. It also separates cleanly from a legitimate batch launcher: eight tokens in this database
    // share one deployer with 3 siblings each and not one of them died.
    // Deliberately high_risk and not rug_ready. rug_ready means a power someone can fire; this means the
    // token shares fate with an industrial operation, which is serious without being proof.
    if ((f.siblingCount || 0) >= INDUSTRIAL_FUNDER && db[c.addr].firstVerdict !== 'rug_ready') {
      db[c.addr].firstVerdict = 'high_risk';
      db[c.addr].firstReason = 'its funder has bankrolled ' + f.siblingCount +
        ' wallets — industrial scale, and 83% of tokens behind such a funder have rugged in what we have watched';
      db[c.addr].industrialFunder = f.siblingCount;
    }
  }
  if (toJudge.length > toTrace.length) lines.push('   (funding traced for the ' + toTrace.length + ' largest of ' + toJudge.length + ' — the rest were skipped, not cleared)');

  // ---------- SCORECARD: what our calls were actually worth --------------------------------------
  // Grading ourselves in three buckets, not two. The first version counted only rug_ready/high_risk as a
  // catch and only `clean` as a miss, which put every `caution` in a gap: the first four real rugs had all
  // been called caution, and the scorecard reported a 0% catch rate while the runs had in fact warned on all
  // four. Under-crediting is the safer direction to be wrong in, but a metric nobody can interpret is worse
  // than no metric — so a warning now counts as a warning, at the strength it was actually given.
  const all = Object.values(db);
  const rugged = all.filter((t) => t.outcome === 'rugged');
  /* ONE definition of "a strong call", used on BOTH sides of the ledger.
   *
   * It was written twice with two different meanings, and the difference flattered us exactly where this file's
   * own note says it must not: `strong` counted rug_ready OR high_risk as a WIN when the token rugged, while
   * `falseAlarms` counted only rug_ready as an ERROR when it survived. So a high_risk verdict scored when it was
   * right and cost nothing when it was wrong — a scanner grading its own homework, in the module whose note
   * reads "a scanner that only reports its wins is marketing, not evidence".
   *
   * Measured at the moment of the fix: 3 false alarms under the narrow rule, 5 under the same rule used for the
   * wins. The two extra are AAPL and openhuman, both called high_risk and both still alive.
   *
   * A shared predicate rather than two matching filters, because two filters that agree today drift apart the
   * next time someone edits one of them — which is precisely how this happened. */
  const isStrongCall = (t) => t.firstVerdict === 'rug_ready' || t.firstVerdict === 'high_risk';

  const strong = rugged.filter(isStrongCall);
  const soft = rugged.filter((t) => t.firstVerdict === 'caution');
  const silent = rugged.filter((t) => t.firstVerdict === 'unknown');
  const missed = rugged.filter((t) => t.firstVerdict === 'clean');
  const stillLive = all.filter((t) => t.outcome === 'live');
  const falseAlarms = stillLive.filter(isStrongCall);
  const warned = strong.length + soft.length;
  const card = {
    updatedAt: now, tokensTracked: all.length, rugsObserved: rugged.length,
    warnedBeforeTheRug: warned,
    ofWhichStrong: strong.length, ofWhichCautionOnly: soft.length,
    abstained: silent.length, missedOutright: missed.length,
    warnRate: rugged.length ? +(warned / rugged.length).toFixed(2) : null,
    strongRate: rugged.length ? +(strong.length / rugged.length).toFixed(2) : null,
    flaggedButStillAlive: falseAlarms.length,
    /* PRECISION of a strong call — the number a buyer actually needs, and one that could not be computed at all
     * until the two sides of the ledger shared a definition. warnRate is trivially high (0.97) because a caution
     * counts; strongRate is recall (how many rugs we called loudly). Neither answers "when this thing shouts,
     * how often is it right?" — and that is the only question that decides whether to act on a warning.
     *
     * The asymmetry was not merely flattering the score, it was hiding the DENOMINATOR: false alarms counted
     * rug_ready only, so the set of strong calls could never be assembled. Raw counts travel with the ratio
     * because 23 calls is a small sample and a bare 0.78 invites more confidence than it has earned. */
    strongCallsTotal: strong.length + falseAlarms.length,
    strongCallsRight: strong.length,
    strongPrecision: (strong.length + falseAlarms.length)
      ? +(strong.length / (strong.length + falseAlarms.length)).toFixed(2) : null,
    /* THE DENOMINATOR BEHIND `missedOutright`, published because without it that zero is worthless.
     *
     * `missedOutright` counts rugs we had called `clean` — presented as the one truly damaging error, and it has
     * been 0 from the start. Checked rather than celebrated: `clean` has been emitted ZERO times in 161 tokens.
     * You cannot miss with a verdict you never give, so the zero is trivial, not earned, and reporting it as an
     * achievement would be exactly the "marketing, not evidence" this file claims to avoid.
     *
     * Second time in one sitting that a flattering figure here turned out to have a hidden denominator — the
     * other was false alarms counting fewer verdicts than wins did. The pattern is worth more than either fix:
     * on this scorecard, check what the denominator is before believing a numerator. */
    cleanVerdictsEmitted: all.filter((t) => t.firstVerdict === 'clean').length,
    note: 'warnRate = share of observed rugs carrying ANY warning at first sight; strongRate = share we called rug_ready or high_risk. Both are published because they say different things: a caution that rugs means the warning was there but too quiet to act on. abstained = rugs we had called unknown, which is honest but useless to a buyer. missedOutright = rugs we had called clean, the only truly damaging error — but read cleanVerdictsEmitted first: at 0 clean verdicts ever given, a 0 here is trivial rather than earned. flaggedButStillAlive is our false-alarm count, published on purpose: a scanner that only reports its wins is marketing, not evidence — and it counts the SAME verdicts that count as wins (rug_ready and high_risk), which it did not until 2026-07-26: high_risk scored when it was right and cost nothing when it was wrong. strongPrecision is the number a buyer acts on: when this shouts, how often is it right. Raw counts travel with it because the sample is small.',
  };

  writeJSON(TOKENS, db);
  writeJSON(CARD, card);
  if (obsOut) fs.appendFileSync(OBS, obsOut);

  // ---------- REPORT ----------------------------------------------------------------------------
  // A run that could not look must never read like a run that looked and found nothing. Before this, a
  // rate-limited harvest produced "✓ 0 fresh launches judged, none with a fireable rug power" — the reassuring
  // sentence, generated by a failure. The tick mark is now withheld the moment anything went unanswered.
  const head = armed.length
    ? '🚩 token-radar: ' + armed.length + ' ARMED rug(s) among ' + toJudge.length + ' fresh ' + CHAIN + ' launches — the deployer can still pull the trigger.'
    : UNANSWERED.length
      ? '⚠️ token-radar: ' + toJudge.length + ' ' + CHAIN + ' launches judged, and ' + UNANSWERED.length +
        ' call(s) did NOT answer — this is not a clean sweep, it is a partial one.'
      : '✓ token-radar: ' + toJudge.length + ' fresh ' + CHAIN + ' launches judged, none with a fireable rug power.';
  console.log(head);

  if (UNANSWERED.length) {
    const parSource = {};
    for (const u of UNANSWERED) {
      const k = u.url.replace(/^https?:\/\//, '').split('/').slice(0, 2).join('/') + '  HTTP ' + u.status;
      parSource[k] = (parSource[k] || 0) + 1;
    }
    lines.push('⚠️ ' + UNANSWERED.length + ' call(s) went unanswered this run, so coverage is incomplete:');
    for (const [k, n] of Object.entries(parSource)) lines.push('   · ' + n + '× ' + k);
    lines.push('   A 429 here means the harvest was throttled, NOT that the market was quiet. Judge the counts below accordingly.');
  }

  // Reported before the generic verdict list, because a B20 finding is the only thing here an ERC-20 scanner
  // structurally cannot produce — and it is the half of the market this whole tool was blind to.
  if (b20Notes.length) {
    const nat = b20Notes.filter((n) => n.kind === 'native');
    const imp = b20Notes.filter((n) => n.kind === 'impostor');
    for (const n of imp) lines.push('🎭 ' + n.c.sym + ' ' + n.c.addr.slice(0, 12) + '… wears the B20 prefix with ' +
      n.b.codeBytes + ' bytes of ordinary ERC-20 code — it is NOT a B20, it bought an address that looks like one.');
    if (nat.length) lines.push('🏛️ ' + nat.length + ' native B20(s): ' + nat.map((n) => n.c.sym).join(' · ') +
      ' — no ERC-20 security record exists for these by construction (logic is a precompile), and their ISSUER ' +
      'holds standard-level freeze-and-burn over any holder. That is a certainty, not a data gap.');
  }

  for (const a of armed) lines.push('🚩 ' + a.sym + ' ' + a.addr.slice(0, 10) + '… (' + a.source + ', ' + usd(a.liq) + ') — ' + a.v.armed[0]);
  if (survivors.length) {
    lines.push('✅ passes every gate (' + survivors.length + '): ' + survivors.map((s) => s.sym + ' ' + usd(s.liq)).join(' · '));
    for (const s of survivors) lines.push('   · ' + s.sym + ' ' + s.addr.slice(0, 10) + '… — ' + s.v.reason);
  }
  // The middle bucket is where almost every fresh launch sits, and reporting only the extremes would hide
  // the actual state of the market. Each line carries WHY, so the reader can disagree with us.
  for (const w of watch) {
    lines.push((w.v.verdict === 'high_risk' ? '⚠️ ' : '·  ') + w.sym + ' ' + w.addr.slice(0, 10) + '… (' + w.source + ', ' + usd(w.liq) +
      ') [' + w.v.verdict + '] — ' + w.v.reason + (w.v.flags.length > 1 ? ' (+' + (w.v.flags.length - 1) + ' more flag(s))' : ''));
  }
  // THE CLEAN BAND — the strongest thing measured so far, and reported rather than encoded.
  //
  // Two conditions, each with an economic mechanism rather than just a correlation, explain almost every rug
  // in 99 settled outcomes. Seeding under $15k makes a rug cheap: the operator recovers the stake for no
  // effort. A funder that has bankrolled 20+ wallets is an industry, amortised over volume. They are
  // independent — one is about cost, the other about structure — which is why they compose.
  //
  //   under $15k OR industrial funder : 55/65 = 85% rugged  (+27pts on a 58% base)
  //   neither                         :  2/34 =  6%         (-52pts), and 0/15 where sibling data was confirmed
  //
  // It also dissolved a false regime. Launches above $40k looked dangerous at 70%, until 13 of those 14 rugs
  // turned out to share one funder with 26-27 siblings. Excluding factories, big launches rug at 17% — SAFER
  // than average. "Big is dangerous" was one operator wearing a market-wide costume.
  //
  // Not wired into the verdict: this is measured on the very data that produced it, and three confidently
  // reasoned rules died to that exact mistake this session. It gets labelled and the scorecard will grade it
  // forward. If it holds on tokens judged AFTER today, it is the first defensible green signal here.
  for (const c of toJudge) {
    const sib = db[c.addr].siblingCount;
    const clean = c.liq >= 15000 && (sib === undefined || sib < INDUSTRIAL_FUNDER);
    db[c.addr].cleanBand = clean;
    if (clean) lines.push('🟢 ' + c.sym + ' ' + c.addr.slice(0, 10) + '… (' + usd(c.liq) +
      ') sits in the band where almost nothing has rugged: seeded above $15k and no industrial funder found. ' +
      '(6% observed, 2/34 — IN-SAMPLE, being graded forward. Not a verdict.)');
  }

  for (const r of relaunches) {
    lines.push('♻️ ' + r.sym + ' ' + r.addr.slice(0, 10) + '… (' + usd(r.liq) + ') — this database already holds ' +
      r.ruggedCount + ' contract(s) under the name "' + r.sym + '" that rugged. Someone is relaunching a name that already died. ' +
      '(Observed rate for this pattern: 9/12. NOT wired into the verdict — being measured first.)');
  }
  for (const im of impostors) {
    lines.push('🎭 ' + im.sym + ' ' + im.addr.slice(0, 10) + '… (' + usd(im.liq) + ') — NOT the dominant contract for its own symbol.' +
      (im.canonical ? ' The one holding the name is ' + im.canonical.address.slice(0, 12) + '… with ' + usd(im.canonical.liquidityUsd) + '.' : '') +
      ' A clone borrowing a name is a trap the contract itself will never reveal.');
  }
  for (const c of clusters) {
    lines.push('🕸️ ' + c.sym + ' shares a paymaster: deployer ' + c.f.deployer.slice(0, 10) + '… funded by ' +
      c.f.funder.slice(0, 10) + '… (' + c.f.fundedEth + ' ETH' + (c.f.freshDeployer ? ', its ONLY incoming tx' : '') + ')');
    lines.push('     ' + c.f.pattern + (c.f.morePages ? ' — and that is one page of many' : ''));
    lines.push('     structure, not intent: these tokens share fate. Judge them together.');
  }
  for (const r of rejudged) {
    lines.push('🔁 ' + r.sym + ' ' + r.addr.slice(0, 10) + '… — the index caught up: unknown → ' + r.to.toUpperCase() + ' — ' + r.reason);
  }
  if (newlyRugged.length) {
    lines.push('📉 RUGGED since last run (' + newlyRugged.length + ') — grading our own call:');
    for (const r of newlyRugged) {
      // Four grades, because "we said something" and "we said something useful" are not the same claim.
      // An abstention is honest and worthless to a buyer; marking it with a tick would flatter the record.
      const grade = r.firstVerdict === 'clean' ? '❌ WE CALLED IT CLEAN — a real miss'
        : r.firstVerdict === 'unknown' ? '⚪ we abstained (unknown) — honest, but no use to anyone holding it'
        : (r.firstVerdict === 'rug_ready' || r.firstVerdict === 'high_risk') ? '✅ we had called it ' + r.firstVerdict
        : '🟡 we had called it caution — the warning was there, too quiet to act on';
      lines.push('   · ' + r.sym + ' ' + pct(r.dropPct) + ' off peak (' + usd(r.peakLiq) + ' → ' + usd(r.lastLiq) + ') — ' + grade);
    }
  }
  lines.push('📊 scorecard: ' + card.tokensTracked + ' tracked · ' + card.rugsObserved + ' rugs observed' +
    (card.rugsObserved
      ? ' · warned on ' + card.warnedBeforeTheRug + '/' + card.rugsObserved + ' (' + pct(card.warnRate) + ') — but only ' +
        card.ofWhichStrong + ' strongly (' + pct(card.strongRate) + '); ' + card.abstained + ' abstained, ' +
        card.missedOutright + ' called clean and rugged'
      : ' · no rug observed yet — no rate to claim') +
    ' · ' + card.flaggedButStillAlive + ' flagged still alive');
  for (const l of lines) console.log('  ' + l);
})();
