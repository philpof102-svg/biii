# BIII — x402 distribution (meet real buyers)

BIII is a **live production x402 service** on Base — discovery at
[`/openapi.json`](https://biii-production.up.railway.app/openapi.json), paid verdicts at
`POST /x402/vet-asset` and `/x402/vet-address` ($0.25 USDC, payTo the merchant wallet, non-custodial).
Getting it in front of paying agents = the "structure must meet the market" move.

## Where it's listed / can be listed

| Venue | What it is | Status |
| --- | --- | --- |
| **[awesome-agentic-commerce](https://github.com/Merit-Systems/awesome-agentic-commerce)** | Curated x402 ecosystem list (Ecosystem section) | ✅ **PR #502 open** |
| **[Onyx Bazaar](https://onyx-actions.onrender.com/bazaar)** | Free leaderboard of every paid x402 service, **indexed via Coinbase CDP discovery** (refresh 15 min) | ⏳ auto-lists once a real on-chain **settle** exists (see below) |
| **Coinbase Agent.market** | Coinbase's directory of x402 services (7 categories) | ⏳ CDP registration — Phil's gesture (CDP account) |
| **[gold-402](https://github.com/Haustorium12/gold-402)** | Curated x402 directory (24K Labs), verified badges; also sources from CDP Bazaar + Agentic.market | ⏳ submit / auto via CDP catalog after a settle |
| **[x402.org/ecosystem](https://www.x402.org/ecosystem)** | Official x402 ecosystem directory | ⏳ submit |
| **lawbor bazaar** (ours) | Our own agent bazaar (`lawbor_offer`) | ⏳ post an offer — Phil signs the envelope |

## Correction (2026-07-23): a settlement does NOT auto-index us

**First real settle DONE** — tx `0x4be3f98d…c80bd3`, $0.25 USDC on Base → merchant, redeemed an
`impersonation` verdict live; replay refused (`409`). The paid path is **proven end-to-end in prod.**

But an earlier assumption here was **wrong and is retracted**: a settlement does **not** make BIII
appear on the CDP-indexed venues automatically. Why — BIII's x402 verifies the payment **directly
on-chain** (`verifyTxHash` → Base RPC), by design **non-custodial, with no CDP facilitator in the loop**.
The CDP x402 discovery only surfaces settlements it **observes through the Coinbase facilitator**; ours
never touch it, so CDP has no record to index. (And Onyx Bazaar is a top-100-by-volume board — a
one-call service wouldn't show there regardless.) Verified: not listed on Onyx Bazaar after the settle.

**What actually gets us listed (explicit, honest):**
- **Curated lists that invite entries** — `awesome-agentic-commerce` (PR #502, already open). This is the
  real, no-hype channel.
- **The hosted MCP endpoint + the MCP registry** (`DISTRIBUTION-mcp.md`) — `/mcp` is live now; the npm
  `biii-mcp` is registry-ready (publish = one tag). The MCP registry is what agent hosts actually index.
- **Only if we want the CDP venues**: either register BIII's `/openapi.json` with the CDP discovery
  explicitly, or route settlements through the CDP facilitator — the latter trades away part of our
  facilitator-less, non-custodial posture, so it's a deliberate choice, not a freebie.

## Anti-hype / posture
Every listing describes only what BIII does (fail-closed, non-custodial, re-verifiable on-chain). No
inflated numbers, no promo spam — only curated lists that invite service entries.
