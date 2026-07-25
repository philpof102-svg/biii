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

const DB_DIR = path.join(__dirname, '..', '..', 'data', 'token-radar');
const TOKENS = path.join(DB_DIR, 'tokens.json');          // per-token state (the memory)
const OBS = path.join(DB_DIR, 'observations.jsonl');      // append-only audit trail
const CARD = path.join(DB_DIR, 'scorecard.json');         // the falsifiable track record

const CHAIN = process.env.RADAR_CHAIN || 'base';
const MIN_LIQ_WATCH = 5000;      // below this a "pool" is dust, not a market worth tracking
const RUG_DROP = 0.80;           // >=80% off its own peak liquidity = the pool was pulled
const RUG_FLOOR = 2000;          // ...and what is left is not a market anymore
const MAX_NEW = 20;              // GoPlus batches 20 contracts per request
const TRACE_MAX = 6;             // funding traces per run — 3 explorer calls each, on a free endpoint

function getJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const pct = (n) => Math.round(n * 100) + '%';
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** Freshest launches on the chain — pools created minutes ago, before anyone has looked at them. */
async function harvestNewPools() {
  const j = await getJSON('https://api.geckoterminal.com/api/v2/networks/' + CHAIN + '/new_pools?page=1');
  const out = [];
  for (const p of ((j && j.data) || [])) {
    const a = p.attributes || {}, rel = p.relationships || {};
    const liq = parseFloat(a.reserve_in_usd) || 0;
    const id = ((rel.base_token || {}).data || {}).id || '';       // e.g. "base_0xabc..."
    const addr = id.split('_')[1];
    if (!addr || liq < MIN_LIQ_WATCH) continue;
    out.push({ addr: addr.toLowerCase(), sym: String(a.name || '').split('/')[0].trim(), liq, source: 'new_pool', createdAt: a.pool_created_at || null });
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
  const armed = [], survivors = [], watch = [];
  for (const c of toJudge) {
    const v = verdicts[c.addr] || { verdict: 'unknown', reason: 'no verdict', armed: [], flags: [] };
    db[c.addr] = { sym: c.sym, chain: CHAIN, source: c.source, firstSeen: now, lastSeen: now,
      firstVerdict: v.verdict, firstReason: v.reason, armedAtFirstSight: v.armed, flagsAtFirstSight: v.flags,
      firstLiq: c.liq, peakLiq: c.liq, lastLiq: c.liq, outcome: 'live' };
    obsOut += JSON.stringify({ ts: now, addr: c.addr, sym: c.sym, chain: CHAIN, source: c.source, liq: c.liq, verdict: v.verdict, armed: v.armed, flags: v.flags }) + '\n';
    if (v.verdict === 'rug_ready') armed.push({ ...c, v });
    else if (v.verdict === 'clean') survivors.push({ ...c, v });
    else watch.push({ ...c, v });
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
  }
  if (toJudge.length > toTrace.length) lines.push('   (funding traced for the ' + toTrace.length + ' largest of ' + toJudge.length + ' — the rest were skipped, not cleared)');

  // ---------- SCORECARD: what our calls were actually worth --------------------------------------
  const all = Object.values(db);
  const rugged = all.filter((t) => t.outcome === 'rugged');
  const caught = rugged.filter((t) => t.firstVerdict === 'rug_ready' || t.firstVerdict === 'high_risk');
  const missed = rugged.filter((t) => t.firstVerdict === 'clean');
  const stillLive = all.filter((t) => t.outcome === 'live');
  const falseAlarms = stillLive.filter((t) => t.firstVerdict === 'rug_ready');
  const card = {
    updatedAt: now, tokensTracked: all.length, rugsObserved: rugged.length,
    caughtBeforeTheRug: caught.length, missed: missed.length,
    catchRate: rugged.length ? +(caught.length / rugged.length).toFixed(2) : null,
    flaggedButStillAlive: falseAlarms.length,
    note: 'catchRate = share of observed rugs we had already called rug_ready/high_risk at first sight. flaggedButStillAlive is our false-alarm count and is published on purpose: a scanner that only reports its wins is marketing, not evidence.',
  };

  writeJSON(TOKENS, db);
  writeJSON(CARD, card);
  if (obsOut) fs.appendFileSync(OBS, obsOut);

  // ---------- REPORT ----------------------------------------------------------------------------
  const head = armed.length
    ? '🚩 token-radar: ' + armed.length + ' ARMED rug(s) among ' + toJudge.length + ' fresh ' + CHAIN + ' launches — the deployer can still pull the trigger.'
    : '✓ token-radar: ' + toJudge.length + ' fresh ' + CHAIN + ' launches judged, none with a fireable rug power.';
  console.log(head);

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
  for (const c of clusters) {
    lines.push('🕸️ ' + c.sym + ' shares a paymaster: deployer ' + c.f.deployer.slice(0, 10) + '… funded by ' +
      c.f.funder.slice(0, 10) + '… (' + c.f.fundedEth + ' ETH' + (c.f.freshDeployer ? ', its ONLY incoming tx' : '') + ')');
    lines.push('     ' + c.f.pattern + (c.f.morePages ? ' — and that is one page of many' : ''));
    lines.push('     structure, not intent: these tokens share fate. Judge them together.');
  }
  if (newlyRugged.length) {
    lines.push('📉 RUGGED since last run (' + newlyRugged.length + ') — grading our own call:');
    for (const r of newlyRugged) {
      const grade = r.firstVerdict === 'clean' ? '❌ WE MISSED IT' : '✅ we had called it ' + r.firstVerdict;
      lines.push('   · ' + r.sym + ' ' + pct(r.dropPct) + ' off peak (' + usd(r.peakLiq) + ' → ' + usd(r.lastLiq) + ') — ' + grade);
    }
  }
  lines.push('📊 scorecard: ' + card.tokensTracked + ' tracked · ' + card.rugsObserved + ' rugs observed · caught ' +
    card.caughtBeforeTheRug + ', missed ' + card.missed + (card.catchRate != null ? ' (catch rate ' + pct(card.catchRate) + ')' : ' (no rug observed yet — no rate to claim)') +
    ' · ' + card.flaggedButStillAlive + ' flagged still alive');
  for (const l of lines) console.log('  ' + l);
})();
