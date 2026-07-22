# Our agent team — one local Hermes running our whole stack (the living agentic economy)

Applying the "AI agent team" playbook to our infrastructure: split the work into specialized agents, each
with a tight **job description**, chain them (output → input), keep a **human checkpoint** on anything that
publishes/spends, and keep a **Corrections Log** so each agent sharpens over time. Built on ONE local Hermes
(`~/.hermes-biii`) running four of our servers as toolsets.

## The economy (five toolsets, ~98 tools, all in one Hermes)
| Toolset | What it gives the team |
|---|---|
| **biii** (15) | Base trust / safe-to-pay verdicts; token genuineness; the x402 paid vet surface |
| **gitlawb** (40) | decentralized git, PRs, issues, **bounties + agent-task delegation**, DID resolution |
| **monid** (13) | discover + pay-per-call 1,800+ data/tools (Exa, TikHub, enrichment) |
| **lawbor** (27) | **agent-to-agent messaging + bazaar + jobs (post/bid/quote/confirm/settle) + reputation** |
| **recall** (3) | READ-ONLY recall of our second brain (Obsidian vault + mainstreet memory); `memory_search/read/index`, path-locked, so the agent stops losing what we decided. Wired as key `recall`, not `memory` (Hermes ships a built-in `memory` that shadows it). |

Models (OpenRouter): default `tencent/hy3` (cheap routine), `-m moonshotai/kimi-k3` for hard RC tasks.

## The team (job descriptions — Role / Input / Output / Escalation)

### 1. biii-monitor — trust surveillance (READ-ONLY, always on)
- **Role:** watch a watchlist of Base wallets + tokens and flag known-bad / impersonations.
- **Input:** `watchlist.json`. **Output:** a flags brief (each flag + a delegated follow-up). **Escalation:** on a flag, delegate a deeper investigation; on a coverage gap (e.g. cbBTC), surface it for the registry.
- **Runs:** keyless cron `every 30m` (`biii-scan.sh`, 0 spend). Agent mode on-demand for reasoning.

### 2. x-devradar — ecosystem research / self-improvement (SPENDS, supervised)
- **Role:** watch a few X accounts + the web via Monid; surface NEW dev tools / agent-infra with an integration angle for us.
- **Input:** `x-devradar/watchlist.json`. **Output:** a new-tools brief → `cache/devradar.json`. **Escalation:** flag anything worth a build; never fabricate — if the source is down, report $0.
- **Runs:** on-demand only, `MONID_ALLOW_SPEND=1`, ~$0.025/cycle capped.

### 3. deal-prep — buy preparation (NON-CUSTODIAL, never executes)
- **Role:** find a buy (discounted inference / an x402 resource / a token) and PREPARE a capped, vetted intent.
- **Input:** {token/recipient, amountUsd, cap}. **Output:** `prepareBuy()` → a capped EIP-681 intent + verdict. **Escalation:** REFUSE if the recipient is known-bad or the token is an impersonation; the human's wallet executes.

## The disciplines (from the playbook)
- **Human checkpoint = the guard.** `readonly-guard.js` (pre_tool_call) blocks every WRITE/SPEND across all four
  toolsets by default — `till_create_*`, gitlawb writes, `monid.run`/pay, `lawbor_say/offer/bid/settle/block`,
  base `send/swap/sign`. Reads/verdicts pass. Spend/act is a per-run explicit opt-in (`MONID_ALLOW_SPEND=1`),
  never for base/gitlawb/lawbor writes. Nothing publishes, offers, settles, or spends autonomously.
- **Corrections Log.** Each agent's mistakes/findings feed back into the system, not just the one output — the
  loop that turned the agent's "cbBTC is unknown" into an issuer-verified registry entry, and its monid-schema
  gotcha into the x-devradar skill. Keep a running log per agent; every correction makes the next run better.
- **Chain, don't merge.** One agent's output is the next's input (radar finds a tool → we wire it; monitor finds
  a gap → deal-prep/registry acts). Keep a human in the loop between value-moving handoffs.
- **Scale one at a time. Grade like an employee.** Prove one agent on real work before adding the next.

## Interop (why it's an *economy*, not just a toolbox)
A gitlawb bounty or a lawbor job pays in USDC → biii vets "safe to pay this agent" (`gitlawb-trust` composes
reputation + safe-to-pay) → deal-prep builds the capped intent → the human executes. An outside agent can even
pay BIII's own x402 vet endpoint. Trust + collaboration + payment + reputation, in one loop.
