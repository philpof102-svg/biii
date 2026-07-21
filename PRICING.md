# BIII pricing — what the registry is worth, and how we sell the first contract

*Anchored to public comparables (researched 2026-07-21, see COMPETITION.md). Numbers are a
recommendation to start from and adjust after the first 3 pilots — not a claim of traction.*

## The one thing that sets the price: a verdict is JUDGMENT, not an API call

The market has a floor and a ceiling **4–5 orders of magnitude apart**, and where you sit is the
whole pricing decision:

| Layer | Public price | What it is |
| --- | --- | --- |
| Raw RPC / explorer call | ~$0.00001 (Alchemy) – $0.001 (Etherscan) | commodity data |
| **A trust decision** | **$0.20–$1.00** (sanctions screen), $0.45 (AMLBot/check), $1.35 (Sumsub) | **judgment** |
| Bundled custody + processing | 1.5% (Stripe stablecoin) | moving the money |
| Compliance middleware / yr | $15k (Elliptic) · $40k (TRM) · $175k avg (Chainalysis) | the enterprise seat |

BIII's verdict composes reputation (the **MainStreet** oracle, which flags known-bad wallets from OFAC +
scam lists — the list lives in MainStreet, BIII folds its BLOCK) + standing (LAWBOR) + on-chain
settlement. That is judgment. **Price it in the per-check corridor,
never like an RPC call.** The receipt is a brand-new category (no comparable) — pricing freedom.

## The model (three meters + a license)

| Meter | Price | Why |
| --- | --- | --- |
| **Trust verdict** (`till_trust` / preflight) | **$0.25** each | inside the $0.20–1.00 sanctions corridor, deliberately **under AMLBot's $0.45** to undercut, 250× above the RPC floor because it's judgment |
| **Provable receipt** (registry entry) | **$0.03** each | on-chain anchor costs cents → 90%+ margin; 10× below any per-check price → a no-brainer add-on that meters with real value (one defensible audit artifact each) |
| **White-label license** | **from $3,000/mo** ($36k/yr) | inside the compliance-middleware corridor ($15k–175k/yr), ~10× a plain SaaS tier because it is **revenue-enabling** for the partner (their brand, our verdicts + registry) |
| **bps framing** (enterprise cap, not metered) | **~2–5 bps** on verified flow | *"You pay Stripe ~150 bps to MOVE it; pay BIII a few bps to PROVE it was safe to move."* Non-custodial ⇒ we never claim the 150 bps; use bps only as the negotiation anchor, meter on verdicts/receipts (metering bps needs trusting their volume report) |

**Self-serve list:** Base **$300/mo** (2,000 verdicts + 1,000 receipts included), then $0.25/verdict
and $0.03/receipt over quota. Enterprise multi-year: **15–30% off** (industry norm) — so hold list
high enough to give that away.

## The first contract — the pilot that gets a signature

Copy Sardine's mechanism (a **minimum monthly commit drawn down against usage** — monetises
commitment, feels usage-based, no metering anxiety):

> **BIII Pilot — $750/mo, 3-month term.** Includes 5,000 trust verdicts / mo + **unlimited
> receipts**, the `till_trust` MCP verdict, and the provable till-roll. White-label optional.
> Framed publicly as **~60% off list**. Small enough a seed-stage fintech signs without
> procurement; big enough to prove the meter.

Why $750: it sits right in the Request-Finance SaaS band ($250–$1,250/mo) that crypto-B2B buyers
already sign for, and a 3-month pilot is $2,250 total — an expense-report number, not a
board decision. Land 3 of these, learn the real verdict volume, *then* set list from data.

## My honest read — does this make sense?

**Yes — and it's stronger today than yesterday, because the two things the registry composes now
actually work at first contact:**

1. **MainStreet BLOCKs known-bad wallets** (it silently returned "CAUTION — start with a small
   payment" for an OFAC-sanctioned Lazarus address until recently; now it BLOCKs — verified live today on
   that Lazarus/OFAC address). A partner's first test is *"what does it say about a scammer I know?"* — we
   now pass it. (The screening list is MainStreet's, not BIII's; confirm the oracle is up before a demo.)
2. **LAWBOR's remote operator-takeover is closed** (a stranger could impersonate the operator on the
   live node; fixed + deployed + verified). The "proven paid" standing can't be forged.

That is the precondition for charging anything: **the product has to survive the first sceptical
test.** It now does. The moat (non-custodial trust registry, composed verdict + provable books,
across in-person + invoice + agent-to-agent) is real and un-crowded. The risk isn't the price —
it's distribution, which is exactly why the model is **white-label to whoever already has the
merchants.** Set the pilot low to land logos, price the license where the value is, and let the
per-verdict/per-receipt meters grow with the partner.

*Caveat (anti-hype): Chainalysis/TRM/Elliptic/Sardine/Alloy figures are buyer-side or third-party
reports; Stripe 1.5%, Request Finance tiers, Etherscan/Alchemy, and AMLBot $0.45 are first-party
public prices. Re-validate before any investor- or partner-facing quote.*
