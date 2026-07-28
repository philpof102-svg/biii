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
const { scoreCalls } = require('../../lib/scorecard');
const GAP = require('../../lib/watch-gap');   // les heures ou personne ne regardait, ecrites au lieu d etre absorbees

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
/* FUNDING TRACES PER RUN — raised from 6 to 20 on 2026-07-26, after measuring both halves of the question.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. Scored against our own outcomes, this is the only signal left with any
 * predictive power: symbol impersonation has none, contract flags are worth +6 points and are redundant with
 * each other, and `armedAtFirstSight` is empty on every token we have ever seen because the security index
 * returns an owner address for about one Base token in ten. Walked forward in time, a payer with a prior
 * kill was followed by another death in 62 of 67 resolved cases. At 6 traces against a MAX_NEW of 40 we were
 * declining to ask the one question that works, on 34 tokens out of 40 — and calling the result "45% not
 * traceable", which described our own budget rather than the chain.
 *
 * WHY 20 AND NOT 40. The explorer was probed rather than assumed: 40 concurrent address reads returned 40×200
 * with a median of ~1s and no 429 at any burst size tried. That is a budget, not a permission — a free
 * endpoint tolerating a burst is no evidence it tolerates sustained hourly load, and losing it would cost the
 * only signal we have. 20 triples coverage and stays well inside what was measured; raise it further only
 * after the runs at 20 come back clean, which is a fact to check rather than a hope.
 *
 * THE SORT STAYS DESCENDING BY LIQUIDITY, and that was checked too because it looked wrong. Rug factories
 * seed around $9-13k, so tracing the LARGEST launches seemed to spend a scarce budget on the safest tokens.
 * The data says otherwise: risk is U-SHAPED, not monotonic — by seed quintile, 81% / 86% / 19% / 3% / 71%.
 * Both ends are dangerous with a quiet band in the middle, because the big-seed danger is the WELL-FUNDED
 * factory (the openhuman cluster seeds at a $61k median). The top 15% by liquidity rug at 81% against 46%
 * for the rest, so the existing sort was already picking the right end. Hypothesis wrong, measurement kept. */
const TRACE_MAX = 20;
const IMPOSTOR_MAX = 10;         // symbol checks per run — one search each
const INDUSTRIAL_FUNDER = 20;    // wallets bankrolled by one funder before it reads as an operation, not a person
                                 // (chosen by sweeping the threshold against known outcomes, not by intuition)

/**
 * Every call that did NOT answer this run. Read by the digest, because a run that could not look must not be
 * allowed to read like a run that looked and found nothing.
 */
const UNANSWERED = [];

/**
 * Notes raised DURING the harvest, drained into the digest at report time.
 *
 * This exists because of a crash, not a preference. The harvest used to push straight onto the digest's
 * `lines`, which is declared inside the run closure and is therefore invisible from a module-level function.
 * The reference sat there harmlessly for weeks: it lives in the branch that skips a pool claiming large
 * liquidity on almost no volume, and no such pool had ever appeared. The first one that did took the whole
 * radar down with a ReferenceError — a guard written to skip something gracefully instead killed the run.
 *
 * Two things worth keeping from that: a latent crash in a rare branch is invisible to every test that only
 * exercises the common path, and the blast radius of a *logging* line was an entire cron.
 */
const HARVEST_NOTES = [];

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
      HARVEST_NOTES.push('💭 ' + (String(a.name || '?').split('/')[0].trim()) + ' claims ' + usd(liq) +
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

/**
 * What someone is PAYING to promote right now — the paid-impersonation surface.
 *
 * This is also the only HUMAN PREDICTION WITH A PRICE that we harvest: a boost is somebody spending real
 * money on the belief that a token deserves attention. That makes an empty result worth distinguishing
 * carefully, and it was not distinguished at all until 2026-07-26.
 *
 * Measured that day, across both boost endpoints, 60 entries: solana 37, robinhood 22, stable 1, BASE 0.
 * The feed is alive and busy — it simply carries nothing for our chain. So the filter below returned an
 * empty list every run, and an empty list read exactly like "nobody is boosting on Base" when it actually
 * meant "this feed does not cover Base." 195 of 195 tracked tokens came from new_pool, and nothing said why.
 *
 * Silence now gets a reason. Three outcomes, three different sentences — because "the call failed",
 * "the feed has no rows for us" and "there genuinely are none" are three different facts and only the last
 * one is a finding.
 */
async function harvestBoosts() {
  const j = await getJSON('https://api.dexscreener.com/token-boosts/latest/v1');
  if (j === null) {
    HARVEST_NOTES.push('📢 boosts: the feed did not answer — the paid-promotion surface was NOT checked this run.');
    return [];
  }
  const all = Array.isArray(j) ? j : [];
  const picks = all.filter((b) => b.chainId === CHAIN).slice(0, 10);
  if (!picks.length) {
    const chains = {};
    for (const b of all) chains[b.chainId] = (chains[b.chainId] || 0) + 1;
    const seen = Object.entries(chains).sort((a, b) => b[1] - a[1]).map(([c, n]) => c + '×' + n).join(', ');
    HARVEST_NOTES.push('📢 boosts: ' + all.length + ' entr' + (all.length === 1 ? 'y' : 'ies') + ' returned, NONE on ' +
      CHAIN + (seen ? ' (' + seen + ')' : '') + '. That is a coverage gap in the feed, not evidence that ' +
      'nobody is paying to promote here — the only human-priced signal we harvest is blind on this chain.');
  }
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

/* Gaps in the watch, recorded as facts rather than absorbed in silence.
 *
 * On 2026-07-27 this radar had not run for 9.3 hours — the machine slept and the Hermes gateway restarted.
 * Nothing anywhere said so. A launch that appeared AND died inside those nine hours was never seen, was never
 * counted as a rug, and never will be: the harvest only shows pools that exist NOW.
 *
 * That makes the whole scorecard a FLOOR during a blackout, and a blackout reads exactly like a quiet market.
 * It is the same trap this file already handles for a throttled API — "we could not look" is not "there was
 * nothing to see" — applied to the asset itself instead of to one call.
 *
 * A gap is only recorded past MAX_QUIET_H, because the schedule is hourly and a late run is not a blackout. */
const BLACKOUTS = path.join(DB_DIR, 'blackouts.json');

/* The decision itself lives in lib/watch-gap.js, pure and tested — because a detector that stays silent
 * one time too many puts the blackout back where it was: invisible. The rows that matter there are the
 * ones where a plausible implementation says nothing (a first run, a clock moved backwards, a merely late
 * run), and they are only checkable offline. This function is just the disk around it. */
function recordBlackout(db, nowIso) {
  const gap = GAP.detectGap(GAP.newestObservation(db), Date.parse(nowIso));
  if (!gap) return null;
  writeJSON(BLACKOUTS, GAP.appendGap(readJSON(BLACKOUTS, []), gap));
  return gap;
}

(async () => {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = readJSON(TOKENS, {});
  const now = new Date().toISOString();
  const blackout = recordBlackout(db, now);
  const lines = [];
  let obsOut = '';

  if (blackout) {
    lines.push('🕳️ WATCH GAP: nothing was observed for ' + blackout.hours + 'h (' +
      blackout.from.slice(11, 16) + 'Z → ' + blackout.to.slice(11, 16) + 'Z). Launches that appeared AND died ' +
      'inside that window were never seen and can never be recovered — the harvest only shows pools that exist ' +
      'now. Every count below is a FLOOR for that period, and a gap reads exactly like a quiet market.');
  }

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
    /* ⚠️ CE REPLI DEGUISAIT UN TROU DE COUVERTURE EN ABSTENTION. `scanRug` tronquait sa liste a 20 sans
     * le dire, alors que MAX_NEW vaut 40 et que le commentaire ci-dessus annonce « 2 batches of 20 ». La
     * seconde moitie n'avait donc aucune cle dans `verdicts`, et ce `||` l'enregistrait en base comme
     * `unknown` — c'est-a-dire comme si le scanner avait regarde puis s'etait abstenu. Mesure du
     * 2026-07-28 sur cette base: 7 lignes portaient l'empreinte `reason: 'no verdict'` sur 152 `unknown`.
     * Aucune n'avait rugue, donc aucun rug manque, mais la scorecard decrit `abstained` comme « les rugs
     * qu'on avait qualifies d'unknown », ce que ces sept-la n'etaient pas.
     *
     * scanRug decoupe desormais correctement et nomme `not_scanned` ce qu'il refuse. Ce repli reste comme
     * garde-fou, mais il ne ment plus: si jamais il se declenche, la ligne dira qu'on n'a PAS regarde. */
    const v = verdicts[c.addr] || { verdict: 'not_scanned',
      reason: 'the scanner returned no entry for this address — it was NEVER examined. Not an abstention.',
      armed: [], flags: [] };
    db[c.addr] = { sym: c.sym, chain: CHAIN, source: c.source, firstSeen: now, lastSeen: now,
      firstVerdict: v.verdict, firstReason: v.reason, armedAtFirstSight: v.armed, flagsAtFirstSight: v.flags,
      /* THE BASIS OF THE CALL, frozen at the moment it was made.
       *
       * Until 2026-07-26 this row stored the verdict and its flags and nothing about what we had actually
       * SEEN. That gap surfaced while asking why `armedAtFirstSight` is empty on 214 of 214 tokens: PEEPS
       * was recorded as `caution — only 3 holders`, and GoPlus today reports `is_honeypot = 1` on it. Did we
       * miss a honeypot, or did that flag appear after the token died? **Unanswerable**, because the inputs
       * were never written down — so the question turns into an argument instead of a lookup.
       *
       * This is the same rule `meme-trader/lib/journal.js` enforces on the trading side, where it is stated
       * plainly: freeze the basis, and a later claim of "we knew because X" becomes checkable rather than
       * reconstructed. A scorecard whose asset is its track record cannot audit itself without it.
       *
       * `ownerStateAtFirstSight` matters most: it is the field our entire founding thesis rests on — a
       * dangerous power only counts if someone can still fire it — and GoPlus returns `owner_address` for
       * roughly one token in ten, so it is almost always `unknown`. Recording it makes that visible in the
       * data instead of inferable only by reading the source. */
      basisAtFirstSight: {
        ownerState: v.ownerState || null,
        holders: v.holders == null ? null : v.holders,
        lpLockedPct: v.lpLockedPct == null ? null : v.lpLockedPct,
        topWalletPct: v.topWalletPct == null ? null : v.topWalletPct,
        unreadable: Array.isArray(v.unknowns) ? v.unknowns.length : null,
      },
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
      /* IDENTITY IS NOT RISK — and this rule used to conflate them, expensively.
       *
       * It set `rug_ready`, our loudest verdict, on one fact: the symbol has a bigger contract elsewhere.
       * Measured 2026-07-26 against the outcomes it had already produced:
       *
       *   base rate, resolved tokens ............. 81%  (86 rugged / 20 survived)
       *   impersonation, resolved ................ 80%  (n=10)   -> lift  -1 point
       *   by distinct SYMBOL (5 HBULL relaunches are one event, not five)
       *                          ................. 83%  (n=6)    -> lift  +2 points
       *   on the cases the FUNDER signal did not already catch
       *                          ................. 67%  (4 catches, 2 false alarms, n=6)  -> lift -14 points
       *
       * So: no lift overall, WORSE than random on its own contribution, half its apparent wins already
       * belonged to the industrial-funder rule — and it produced both of our confirmed false alarms
       * (DINO and SOAS, still alive past the maturity window). It carried 13 of 13 `rug_ready` verdicts,
       * which means our top risk tier rested entirely on a rule that predicts nothing.
       *
       * The finding is not that the rule is worthless. Wearing another token's name is a real, checkable
       * fact and a buyer is genuinely being deceived by it. It is simply an answer to a DIFFERENT question:
       * "is this the token you think it is?" — identity — not "will this collapse?" — risk. Same mistake as
       * merging delivery into `verified` on the payment side, and it fails the same way: a serious signal on
       * one axis inflates a number on another axis that it cannot support.
       *
       * So the identity verdict now lives on its own field, reported loudly, and the risk verdict is left to
       * the risk signals. `rug_ready` is NOT reassigned to the funder rule to fill the gap: that rule scores
       * 16/16 in-sample, and promoting a tier by looking at the outcomes it will be graded against is the
       * exact error that killed two escalation rules here. The tier stays empty and the scorecard says so. */
      db[c.addr].impersonates = m.canonical && m.canonical.address ? m.canonical.address : true;
      db[c.addr].identityWarning = 'the symbol "' + c.sym + '" already has a dominant contract elsewhere — '
        + 'this one is not it. That is an identity warning, not a rug prediction: measured over our own '
        + 'outcomes, impersonators rug at the population rate, so treat this as "you may be buying the wrong '
        + 'token", not as "this one is about to collapse".';
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
    /* `siblingCount` vaut desormais `null` quand l'explorateur n'a pas repondu sur l'historique du
     * financeur (au lieu de `0`, qui se lisait « verifie, il n'a paye personne »). On PERSISTE le fait,
     * parce que l'annotation survit a la panne: sans ce drapeau, une nuit de rate-limit laisse en base des
     * lignes indiscernables d'un financeur reellement solitaire, et c'est ce que relit le tableau
     * `what-survives`. */
    db[c.addr].siblingsRead = f.siblingsRead !== false;

    /* KEEP THE SHARP NUMBERS, NOT ONLY THE BLUNT ONE.
     *
     * Until 2026-07-26 this line stored `siblingCount` and nothing else from the trace, and `siblingCount`
     * turns out to be the WORST of the numbers available:
     *
     *   `traceFeeder` reads ONE page from the explorer, which returns at most 50 transactions. So a stored
     *   50 does not mean "fifty wallets" — it means "the page was full and we stopped counting". Measured
     *   across the database: 56 of 113 traced tokens sit at exactly 50. Our most common value for our most
     *   valuable signal is the instrument's ceiling, not a measurement.
     *
     * The trace already computes better ones and they were being discarded at the door:
     *   identicalAmountSiblings — wallets paid the SAME amount. That is the scripted-factory signature, and
     *                             it is specific where a raw count is merely large.
     *   morePages               — whether the count is censored at all, which is the difference between
     *                             "exactly this many" and "at least this many".
     *   fundedEth               — the size of the float behind this particular launch.
     *
     * This matters more than a normal missing field: the scorecard database is the asset here, it only
     * accrues by having watched, and history CANNOT be backfilled because the explorer's pages move. Every
     * hour these were dropped is an hour of resolution lost for good. */
    db[c.addr].identicalAmountSiblings = f.identicalAmountSiblings;
    db[c.addr].identicalAmountEth = f.identicalAmount;
    db[c.addr].fundedEth = f.fundedEth;
    // `siblingCount` is a FLOOR, not a count, whenever the funder's history did not fit on one page.
    // Et un balayage QUI N'A PAS EU LIEU est le cas le plus censure de tous: avec `siblingCount: null`,
    // `!!null || null >= 50` rendait `false`, c'est-a-dire « ce compte est exact et complet » — l'inverse
    // exact de la verite, affirme au moment ou on en sait le moins.
    db[c.addr].siblingCountCensored = f.siblingsRead === false || !!f.morePages || f.siblingCount >= 50;
    if (f.identicalAmountSiblings >= SIBLING_ALERT || f.siblingCount >= SIBLING_ALERT) clusters.push({ ...c, f });

    // The one rule this session that survived its own backtest. Measured over 62 tokens with funding data:
    // a funder that has paid 20 or more wallets precedes a rug 83% of the time against a 56% base rate, and
    // raising the bar from 5 to 20 caught the SAME 40 rugs while sparing 3 survivors — strictly better, not a
    // trade-off. It also separates cleanly from a legitimate batch launcher: eight tokens in this database
    // share one deployer with 3 siblings each and not one of them died.
    // Deliberately high_risk and not rug_ready. rug_ready means a power someone can fire; this means the
    // token shares fate with an industrial operation, which is serious without being proof.
    /* THE THRESHOLD, checked 2026-07-26 rather than assumed.
     *
     * Sweeping thresholds and keeping the best is how two rules died here, so the distribution was looked at
     * FIRST. It is sharply bimodal: 1×15, 3×15, 6×2, 11×1 — then nothing at all — then 26×22, 27×2, 50×56.
     * The threshold of 20 sits in an entirely empty gap, so any value from 12 to 26 gives an identical
     * answer. This one cannot be overfitted because there is nothing to fit. */
    if ((f.siblingCount || 0) >= INDUSTRIAL_FUNDER && db[c.addr].firstVerdict !== 'rug_ready') {
      const censored = !!f.morePages || f.siblingCount >= 50;
      db[c.addr].firstVerdict = 'high_risk';
      // "50" is the page ceiling, not a count — saying "50 wallets" understates it as a fact and overstates
      // it as a measurement. At least N is the true claim, and it is the stronger one anyway.
      db[c.addr].firstReason = 'its funder has bankrolled ' + (censored ? 'at least ' : '') + f.siblingCount +
        ' wallets' + (censored ? ' (its history did not fit on one page, so that is a floor)' : '') +
        ' — industrial scale, and 83% of tokens behind such a funder have rugged in what we have watched';
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
  /* The card is computed by lib/scorecard.js, and lives there rather than here for one reason: this file is a
   * cron script wrapped in an IIFE, so requiring it RUNS it, and the arithmetic behind the single number a
   * buyer would act on had therefore never been touched by a test. It has now — test/scorecard.test.js, with
   * a row for each of the three ways this scorecard has actually lied about our own performance.
   *
   * `now` is passed in rather than read inside, which is what lets a test place a token at any age. */
  // The card carries the watch's own gaps: a count of rugs is only as complete as the hours it covers.
  const card = scoreCalls(all, now, { blackouts: readJSON(BLACKOUTS, []) });

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

  // Notes raised during the harvest — pools skipped for claiming liquidity they cannot back with volume.
  // They belong in the digest: a pool silently dropped looks identical to a pool that never existed.
  for (const n of HARVEST_NOTES) lines.push(n);

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
      ' IDENTITY warning, not a risk verdict: measured over our own outcomes, impersonators rug at the ' +
      'population rate (80% vs 81% base; 67% on the cases the funder signal did not already catch). You may ' +
      'be buying the wrong token — that is the harm here, and it is real on its own.');
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
    ' · strong calls ' + card.strongCallsRight + ' right / ' + card.strongCallsWrong + ' wrong / ' +
      card.strongCallsOpen + ' OPEN' +
      (card.strongPrecisionResolved == null
        ? ' — no resolved call yet, so no precision to claim'
        : ' → precision ' + card.strongPrecisionResolved + ' on resolved, ' +
          card.strongPrecisionWorstCase + ' if every open call is wrong'));
  for (const l of lines) console.log('  ' + l);
})();
