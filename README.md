# BIII

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
npm test                               # 148 assertions across 23 files + a 17-case eval harness, all offline
BIII_MERCHANT=0x<your address> npm run serve   # the non-custodial HTTP surface, :4700
```

- `lib/till.js` — pure core: money math, charges, EIP-681 URIs, verification, receipts
- `lib/chain.js` — read-only Base watcher (finds the paying transfer; never invents)
- `lib/server.js` — thin HTTP: `/charge`, `/status`, `/receipt`
- `lib/trust.js` — **the trust triangle**: composes reputation (MainStreet) + standing (LAWBOR) +
  settlement (chain) into one fail-closed verdict (`unsafe`/`unknown`/`trusted`/`settled`)
- `lib/invoice.js` — **the same registry for Web2-style invoices**: number, line items (exact micro
  math), due date, bill-to — paid by the same EIP-681, verified by the same chain discipline,
  settled/overdue lifecycle, and its receipt lands in the SAME provable till roll as a café sale
- `lib/asset.js` — **the same registry for TOKENIZED ASSETS** (stocks / treasuries / RWA): is a token
  contract the *genuine* issuer's or an impersonator? `genuine` / `impersonation` / `unsafe` / `unknown`,
  fail-closed — catches the FBI-flagged lookalike-token fraud, and composes into the trust triangle
  (`till_vet_asset`).
- `scripts/biii-rwa-registry.js` — builds the verified-issuer registry. **Shipped default: Coingecko's
  free tier** (no key) — the committed `data/rwa-registry.json` is `generatedFrom: "coingecko (free)"`
  (620 entries). Coingecko is an AGGREGATOR, so treat a `genuine` verdict as aggregator-sourced, not
  issuer-authoritative. **Optional authoritative source:** set `RWA_XYZ_API_KEY` to switch to RWA.xyz
  (`/v4/tokens` ⋈ `/v4/assets`, Bearer-auth) — a key-gated path that exists but is not the default and did
  not produce the shipped data. **Fail-safe:** every entry must validate (0x-40hex · integer chainId ·
  symbol · wanted chain) or it's dropped — a schema drift yields an EMPTY registry, never a wrong "genuine"
  address. **In progress:** issuer-official / on-chain sourcing (Dinari factory + Backed tokenlist) to make
  a `genuine` verdict authoritative rather than aggregator-sourced.
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
- `bin/biii-mcp.js` — **the agentic bridge**: an MCP any agent loads (12 tools: `till_vet_merchant`,
  `till_create_charge`, `till_check_payment`, `till_trust`, `till_create_invoice`,
  `till_check_invoice`, `till_vet_asset`, `till_receipt`, `till_roll`, `till_export`, `till_meter`,
  `till_floor`) — an agent can vet a merchant or a tokenized asset, get the whole trust triangle in one
  call, issue or pay an invoice, keep a receipt, export the books, meter usage, prove its floor, and
  render provable books (`till_roll`)
- `pitch/trust-triangle.html` — the sellable white-label one-pager (self-contained, theme-aware)
- `COMPETITION.md` — the researched landscape (dated): ride the rails (x402/Stripe), interop with the
  standards (ERC-8004/Skyfire KYA), never custodial — the open layer is the non-custodial trust registry
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
