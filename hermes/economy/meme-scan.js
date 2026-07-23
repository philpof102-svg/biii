'use strict';
// meme-scan.js — the meme-genuineness HARVESTER. Pulls the tokens being BOOSTED/promoted right now on
// DexScreener (any chain — the freshest impersonation surface, where paid-boost scams live) + a Base seed,
// and runs the fail-closed vetMeme verdict on each. Deterministic (no LLM) → $0 no_agent cron; stdout = brief.
const https = require('node:https');
const { vetMeme } = require('../../lib/meme');

const SEED = (process.env.MEME_WATCH || 'BRETT,TOSHI,DEGEN,SPX,ANDY,KEYCAT').split(',').map((s) => s.trim()).filter(Boolean);
const CHAINS = (process.env.MEME_CHAINS || 'base,solana,ethereum,bsc').split(',');   // harvest surface

function getJSON(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); })
      .on('error', () => resolve(null));
  });
}

// The FRESH surface: tokens being paid-boosted RIGHT NOW (promotion = where impersonation scams live).
async function boostedTokens(limit = 12) {
  const boosts = await getJSON('https://api.dexscreener.com/token-boosts/latest/v1');
  const pick = (Array.isArray(boosts) ? boosts : []).filter((b) => CHAINS.includes(b.chainId)).slice(0, limit);
  const out = [];
  for (const b of pick) {
    const t = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + b.tokenAddress);
    const sym = t && t.pairs && t.pairs[0] && t.pairs[0].baseToken && t.pairs[0].baseToken.symbol;
    if (sym) out.push({ symbol: sym.toUpperCase(), address: b.tokenAddress, chain: b.chainId });
  }
  return out;
}

(async () => {
  const boosted = await boostedTokens();
  const lines = [];
  let alerts = 0;

  // 1) FRESH harvest — is each promoted contract actually the real one for its symbol?
  for (const { symbol, address, chain } of boosted) {
    let v; try { v = await vetMeme({ symbol, chainId: chain, address }); } catch { continue; }
    const n = (v.candidates || []).length;
    if (v.status === 'impersonation') { alerts++; lines.push(`🚩 BOOSTED ${symbol} [${chain}] ${address.slice(0, 10)}…: IMPERSONATION — the promoted contract is NOT the dominant one. Paid-boost trap.`); }
    else if (v.status === 'ambiguous') { alerts++; lines.push(`🚩 BOOSTED ${symbol} [${chain}]: AMBIGUOUS — ${n} contracts, no clear real one (verify holders before aping).`); }
    else if (v.status === 'genuine') lines.push(`· boosted ${symbol} [${chain}]: promoted = the dominant contract${n > 1 ? ' (' + (n - 1) + ' look-alike(s) exist)' : ''}.`);
    else if (v.status === 'thin') lines.push(`· boosted ${symbol} [${chain}]: thin liquidity — nothing credible.`);
  }

  // 2) SEED watch — well-known memes, so a fresh fake on a big name still gets caught.
  for (const sym of SEED) {
    let v; try { v = await vetMeme({ symbol: sym }); } catch { continue; }
    const n = (v.candidates || []).length;
    if (v.status === 'ambiguous') lines.push(`  ~ ${sym}: ${n} contracts, top two tied (standing ambiguity).`);
    else if (v.status === 'genuine' && n > 1 && v.canonical) lines.push(`  ~ ${sym}: real = ${v.canonical.chain}:${v.canonical.address.slice(0, 8)}… · ${n - 1} look-alike(s).`);
  }

  console.log(alerts
    ? `🚩 meme-watch harvest: ${alerts} FRESH trap(s) among ${boosted.length} boosted tokens — aping the wrong contract = total loss.`
    : `✓ meme-watch harvest: ${boosted.length} boosted tokens scanned, no impersonation/ambiguity among the promoted ones.`);
  for (const l of lines) console.log('  ' + l);
})();
