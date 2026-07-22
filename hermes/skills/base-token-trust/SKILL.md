---
name: base-token-trust
description: Before you act on or pay a token/wallet on Base (or any EVM chain), get a VERIFIABLE trust verdict — is this contract the genuine issuer's or a look-alike? is this address known-bad? — instead of guessing. Fail-closed, non-custodial, re-verifiable on-chain. Use it as the pre-flight check before a buy, a swap, a payment, or before trusting a token a user pasted.
version: 0.1.0
platforms: [desktop, cli, portal]
metadata:
  hermes:
    tags: [base, evm, trust, safety, tokenized-assets, rwa, anti-scam, safe-to-pay, x402]
    category: blockchain
    requires_toolsets: [biii]
    fallback_for_toolsets: []
required_environment_variables: []
---

# Base token-trust — the verdict layer the blockchain skills don't have

The official Base / EVM skills READ the chain (portfolio, token info, whales, gas). None of them
**judge** it. This skill adds the missing piece: a fail-closed *safe-to-pay* + *is-this-token-genuine*
verdict, powered by the **BIII** tools (toolset `biii`). It never moves funds and holds no key — every
verdict points back to the chain so you (or the user) can re-verify it yourself.

Use it whenever you are about to **act on a token or an address on Base**: a buy/swap, a payment, an
x402 charge, or when a user pastes a contract/wallet and asks "is this real / safe?".

## When to run (auto-trigger)
- Before ANY payment, swap, or "buy the dip" on a token you did not mint yourself.
- When a token claims to be a known asset (e.g. "AAPL", "USDY", "TSLA", a treasury/RWA) — look-alikes
  of tokenized stocks/RWA are the #1 fraud (FBI-flagged). Verify the CONTRACT, not the ticker.
- Before releasing an escrow / paying a counterparty wallet.
- Any time confidence matters more than speed.

## Procedure

### A) Is this TOKEN contract genuine, or a look-alike?
Call the `biii` tool **`till_vet_asset`** with the token's contract `address` (and, if the user or a
listing claims an issuer/symbol, pass `claimedIssuer` / `claimedSymbol` so impersonation is caught).

Read the verdict:
- **`genuine` + `provenance: issuer-official`** → the strong result: the contract matches the ISSUER'S
  OWN address (Dinari on-chain factory / Backed API / Ondo docs; 147 verified contracts, 9 chains).
  Report **"✓ issuer-verified (<issuer>)"**.
- **`genuine` + `provenance: aggregator`** → matches an aggregator listing (Coingecko), weaker.
  Report **"~ listed (aggregator — not issuer-verified)"** and tell the user to re-check on-chain.
- **`impersonation`** → 🚨 the dangerous case: the contract is NOT the claimed issuer's (a look-alike).
  Report **"✗ IMPERSONATION — do NOT acquire"** and, if given, name the genuine address it points to.
- **`unsafe`** → the contract is denylisted. **"✗ unsafe (denylisted)"**.
- **`unknown`** → not in any verified registry. **"? unknown — unverified; never assume genuine"**.

NEVER upgrade `unknown`/`aggregator` to "safe" — absence of proof is not proof.

### B) Is this ADDRESS safe to pay / interact with?
Call **`till_vet_merchant`** (or `till_trust` for the full triangle) with the counterparty `address`.
- A **known-bad** hit (OFAC / scam floor) → **"✗ BLOCKED — do not pay"** (decisive, no oracle needed).
- Not-on-floor → **"~ not known-bad (NOT a clean bill — no behavioral score)"**. Stay cautious.
- If the caller has a resource/endpoint URL, pass `resourceUrl` so a hostile endpoint is flagged too.

### C) (optional) Pay with a receipt
If, after A+B, the user wants to pay: use `till_create_charge` → the user's own wallet executes the
EIP-681 intent (BIII signs nothing) → `till_check_payment` verifies it field-for-field → `till_receipt`
gives a txHash-anchored, re-verifiable receipt. This is the pre-flight → pay → prove loop.

## How to report (a tight brief, not a wall of text)
Lead with the verdict emoji + one line, then the evidence, then the re-verify pointer. Example:

> 🚨 **IMPERSONATION** — `0xFAKE…` claims to be Ondo USDY but is not Ondo's contract.
> Genuine Ondo USDY (Ethereum): `0x96F6eF95…`. Re-verify on Basescan/Etherscan.
> (verdict: BIII till_vet_asset · fail-closed · non-custodial)

Or:

> ✓ **issuer-verified** — `0x41f7a6…` is Dinari's dAAPL on Base (on-chain factory-enumerated).
> Counterparty wallet: ~ not known-bad (no clean bill). Safe to proceed at low value.

## Hard rules (from BIII)
- **Non-custodial**: you never hold a key or move funds. The chain is the only thing that says "paid".
- **Fail-closed**: unknown / error / missing data → the CAUTIOUS answer, never the permissive one.
- **Re-verifiable**: every verdict is a pointer to on-chain data — say so; don't ask to be trusted.
- Verifying a token/address is NOT a recommendation to buy or pay — it removes a specific risk, nothing more.
