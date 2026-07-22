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

## Railway (or any Docker host)

The repo ships a pinned `Dockerfile`, so the platform builds a reproducible image:

1. New project → Deploy from the `biii` repo.
2. Variables → add `BIII_MERCHANT=0x<merchant wallet>`.
3. Deploy. Health check path: `/health`. Open the service URL on a phone → the till loads.

No Dockerfile host? `npm start` (Node ≥18) runs the same server; `data/known-bad.json` (the screening floor)
and `vendor/trust-core` ship in the repo, so screening + the local classifier are live out of the box.

## Verify it's live (30 seconds)

```bash
curl -s https://<your-app>/health           # {"ok":true,"merchantConfigured":true,...}
curl -s "https://<your-app>/trust?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"  # Lazarus → blocked:true
```

Then open `https://<your-app>/` — the caisse. Type an amount → a customer scans the EIP-681 QR and pays
USDC on Base → the server verifies the transfer field-for-field and shows **PAID ✓** with a txHash receipt.

## Notes

- **Screening ships live**: `data/known-bad.json` (811 public OFAC/label addresses) is committed, so a
  known-bad recipient is blocked with zero external calls.
- **Tokenized-asset registry is optional**: `data/rwa-registry.json` is generated (gitignored). Absent in a
  fresh deploy, `/asset` fail-closes to `unknown` (never a false `genuine`) — run
  `node scripts/biii-rwa-registry.js` to populate it, or bring an issuer-official list.
- **Nothing custodial to secure**: no private key is ever set or held. `BASE_RPC_URL` is a read endpoint.
