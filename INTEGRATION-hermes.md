# BIII × Hermes Agent — the verdict layer the blockchain skills don't have

*Honest scope: a proposal + a working skill, no claim of affiliation with Nous Research. Everything here
ships today — the tools are BIII's (`bin/biii-mcp.js`), the skill is `hermes/skills/base-token-trust/`.*

## The fit, in one line

**Hermes Agent** (Nous Research, MIT — `github.com/NousResearch/hermes-agent`) has official skills that
**read** Base/EVM chains (portfolio, token info, whales, gas). None of them **judge**: the entire official
blockchain catalog is data-retrieval, with **no skill for token authenticity, scam/look-alike detection, or
a safe-to-pay verdict**. HOODRADAR (a Robinhood-Chain Hermes skill) bolts on a *heuristic* honeypot filter —
nobody ships a **verifiable** trust verdict.

That verdict is exactly what BIII is. So a "Hermes on Base" doesn't need a new data reader — it needs the
**boost**: BIII as the pre-flight trust check before an agent buys, swaps, or pays.

```
Hermes Base/EVM skill   → READ the chain            (data)          ← Nous Research
BIII base-token-trust    → JUDGE it: safe-to-pay + is-this-genuine   ← this (the missing verdict)
```

## What the skill does (`hermes/skills/base-token-trust/SKILL.md`)

Auto-triggers before any payment/swap/"buy the dip", and whenever a token claims to be a known asset
(the #1 tokenized-asset fraud is a look-alike of a real issuer). It calls the `biii` tools:

- **`till_vet_asset`** → `genuine (issuer-official)` / `genuine (aggregator)` / `impersonation` / `unsafe` /
  `unknown`. Backed by **147 on-chain-verified issuer-official contracts across 9 chains** (Dinari dShares
  enumerated from the on-chain factory · Backed/xStocks from their own public API · Ondo from official docs,
  each re-verified on-chain). A look-alike of a real dShare/USDY/OUSG is caught as `impersonation`.
- **`till_vet_merchant` / `till_trust`** → is the counterparty wallet known-bad (OFAC / scam floor, decisive,
  no oracle needed)? Fail-closed.
- **`till_create_charge` → `till_check_payment` → `till_receipt`** → the optional pre-flight→pay→prove loop:
  the user's own wallet executes an EIP-681 intent (BIII signs nothing), verified field-for-field, receipt
  anchored to the txHash.

Every verdict is **fail-closed, non-custodial, and re-verifiable on-chain** — the skill reports the pointer,
never asks to be trusted.

## Wire it in (two lines of config)

1. Add the `base-token-trust` skill folder under `~/.hermes/skills/blockchain/` (or point
   `config.yaml → skills.external_dirs` at this repo's `hermes/skills`).
2. Add the `mcp_servers.biii` block from `hermes/config-snippet.yaml` to `~/.hermes/config.yaml` (local
   stdio `node bin/biii-mcp.js`, no key — or a hosted HTTP `/mcp`).

That's it. The agent now checks token authenticity + safe-to-pay before it acts. Skills follow the open
`agentskills.io` standard, so the same `SKILL.md` also works in Claude Code.

## Why this beats a heuristic honeypot filter (the HOODRADAR gap)

A honeypot filter guesses from bytecode/behaviour. BIII gives a **verifiable** answer for the case that
matters most on Base right now — tokenized stocks/RWA look-alikes — by matching the contract against the
**issuer's own published address** (on-chain factory / official API), and falls back to a fail-closed
`unknown` (never a false "genuine") for everything else. It composes *in front of* the existing x402 payment
skills (which gate on budget/approval, not counterparty authenticity) as the missing pre-flight check.

## The ask

Ship `base-token-trust` on `agentskills.io` / `hermesatlas.com` / `awesome-hermes-agent` as the Base trust
skill, and (if you're building a HOODRADAR-style Base radar) fork its skeleton but **replace the heuristic
honeypot filter with these verifiable verdicts**. No custody, no key, no money-transmitter surface — just the
judgment layer the ecosystem is missing.
