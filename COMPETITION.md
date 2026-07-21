# Competitive landscape — where BIII's registry wins

*Researched 2026-07-21. Real players, real facts, dated. Re-check before any public claim.
No traction is claimed for BIII here — this is a **capability** map, not a scoreboard.*

## TL;DR — the shape of the market

Three layers are already crowded and giant-backed; **one is open.**

| Layer | Who owns it | BIII's move |
| --- | --- | --- |
| **Rails** (move the money) | x402 (Coinbase/Google/Visa/Circle/Anthropic), Stripe+Bridge | **Ride them, don't compete** |
| **Invoicing + accounting** (bill + book) | Request Finance, Stripe | **Export to them, sit under them** |
| **Agent identity + reputation** (who is the agent) | ERC-8004, Skyfire KYA | **Interoperate as signal sources** |
| **Non-custodial TRUST REGISTRY** (safe-to-pay verdict + provable books, any surface) | *nobody, cohesively* | **← this is BIII** |

## The players (by cluster)

### 1. Rails — money movement (commoditized, giant-backed)
- **x402** — Coinbase + Cloudflare, x402 Foundation members include Google, Visa, AWS, Circle,
  Anthropic, Vercel, Fireblocks. HTTP-402: an agent hits a paywall, signs a stablecoin tx, retries.
  The default agentic rail. It **moves money** — it says nothing about "safe to pay" and keeps no books.
- **Stripe + Bridge** (~$1.1B acquisition, 2024) — one API accepts USDC, settles USD/USDC at a flat
  1.5%, 70+ countries, $5B+ stablecoin volume in six months. Online-checkout + cross-border B2B.
  Custodial payout rails.

→ **BIII stance:** not a rail. A BIII charge/invoice is paid over **EIP-681** today. Because verification
only reads the resulting on-chain USDC transfer, an x402-settled transfer would verify the same way — but
there is **no x402-specific integration in the code yet**. BIII contributes the **verdict + the receipt the
rail lacks**.

### 2. Invoicing + accounting (mature — but centralized books you must trust)
- **Request Finance** — "Bill.com for crypto": AP / AR / expenses / payroll under one login. Invoices on
  the Request Network; USDC/USDT/DAI/EURC across Ethereum, Polygon, Arbitrum, Optimism, Base, Gnosis.
  Email + PDF + hosted pay page → records tx hash, marks paid, receipt PDF, **journal entry pushed to
  QuickBooks / Xero**. Known gap: no native cross-chain routing (USDC-Polygon → USDC-Arbitrum).
- **Stripe Invoicing** — the same loop at Web2 scale, with fiat and now stablecoin settlement.

→ **BIII stance:** **don't rebuild the invoice UI / accounting suite** — Request is years ahead and Stripe
has infinite resources. But their books are *their* centralized record you must trust. BIII's registry is
**non-custodial and re-checkable on-chain by anyone** (a fixed-width receipt + a re-verifiable day-roll).
A QuickBooks/Xero export is **not built yet** — it's on the roadmap (see below), and without it finance
teams won't fully adopt. Sit *under* their invoice or *beside* it as the provable trust layer.

### 3. Agent identity + reputation (the new standards — INTEROPERATE, never rival)
- **ERC-8004 "Trustless Agents"** — ratified Jan 2026, live on Ethereum mainnet Feb 2026. Three registries:
  **Identity** (ERC-721 agent ID), **Reputation** (feedback / scores / performance tags *before* a
  transaction), **Validation** (proof-of-task: zkML, TEE oracles, staked re-execution). 45,000+ agents in
  month one; 50+ orgs incl. MetaMask, Ethereum Foundation, Google, Coinbase. **This is the
  reputation-before-payment standard.**
- **Skyfire KYA** ("Know Your Agent") — a signed-JWT identity binding a real human/business to an agent;
  **now the identity layer for Experian's KYA framework**; raised $9.5M (a16z CSX, Coinbase Ventures).
  A separate "Programmable Payment" JWT carries an authorized USDC spend.
- **Payman AI** — $13.8M (Visa, Coinbase Ventures); agent-driven transactions for financial institutions.

→ **BIII stance:** **do not build a rival trust standard** — ERC-8004 + KYA won that with EF / Google /
Coinbase / Experian behind them. **Read them as signal sources** into BIII's reputation & standing vertices
(an `assessTriangle` corner can be wired to any oracle). BIII's value-add is exactly what they *don't* do:
**compose identity+reputation WITH real on-chain settlement into a payment decision**, and keep the
**provable receipt + books** for the commerce that follows.

### 4. Merchant orchestration / POS (mostly custodial, network-bound)
- **Helio** ($1.5B+ processed, Shopify, Solana/BTC/ETH/L2s, card→stablecoin via Onramper), **Mesh**
  (300+ wallets, 120+ tokens, 24+ chains, settle USDC/PYUSD/USDT/RLUSD/fiat), **Sphere** (cross-border,
  settles <30 min, 160 markets), **Coinbase Commerce / BitPay** (online processors). POS stablecoin exists
  for big brands (Ferrari, restaurant chains) — but through processors.

→ **BIII stance:** they route/settle, usually **custodial**, often tied to Shopify or a network. BIII is the
**non-custodial** trust + registry on top: the merchant keeps their own wallet, joins no network.

### 5. On-chain reconciliation (the adjacent idea, but enterprise + not a primitive)
- **Chainscore Labs** and similar pitch "on-chain reconciliation" / "invoice-payment reconciliation
  engines" — record invoices, approvals, settlements on a shared immutable ledger, 60–80% reconciliation
  savings, near-instant close. Real, but **enterprise B2B infra**, not an embeddable non-custodial primitive
  a corner café or an AI agent can use in two minutes.

## Mistakes to avoid (already paid for by the competitors)

1. **Don't be the rail or the standard.** x402/Stripe (rails) and ERC-8004/KYA (identity) are won by
   giants. **Ride and interoperate.** The moat is the composing **judgment** + the **provable registry**,
   never the pipe.
2. **Don't go custodial.** It is the incumbents' model *and* their regulatory anchor (money-transmitter /
   PSP licensing). Non-custodial is both the product wedge and the licensing shortcut.
3. **Don't skip accounting export.** Request/Stripe win partly because they push journal entries to
   QuickBooks/Xero. The bon-de-caisse must export too, or finance teams won't adopt it.
4. **Don't serve a single surface.** The winners span invoice + checkout + payroll. BIII's registry must
   span **in-person + Web2 invoice + agent-to-agent** — one registry, one trust triangle. *(Phil's insight,
   2026-07-21.)*
5. **Reputation-before-payment is now table stakes** (ERC-8004 reputation registry, Skyfire KYA). BIII's
   "safe to pay" must be **real and interoperable**, not a walled garden.

## Where BIII wins (the one-line moat)

> Everyone else is a **rail** (commoditized), a **custodial book** (you trust them), or an **identity
> standard** (who the agent is). BIII is the **non-custodial trust registry**: it composes *safe-to-pay*
> from every available signal — MainStreet, LAWBOR, and, by interop, ERC-8004 & KYA — **and** writes an
> **un-fakeable, on-chain-provable ledger**. The **same registry** serves a café, a Web2 invoice, or an
> agent paying an agent. Sold **white-label** to whoever already has the merchants.

---

*Sources (2026-07-21): eco.com support library; requestfinance.com; coindesk.com &
forbes.com (ERC-8004 mainnet); eips.ethereum.org/EIPS/eip-8004; docs.skyfire.xyz & skyfire.xyz (KYA);
aws.amazon.com (x402); vaasblock.com & stablecoininsider.org (Stripe/Bridge/BVNK); onramper.com (Helio);
spherepay.co; chainscorelabs.com (on-chain reconciliation). Facts summarized from public pages; verify
before any public or investor-facing claim.*
