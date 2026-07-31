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

ARCHITECTURE CONSTRAINT — read before proposing anything. Our classifier runs LOCALLY at the caller, with NO network call in the payment path. That property is the only defensible thing we have, and it is what buyers actually asked for ('pluggable, self-hostable'). Three separate outreach attempts were rejected for the SAME reason: they put a live third-party network call inside the payment path. So do NOT propose: gating a paid verdict on a live price/DEX/oracle lookup, streaming events to pause a session mid-payment, or any design where a settlement waits on an external endpoint. Enrichment computed OUT of band and cached locally is fine; a blocking call at pay time is not.

EVIDENCE CONSTRAINT — never write a contract address, tx hash or identifier you have not resolved in this run from the data above. Do not reproduce one from memory: a near-miss address is worse than no address, and past passes emitted factory addresses that carry no code on Base and one belonging to a different chain. If you want to reference a contract you cannot resolve, describe it in words instead.

NOVELTY CONSTRAINT — you are one pass in a long series appending to the same file. If your idea is the shape 'index/stream/poll on-chain events X to feed verdict Y', it has already been written more than a dozen times and adds nothing. Go somewhere else: distribution, pricing, packaging, what makes a stranger's agent call us a second time, what we could stop doing.

Write exactly 2 SHORT, CONCRETE ideas or next actions — grounded, zero hype, each 1-2 lines. Then one line: the single highest-leverage next step. Be terse and specific."

BODY=$(node -e 'process.stdout.write(JSON.stringify({model:"tencent/hy3",messages:[{role:"user",content:process.argv[1]}]}))' "$PROMPT")
RESP=$(curl -s -m 60 https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "content-type: application/json" -d "$BODY")
IDEAS=$(printf '%s' "$RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const c=JSON.parse(d).choices[0].message.content;process.stdout.write(c)}catch(e){process.stdout.write("(no output — "+e.message+")")}})')

# Resolve every 0x… address the model wrote, against the chain it was attributed to. The prompt ASKS the
# model not to invent identifiers; this CHECKS it. An instruction is obeyed until it isn't, and past
# passes emitted a Uniswap factory address with no code on Base (one hex run off the real one) and a
# mainnet-Ethereum pool address presented as Base. Those blocks feed the vault, so an unverified address
# becomes a future session's starting truth. Cheap: one eth_getCode per distinct address, and the
# annotation goes INTO the appended block so the reader sees the verdict next to the claim.
VERDICT=$(printf '%s' "$IDEAS" | grep -oiE '0x[0-9a-f]{40}' | sort -fu | while read -r ADDR; do
  [ -z "$ADDR" ] && continue
  CODE_BASE=$(curl -s -m 15 https://mainnet.base.org -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$ADDR\",\"latest\"],\"id\":1}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const r=JSON.parse(d).result;process.stdout.write(r===undefined?"ERR":(r==="0x"?"none":String((r.length-2)/2)))}catch(e){process.stdout.write("ERR")}})')
  case "$CODE_BASE" in
    ERR)  echo "- \`$ADDR\` — ⚠️ could not be resolved (RPC unreachable). Unverified, not disproven." ;;
    none) echo "- \`$ADDR\` — ❌ **no code on Base.** Do not act on this address without resolving it yourself." ;;
    *)    echo "- \`$ADDR\` — ✅ contract on Base ($CODE_BASE bytes). Identity NOT verified, only existence." ;;
  esac
done)

if {
  echo ""; echo "## $STAMP — strategist"; echo ""; echo "$IDEAS"; echo ""
  if [ -n "$VERDICT" ]; then
    echo "**Address check (automated, against Base at write time):**"; echo ""
    echo "$VERDICT"; echo ""
  fi
  echo "---"
} >> "$VAULT"; then APPEND_OK=1; else APPEND_OK=0; fi

echo "strategist appended to IDEAS-agent.md @ $STAMP:"
echo "$IDEAS"
if [ -n "$VERDICT" ]; then echo ""; echo "address check:"; echo "$VERDICT"; fi

# Le code de sortie doit dire UNE chose: l'idee a-t-elle ete enregistree.
#
# Avant, la derniere commande etait `[ -n "$VERDICT" ] && { ... }`. Sans adresse a verifier — c'est-a-dire
# quand le modele se comporte BIEN — le test est faux, le && court-circuite, et le script sortait en 1.
# La passe du 2026-07-31 12:37Z, la premiere reussie sous les nouvelles contraintes, a ete enregistree
# `status: error` pour cette seule raison. Un statut d'erreur sur un travail reussi apprend a ignorer les
# statuts d'erreur, ce qui coute plus cher que le bug lui-meme.
#
# Et l'inverse etait vrai aussi: l'ancien script se terminait par un `echo`, donc il sortait 0 meme quand
# la redirection vers le vault echouait. Le statut ne portait aucune information dans les deux sens.
if [ "$APPEND_OK" != "1" ]; then
  echo "[strategist] ECHEC: impossible d'ecrire dans le vault ($VAULT). L'idee n'est PAS enregistree." >&2
  exit 1
fi
exit 0
