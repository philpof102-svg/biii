# BIII × gitlawb — the brake gitlawb's escrow doesn't have

*Honest scope. Nothing here claims a partnership, an endorsement, or any relationship with gitlawb/Kevin — it
is a proposal + a runnable proof. Only capabilities that ship today (see README + `examples/gitlawb-agent-pays.js`).*

## The fit, in one line

**gitlawb** already has money: **bounties with escrow (5% fee)** and **delegated tasks**, with agents as
**DIDs** (`did:key`, Ed25519). What it does **not** have is a **counterparty trust layer** — nothing tells
the escrow holder whether the claimant they're about to release funds to is safe. The riskiest moment in any
escrow is the **release**. **BIII is that brake** — and a gitlawb agent already loads MCP servers
(`gl mcp serve` = 30+ tools), so the integration is **zero new code: add `biii-mcp` alongside `gl`.**

This is a *sharper* story than a chain with no payments: gitlawb isn't missing a rail, it's missing a brake.

```
gitlawb → version + escrow + bounties   (the git substrate + the RAIL, DID-signed)   ← Kevin
BIII    → safe-to-pay + receipt         (the BRAKE + the proof, non-custodial)        ← this
```

## The dangerous moment: releasing escrow to a bounty claimant

An agent claims bounty `glb:bounty/492`. The escrow is funded and about to release. Before it does, the
holder runs the BIII triangle on the claimant's resolved Base address — and a sanctioned claimant is
**BLOCKED before a cent moves**:

```
[1] IDENTITY  did:key:z6MkpTHR8VNsBx… ⇄ 0xabab…      bound: true   (did:key AND Base key both signed)
[3] TRUST     a sanctioned claimant  → BLOCK  (RELEASE BLOCKED)
              this claimant          → PROCEED_LOW_VALUE
[5] RECEIPT   paid=true  250.00 USDC  tx 0xffff…      re-verify on basescan
```

## What a gitlawb agent / escrow holder gets by loading biii-mcp (all shipped, all non-custodial)

| Need | BIII tool | What it does |
| --- | --- | --- |
| Resolve a gitlawb agent (`did:key`) → a payable Base address | `till_resolve` | bidirectional **did:key↔Base** attestation, trustless (the did AND the Base key sign) — same tool also resolves buzz npubs |
| Read who backs the claimant (identity) | `till_kya` | Skyfire KYA JWT, advisory, aud anti-replay, weak-posture surfaced |
| Is this claimant safe to release to? | `till_trust` / `till_vet_merchant` | known-bad floor (decisive, **no oracle** — holds if MainStreet is down) + score |
| Release the bounty | `till_create_charge` | an EIP-681 intent the **escrow's OWN wallet** executes |
| Prove the payout | `till_check_payment` / `till_receipt` | field-for-field on-chain verify, txHash-anchored receipt |
| Prove the judgment is decentralized | `till_floor` | content-fingerprint of the known-bad floor (same everywhere, verifiably — the same floor you can mirror to gitlawb) |

BIII holds **no key and releases no funds**. The escrow wallet signs; the chain — not us — says "paid". The
txHash-anchored receipt attaches **back to the bounty**, so *who was paid for this task, and can I re-verify
it on-chain?* lives in gitlawb's own signed history, next to the commits that closed it.

## The gitlawb-native bonus: the floor lives on gitlawb too

BIII's known-bad floor is content-addressed (`till_floor` → a sha256 fingerprint), published at
`github.com/philpof102-svg/biii-known-bad-floor` and **mirrorable to gitlawb** (`gl mirror`). So the *data*
behind the verdict is decentralized on the same substrate gitlawb runs on — anyone recomputes the hash and
refuses a tampered mirror (`verifyFloor`). The trust layer isn't a service you call; it's a floor you can hold.

## The proof (runnable, offline, no keys)

```bash
node examples/gitlawb-agent-pays.js
```

Runs the whole flow with the real BIII libs: resolve the claimant's `did:key` → its Base address, read its
KYA, **block a sanctioned claimant before release**, release a clean payout via EIP-681, verify + receipt,
attach it back to the bounty. Smoke-tested in CI (`test/examples.test.js`); full suite `npm test`.

## The ask

Two honest options for a first real deal:

1. **Pilot contract** — the white-label trust verdict + provable receipts as the pre-release check on
   gitlawb's escrow/bounty flow. From **$750/mo** (see PILOT.md / PRICING.md), non-custodial, 2-week integration.
2. **Partnership / integration** — BIII as the **recommended safe-to-pay MCP for gitlawb agents** (co-listed,
   integration docs, a joint demo, the floor mirrored to gitlawb). We stay the open trust layer; gitlawb stays
   the git+escrow substrate. No exclusivity, no custody, no money-transmitter surface on either side.

The wedge is the same: **gitlawb has the rail; the release needs a brake and a receipt — and nobody has built
that as the open, non-custodial layer. BIII has.**
