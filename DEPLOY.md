# Deploy BIII (go live)

BIII is a single Node process (`lib/server.js`) that serves the merchant PWA **and** the REST API from one
origin. It is **non-custodial** — it holds no key and moves no funds; the customer pays the merchant's own
wallet directly, and the chain is the only thing that says "paid". Self-contained: `trust-core` is vendored
(`vendor/trust-core`), so it builds from this repo alone — no sibling checkout, no build step, no native deps.

## One thing to set

| Env | Required | What |
| --- | --- | --- |
| `BIII_MERCHANT` | **yes** | the merchant's own Base wallet (`0x…`). One merchant per deploy — the server pins it, so a caller can never redirect a charge to another address. |
| `BASE_RPC_URL` | no | Base RPC for reading the chain. Defaults to public `https://mainnet.base.org` (fine for a low-volume till). Set a dedicated RPC to avoid public rate limits under load. Read-only. |
| `PORT` | no | Railway/most PaaS inject it. Local default `4700`. |
| `BIII_VET_PRICE_USD` | no | price per PAID x402 verdict (see "Sell verdicts" below). Default `0.002`. |
| `BIII_X402_CONSUMED` | no | path to the anti-replay store. Default `/data/x402-consumed.json` (mount a volume at `/data` to make single-use durable across redeploys). |

## Railway (or any Docker host)

The repo ships a pinned `Dockerfile`, so the platform builds a reproducible image:

1. New project → Deploy from the `biii` repo.
2. Variables → add `BIII_MERCHANT=0x<merchant wallet>`.
3. Deploy. Health check path: `/health`. Open the service URL on a phone → the till loads.

No Dockerfile host? `npm start` (Node ≥18) runs the same server; `data/known-bad.json` (the screening floor)
and `vendor/trust-core` ship in the repo, so screening + the local classifier are live out of the box.

## Sell verdicts via x402 (get paid)

The same server exposes **paid** verdicts an agent can discover and pay per call — the "safe to pay"
ingredient, priced in USDC on Base, received by the merchant wallet (non-custodial; we receive, we
never spend).

- **Discovery:** `GET /openapi.json` — the x402/AgentCash contract (agents find + price the service).
- **Paid:** `POST /x402/vet-asset` `{address, claimedIssuer?, claimedSymbol?}` (genuine/impersonation) and
  `POST /x402/vet-address` `{address}` (safe-to-pay / known-bad). Unpaid → a `402` challenge
  (`accepts[]`: pay `BIII_VET_PRICE_USD` USDC on Base **to `BIII_MERCHANT`**); pay, then re-call with the
  txHash in the `X-Payment` header → the verdict.
- **One payment = one verdict.** A confirmed, fresh USDC payment to the merchant redeems exactly one
  verdict — a reused/old/underpaid tx gets `402`/`409`, never a free verdict (`lib/x402-settle.js`,
  tested). **Mount a Railway volume at `/data`** so this single-use survives redeploys (`BIII_X402_CONSUMED`
  defaults to `/data/x402-consumed.json`); without a volume, freshness still caps replay to ~30 min.

**Turn it on:** on the deployed service, set `BIII_MERCHANT=0x<MainStreet wallet>` (the payTo), optionally
`BIII_VET_PRICE_USD`, add a **Volume mounted at `/data`**, and redeploy. Confirm the paywall fires:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-app>/x402/vet-asset \
  -H 'content-type: application/json' -d '{"address":"0x1234"}'   # → 402 (paywall live)
```

## Verify it's live (30 seconds)

```bash
curl -s https://<your-app>/health           # {"ok":true,"merchantConfigured":true,...}
curl -s "https://<your-app>/trust?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"  # Lazarus → blocked:true
```

Then open `https://<your-app>/` — the caisse. Type an amount → a customer scans the EIP-681 QR and pays
USDC on Base → the server verifies the transfer field-for-field and shows **PAID ✓** with a txHash receipt.

Want proof the chain path works before deploying? `npm run test:e2e` verifies a **real** recent USDC
transfer on Base end-to-end (real RPC → verifyPayment → receipt). It's network-gated: it skips cleanly
offline, so it never blocks CI, but it's a live proof when you have a connection.

## Notes

- **Screening ships live**: `data/known-bad.json` (811 public OFAC/label addresses) is committed, so a
  known-bad recipient is blocked with zero external calls.
- **Tokenized-asset registry is optional**: `data/rwa-registry.json` is generated (gitignored). Absent in a
  fresh deploy, `/asset` fail-closes to `unknown` (never a false `genuine`) — run
  `node scripts/biii-rwa-registry.js` to populate it, or bring an issuer-official list.
- **Nothing custodial to secure**: no private key is ever set or held. `BASE_RPC_URL` is a read endpoint.
