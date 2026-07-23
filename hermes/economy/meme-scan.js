'use strict';
// meme-scan.js — grind meme-genuineness across a watchlist. Deterministic (no LLM), so it runs as a
// $0 no_agent Hermes cron: its stdout IS the brief. Flags the DANGEROUS case (ambiguous / trap) where
// aping the wrong contract = total loss, and names the canonical + look-alikes for clean ones.
const { vetMeme } = require('../../lib/meme');

const WATCH = (process.env.MEME_WATCH || 'BRETT,TOSHI,DEGEN,MOCHI,KEYCAT,MIGGLES,SPX,ANDY')
  .split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  const lines = [];
  let alerts = 0;
  for (const sym of WATCH) {
    let v; try { v = await vetMeme({ symbol: sym }); } catch { continue; }
    const n = (v.candidates || []).length;
    if (v.status === 'ambiguous') { alerts++; lines.push(`🚩 ${sym}: AMBIGUOUS — ${n} credible contracts, top two too close to name the real one (rug-bait; check holders before aping).`); }
    else if (v.status === 'genuine' && n > 1 && v.canonical) lines.push(`✓ ${sym}: real = ${v.canonical.chain}:${v.canonical.address.slice(0, 10)}… ($${Math.round(v.canonical.liquidityUsd).toLocaleString()} liq) · ${n - 1} look-alike(s) to avoid.`);
    else if (v.status === 'genuine') lines.push(`✓ ${sym}: single credible contract.`);
    else if (v.status === 'thin') lines.push(`· ${sym}: no credible contract (all thin).`);
  }
  console.log(alerts
    ? `🚩 meme-watch: ${alerts} symbol(s) with an AMBIGUOUS/trap contract situation — aping the wrong one = total loss.`
    : `✓ meme-watch: ${WATCH.length} symbols scanned, none currently ambiguous.`);
  for (const l of lines) console.log('  ' + l);
})();
