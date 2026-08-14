# BIII

> Safe-to-pay verdicts on Base, with the evidence attached: **28 tools**, **55 modules**,
> **127 test files**, **54 probes** that publish their own bounds. Non-custodial, descriptor-only,
> every verdict re-verifiable on-chain.

**Spoken "B3". Written BIII — a B with three bars.**
The real-world USDC till on Base: an independent merchant accepts USDC in person with just a
phone. Non-custodial (their own wallet), no terminal, no PSP, no KYB middleman.

`B` = Base · `3` = phase three of the trilogy, and Base's three pillars.

---

## The gap (researched, not assumed — 2026-07-21)

Accepting USDC on Base is solved for the *online enterprise* and unsolved for the *real-world
independent*:

| What exists | Why it isn't this |
| --- | --- |
| **Base Pay** (Coinbase) | online-checkout only — a browser `pay()` SDK; no in-person, no QR, nothing without a website |
| **Lyzi** | PSP + physical terminals (Ingenico/Verifone), enterprise clients, via payment providers |
| **Flexa + Base Pay** | in-person, but you must be a Flexa-network merchant |
| **BitPay / Binance Pay / Eco** | custodial processors — KYB, fees, they hold the funds |
| **Shopify POS + USDC** | requires Shopify |
| raw address + QR (DIY) | no UX, no confirmation, no receipt, technical |

Nobody serves the café, the market stall, the plumber, the freelancer who wants to take USDC
on Base with **just a phone**, keep the funds in **their own wallet**, and hand over a real
receipt — in two minutes, with no account to open.

*(Landscape verified on the date above; re-check before any public claim. We build compatible
with Base/Coinbase/Flexa/Lyzi and claim no partnership.)*

## The trilogy — phase 3: the agentic economy pays real-world humans

```
MainStreet   →  WHO is safe to pay            (the reputation oracle)
LAWBOR       →  agent ↔ agent, outcomes PROVEN paid in USDC on Base
BIII         →  agents & humans  →  REAL-WORLD merchants     ← this
```

BIII is the bridge between the on-chain agent economy and the shopkeeper on the corner. The
same "safe to pay" and "proven paid by a real USDC transfer" discipline, pointed at a till.

## How it works

1. Merchant types an amount. → a **charge** (data only; the merchant's own address).
2. BIII shows a **universal QR** — an [EIP-681](https://eips.ethereum.org/EIPS/eip-681) payment
   URI that every major wallet scans (Base App, Coinbase Wallet, MetaMask, Rainbow…).
3. The customer (or an **AI agent**) pays USDC on Base from their own wallet.
4. BIII watches the chain and **verifies the transfer field-for-field** — wrong
   token / chain / recipient / underpaid / unconfirmed ⇒ **not paid, ever**. Overpay is a tip.
5. Both sides get a **receipt anchored to the txHash** (refutable by anyone on Basescan).

**BIII holds no key and moves no funds.** It mints intents and reads the chain; the customer's
wallet signs, and the chain — not us — is the only thing allowed to say "paid".

## Run it

```bash
npm test                               # all offline; 1269 assertions across 96 files + a 22-case eval harness (2026-08-05)
node test/suite-total.js               # re-derives that count — two report formats coexist, so grep undercounts it
BIII_MERCHANT=0x<your address> npm run serve   # the non-custodial HTTP surface, :4700
```

- `lib/till.js` — pure core: money math, charges, EIP-681 URIs, verification, receipts
- `lib/chain.js` — read-only Base watcher (finds the paying transfer; never invents)
- `lib/server.js` — thin HTTP: `/charge`, `/status`, `/receipt`, **`/trust`** (the LOCAL safe-to-pay
  verdict as ONE `fetch()` — known-bad screen + this node's trust-core classifier + floor provenance,
  fail-closed, CORS-open: any web app embeds a pre-payment check with no MCP; shares `lib/vet.js` with the
  MCP tool so the two surfaces cannot drift), **`/asset`** (tokenized-asset authenticity as one fetch —
  `genuine`/`impersonation`/`unsafe`/`unknown`, fail-closed: a non-registry token is never a false
  `genuine`; a pre-trade check any page embeds and re-verifies on-chain)
- `lib/trust.js` — **the trust triangle**: composes reputation (MainStreet) + standing (LAWBOR) +
  settlement (chain) into one fail-closed verdict (`unsafe`/`unknown`/`trusted`/`settled`)
- `lib/invoice.js` — **the same registry for Web2-style invoices**: number, line items (exact micro
  math), due date, bill-to — paid by the same EIP-681, verified by the same chain discipline,
  settled/overdue lifecycle, and its receipt lands in the SAME provable till roll as a café sale
- `lib/asset.js` — **the same registry for TOKENIZED ASSETS** (stocks / treasuries / RWA): is a token
  contract the *genuine* issuer's or an impersonator? `genuine` / `impersonation` / `unsafe` / `unknown`,
  fail-closed — catches the FBI-flagged lookalike-token fraud, and composes into the trust triangle
  (`till_vet_asset`).
- **Issuer-verified registry (`data/issuer-verified.json`, committed, multi-chain)** — the AUTHORITATIVE,
  no-key, commercial-safe layer that earns the strong **green "issuer-verified"** badge. **183 entries across
  11 chains** (counted 2026-08-05 by `hermes/economy/probe-readme-claims.js`, which reads the registry rather
  than this sentence), all from ISSUER-DIRECT sources: **Dinari dShares** (54, Base — enumerated on-chain from
  the factory's `DShareAdded` event, each re-verified via `symbol()`/`name()`; `scripts/biii-rwa-issuer-direct.js`),
  **Backed / xStocks** (100 across Ethereum/Optimism/BSC/XLayer/Mantle/Arbitrum/Ink from Backed's own public API
  `api.backed.fi`, no key, plus 12 on Base from `backed-fi/tokenlists`; `scripts/biii-issuer-backed.js`),
  **Ondo** (9 OUSG/USDY/rUSDY — official docs, each on-chain-verified), and 8 single-issuer entries on Base
  (Circle USDC/EURC, Coinbase cbBTC/cbETH, Franklin Templeton BENJI, Lido, Aerodrome).
  `lib/asset-registry` merges this over the aggregator by address, so a verified
  address reads `provenance: issuer-official` (green) while everything else stays aggregator-teal.
- `scripts/biii-rwa-registry.js` — builds the AGGREGATOR fallback (the teal "listed" layer). **Coingecko's
  free tier** (no key) → `data/rwa-registry.json`, `generatedFrom: "coingecko (free)"`. Coingecko is an
  AGGREGATOR, so a match here is `provenance: aggregator` (teal "listed"), never the issuer-verified green —
  and the cross-check (`scripts/biii-issuer-registry.js`) flags any symbol the aggregator lists at a
  *different* address than the issuer-official one (potential lookalike). **Fail-safe:** every entry must
  validate (0x-40hex · integer chainId · symbol) or it's dropped — a schema drift yields an EMPTY registry,
  never a wrong "genuine" address.
- `lib/export.js` — **the accounting export finance teams need**: `till_export` turns the same verified
  receipts into an accountant-ready CSV (QuickBooks / Xero / Excel import it) where every row carries its
  txHash + Basescan link — a pointer to the chain, not a book to trust. Non-custodial, re-verifiable.
- `lib/meter.js` — **the usage→bill mechanic for a white-label pilot**: `till_meter` turns a month's
  receipts into a bill against an injected plan, split by trust — settled receipts are ON-CHAIN (provable),
  the verdict count is SELF-REPORTED (advisory) and labeled as such. Pure, stateless, non-custodial.
- `lib/erc8004.js` — **interop with the dominant agent-reputation standard** (ERC-8004): turns a
  `ReputationRegistry.getSummary` result into a SEPARATE, advisory, re-verifiable lens on `till_trust`.
  Feedback is client-submitted (sybil-farmable), so it never enters the payable decision — it informs, keeps
  the sybil caveat unless filtered to trusted clients, and always points to re-verify getSummary on Base.
- **Decentralization is checkable, not claimed** — the known-bad floor carries a content **fingerprint**
  (`floorFingerprint` / `till_floor`): two nodes with the same fingerprint judge on the *same* objective
  floor, re-derivable from named public MIT lists, so convergence is on **public data + a deterministic
  hash, never on a central operator**. The classifier is replicated (pure `trust-core`), the floor
  converges on public data, and relative reputation stays deliberately local — divergence, where it exists,
  is always fail-closed (a node with less data is *more* cautious, never more permissive).
- `lib/identity.js` — **the agent glue: npub AND/OR did:key ↔ Base**, trustless. Resolves a buzz/Nostr
  identity (secp256k1 npub) **or a gitlawb identity (Ed25519 `did:key`)** — or both — to a payable,
  trust-assessable Base address via a **bidirectional attestation** (each identity key present signs, and the
  Base key signs, the same canonical message; anyone re-verifies). Fail-closed: unverified / an identity key
  missing its signature / no identity key / expired ⇒ a claim, not a binding. Resolving is not trusting —
  you still run the triangle on the address.
- `lib/skyfire.js` — **interop with Skyfire** (Experian's agent-identity layer): (1) a KYA JWT lens — who
  backs an agent (advisory, aud anti-replay, weak posture surfaced: a no-`exp` or non-audience-bound token is
  flagged, strict callers refuse with `requireExpiry`); (2) `authorizeCharge` — the **Programmable Payment**:
  a charge only becomes an executable EIP-681 intent if it's inside what the agent's OWNER signed off —
  token, recipient allow-list, per-charge max, AND the **cumulative cap** (drain-safe: ten small charges
  can't beat a low cap; a malformed or absent limit is REFUSED, never treated as "no limit"). Both
  fail-closed; BIII does not verify JWT signatures itself (delegated, no dep).
- `bin/biii-mcp.js` — **the agentic bridge**: an MCP any agent loads (**28 tools**, listed from the source
  on 2026-08-05: `till_authorize`, `till_check_invoice`, `till_check_payment`, `till_create_charge`,
  `till_create_invoice`, `till_export`, `till_floor`, `till_funder_history`, `till_key_exposure`, `till_kya`,
  `till_launch_funder`, `till_meter`, `till_open_approvals`, `till_receipt`, `till_recovery_offer`,
  `till_resolve`, `till_roll`, `till_rug_powers`, `till_seed_exposure`, `till_trace_theft`, `till_trust`,
  `till_verify_delivery`, `till_vet_agent`, `till_vet_approach`, `till_vet_asset`, `till_vet_meme`,
  `till_vet_merchant`, `till_watch_wallet`) — an agent can vet a merchant or a tokenized
  asset, get the whole trust triangle in one call, issue or pay an invoice, keep a receipt, export the books,
  meter usage, prove its floor, resolve a buzz npub or a gitlawb did:key to a Base address, read a KYA
  identity, spend only within a signed authorization, and render provable books (`till_roll`)
- `pitch/trust-triangle.html` — the sellable white-label one-pager (self-contained, theme-aware)
- `COMPETITION.md` — the researched landscape (dated): ride the rails (x402/Stripe), interop with the
  standards (ERC-8004/Skyfire KYA), never custodial — the open layer is the non-custodial trust registry
- `INTEGRATION-buzz.md` / `INTEGRATION-gitlawb.md` — honest partnership briefs, each with a **runnable
  offline proof** (`examples/buzz-agent-pays.js`, `examples/gitlawb-agent-pays.js` — smoke-tested in CI so
  the demos can't rot): a keypair agent resolves→Base, a sanctioned counterparty is BLOCKED, a clean payment
  settles with a txHash-anchored receipt
- `web/` — the merchant phone app (PWA): amount → QR → **PAID ✓** → receipt

## Business model — the trust+bridge layer partners resell

BIII is not (only) an app to grow one merchant at a time. It's a **white-label trust + bridge
layer** that companies **who already have the merchants** plug in:

> They bring the clientele. BIII brings the trusted USDC payment + the human/agent bridge +
> the provable receipts. Sold to PSPs, neobanks, merchant platforms, Base ecosystem apps.

The one-pager for that conversation — **the trust triangle**, the four verdict states, the
white-label split, the receipt, and the honest landscape — is `pitch/trust-triangle.html`
(self-contained, theme-aware, no external requests).

Lyzi is white-label for PSPs but terminal/enterprise and human-only. BIII is white-label too —
and it's the one that also lets **AI agents pay**, ships **un-fakeable consumer receipts**, and
runs **non-custodially** (the partner never touches the merchant's funds, so no money-transmitter
custody to license). That combination is the wedge.

*Stance: genuinely open to partners with distribution. We build compatible with
Base/Coinbase/Flexa/Lyzi and claim no partnership until one is signed (anti-hype).*

## Trust roadmap — make BOTH sides safe

- **Now:** the payer is protected by field-for-field on-chain verification; the merchant can be
  vetted via MainStreet's "safe to pay" reputation (`till_vet_merchant`), advisory.
- **Next (ZK):** privacy-preserving attestations so each side proves what matters without
  doxxing — "this merchant is verified", "this payer is reputable / has funds" — as a
  zero-knowledge badge, not a data dump. The receipt already proves the *payment*; ZK proves
  the *parties*. (Design tracked; not built yet — no ZK claims until it ships.)

## The receipt & the books (the human layer)

`lib/ledger.js` turns a payment into a **paper-ticket a non-crypto human instantly reads**
(merchant, `B3-####`, item, amount, tip, ✓ PAID, a verify link) and a **provable day roll** for
the merchant — every line re-checkable on-chain, one txHash counted once, books that can't be
padded. Nobody offers this for in-person USDC today; it's the trust made legible.

## Non-negotiables

Non-custodial by construction · descriptor-only (never signs, never custodies) · the chain is
the only source of truth for "paid" · every receipt re-verifiable by anyone · real numbers
only, no invented usage or partnerships.
