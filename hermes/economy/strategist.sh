#!/usr/bin/env bash
# strategist.sh — the THINKER of the economy. Gathers live signals, asks an LLM for 2 concrete ideas /
# next actions, and APPENDS them to the Obsidian vault (IDEAS-agent.md). Self-contained (calls OpenRouter
# directly + writes the file itself), so it runs as a `--no-agent` cron: the script IS the job.
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}
set -a; . /root/.hermes-biii/.env; set +a
VAULT="/mnt/d/memoire claude obsidian/IDEAS-agent.md"
STAMP=$(date -u +"%Y-%m-%d %H:%MZ")
DATA=$(bash /root/.hermes-biii/scripts/market-data.sh 2>/dev/null)

PROMPT="You are the strategist of a lean living economy on Base: BIII (non-custodial safe-to-pay + token-genuineness verdicts, LIVE, paid per call via x402 \$0.25, hosted /mcp) + a keyless on-chain trust sentinel + a market-watch agent. LIVE market data now:
$DATA
Write exactly 2 SHORT, CONCRETE ideas or next actions for the economy — grounded, zero hype, each 1-2 lines. Where relevant, name a SPECIFIC on-chain data source or endpoint we could turn into signal (Base RPC logs, USDC transfers, DEX pools, a contract's events — these can be gold). Then one line: the single highest-leverage next step. Be terse and specific."

BODY=$(node -e 'process.stdout.write(JSON.stringify({model:"tencent/hy3",messages:[{role:"user",content:process.argv[1]}]}))' "$PROMPT")
RESP=$(curl -s -m 60 https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "content-type: application/json" -d "$BODY")
IDEAS=$(printf '%s' "$RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const c=JSON.parse(d).choices[0].message.content;process.stdout.write(c)}catch(e){process.stdout.write("(no output — "+e.message+")")}})')

{ echo ""; echo "## $STAMP — strategist"; echo ""; echo "$IDEAS"; echo ""; echo "---"; } >> "$VAULT"
echo "strategist appended to IDEAS-agent.md @ $STAMP:"
echo "$IDEAS"
