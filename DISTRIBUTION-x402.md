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

## The one thing that unlocks the auto-indexed venues

Onyx Bazaar, the CDP Bazaar, gold-402's full catalog, and Agent.market all index off the **Coinbase CDP
x402 discovery**, which surfaces services that have **real on-chain x402 settlements**. So **one real
$0.25 USDC settlement through `/x402/vet-asset`** (a) proves the full paid path end-to-end in prod, and
(b) makes BIII start appearing in those directories automatically.

- **Cheapest path:** an external agent pays once (the honest "meets a buyer" signal). A self-pay dogfood
  also triggers indexing mechanically, but it is a wash — prefer a real external caller when possible.
- Phil's gesture: it moves funds ($0.25), so BIII (and this AI) never executes it — a wallet pays the
  challenge's `payTo` and re-calls with the txHash in the `X-Payment` header.

## Anti-hype / posture
Every listing describes only what BIII does (fail-closed, non-custodial, re-verifiable on-chain). No
inflated numbers, no promo spam — only curated lists that invite service entries.
