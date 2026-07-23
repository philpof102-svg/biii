#!/usr/bin/env bash
# market-data.sh — LIVE market data from a free, keyless public API (Binance), for the market-watch agent.
# Used as `hermes cron create <sched> "<prompt>" --script market-data.sh` (WITHOUT --no-agent): the stdout
# is injected into the agent's prompt each run, so the LLM reasons over REAL numbers, not from memory.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}

one() {
  curl -s -m 8 "https://api.binance.com/api/v3/ticker/24hr?symbol=$1" 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); const n=x=>Number(x).toLocaleString("en-US",{maximumFractionDigits:2});
        console.log(process.argv[1]+": $"+n(j.lastPrice)+"  24h "+Number(j.priceChangePercent).toFixed(2)+"%  (24h H $"+n(j.highPrice)+" / L $"+n(j.lowPrice)+", vol "+n(j.quoteVolume)+")");
      } catch(e){ console.log(process.argv[1]+": data unavailable"); }
    })' "$2"
}

echo "LIVE MARKET DATA (Binance public, $(date -u +%Y-%m-%d\ %H:%MZ)):"
one BTCUSDT BTC
one ETHUSDT ETH
