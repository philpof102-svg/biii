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
npm test                               # 14/14, fully offline
BIII_MERCHANT=0x<your address> npm run serve   # the non-custodial HTTP surface, :4700
```

- `lib/till.js` — pure core: money math, charges, EIP-681 URIs, verification, receipts
- `lib/chain.js` — read-only Base watcher (finds the paying transfer; never invents)
- `lib/server.js` — thin HTTP: `/charge`, `/status`, `/receipt`
- `bin/biii-mcp.js` — **the agentic bridge**: an MCP any agent loads (`till_vet_merchant`,
  `till_create_charge`, `till_check_payment`, `till_receipt`) — an agent can vet a merchant,
  pay in USDC with its own wallet, and keep a receipt
- `web/` — the merchant phone app (PWA): amount → QR → **PAID ✓** → receipt

## Non-negotiables

Non-custodial by construction · descriptor-only (never signs, never custodies) · the chain is
the only source of truth for "paid" · real numbers only, no invented usage or partnerships.
