# BIII × buzz — the payment + trust layer buzz doesn't have

*Honest scope. Nothing here claims a partnership, an endorsement, or any relationship with Block/buzz — it
is a proposal + a runnable proof. Only capabilities that ship today (see README + `examples/buzz-agent-pays.js`).*

## The fit, in one line

**buzz** (Block) is a sovereign workspace where humans and agents are keypairs on a relay you own. It has
git, chat, workflows, and agents-as-members — but **no payment layer, and no counterparty reputation** (its
own NIP-IA deliberately avoids global reputation state). **BIII is exactly that missing layer**, and a buzz
agent already loads MCP servers, so the integration is **zero new code for buzz: add `biii-mcp`.**

```
buzz    → collaborate            (the room; agents as keypairs)     ← Block
gitlawb → version, sovereign     (the git substrate, DID-signed)    ← open
BIII    → transact WITH TRUST    (safe-to-pay + receipt, non-custodial)  ← this
```

## What a buzz agent gets by loading biii-mcp (all shipped, all non-custodial)

| Need | BIII tool | What it does |
| --- | --- | --- |
| Resolve a Nostr agent → a payable Base address | `till_resolve` | bidirectional npub↔Base attestation, trustless (both keys sign) |
| Read who backs an agent (identity) | `till_kya` | Skyfire KYA JWT, advisory, aud anti-replay |
| Read an agent's on-chain reputation | `till_trust` (+ ERC-8004 lens) | the trust triangle + the standards, fail-closed |
| Is this counterparty safe to pay? | `till_trust` / `till_vet_merchant` | known-bad floor (decisive, no oracle) + score |
| Pay a real merchant / another agent | `till_create_charge` | an EIP-681 intent the agent's OWN wallet executes |
| Prove the payment | `till_check_payment` / `till_receipt` | field-for-field on-chain verify, txHash-anchored receipt |
| Keep books / bill / export | `till_roll` / `till_meter` / `till_export` | provable statement, usage→bill, accountant CSV |
| Prove the judgment is decentralized | `till_floor` | content-fingerprint of the known-bad floor (same everywhere, verifiably) |

BIII holds **no key and moves no funds**. The agent's own wallet signs; the chain — not us — says "paid".
Every verdict and receipt is re-verifiable on Base. The receipt can be posted **back to buzz as a signed
event** (`kind: biii-payment-receipt`), so the payment lands in the same auditable log as the patch, the
review, and the merge — *why the code exists* **and** *who paid whom for it*, in one signed record.

## buzz's OWN architecture points at this slot (not our claim — theirs)

From buzz's `VISION_AGENT.md` / `AGENTS.md` (public, block/buzz):

- *"The agent does not know what MCP server it talks to."* — MCP servers are interchangeable tool providers.
- *"Composability through standards."*
- **"If payments or reputation were needed, they would be implemented as external MCP servers, not built
  into Buzz itself."**

That last line is buzz describing the exact gap BIII fills. We are not asking buzz to bolt on a feature — we
are the external MCP server buzz's own design says payments + reputation belong in.

## How it wires (concrete, once the harness is up)

buzz drives Claude Code through **`buzz-acp`** (its `ACP ↔ MCP` harness): `buzz-acp` spawns the
**`@agentclientprotocol/claude-agent-acp`** adapter, which *wraps the Claude Agent SDK in an ACP interface*.
Because the agent IS the Claude Agent SDK under ACP, it loads MCP servers the standard Claude way — so
**biii-mcp is added exactly like any Claude Code MCP server**, no buzz-specific glue:

```jsonc
// the Claude-Agent-SDK MCP config the ACP-wrapped agent reads (e.g. .mcp.json)
{
  "mcpServers": {
    "biii": { "command": "node", "args": ["/abs/path/to/biii/bin/biii-mcp.js"] }
  }
}
```

Now a buzz agent that @mentions triggers Claude Code has `till_vet_merchant` / `till_resolve` / `till_kya`
/ `till_create_charge` / `till_check_payment` / `till_receipt` in hand — vet, pay, and receipt, all
non-custodial. *(Prerequisite for the harness itself: `npm i -g @agentclientprotocol/claude-agent-acp` and
`BUZZ_ACP_AGENT_COMMAND=claude-agent-acp` — that's buzz's own Claude Code setup, independent of BIII.
Confirm the precise MCP-config surface `claude-agent-acp` exposes when the harness first runs.)*

## The proof (runnable, offline, no keys)

```bash
node examples/buzz-agent-pays.js
```

Runs the whole wedge with the real BIII libs: resolve the agent's npub → its Base address, read its KYA,
refuse a known-bad counterparty, pay a clean merchant via EIP-681, verify + receipt, shape it as a buzz
event. Smoke-tested in CI (`test/examples.test.js`); 192 assertions across the suite; `npm test`.

*(gitlawb runs the same substrate — see `INTEGRATION-gitlawb.md` for the escrow-release wedge.)*

## The ask

Two honest options for a first real deal:

1. **Pilot contract** — the white-label trust verdict + provable receipts for a partner's agent/merchant
   flow. From **$750/mo** (see PILOT.md / PRICING.md), non-custodial, their brand, 2-week integration.
2. **Partnership / integration** — if a contract isn't the right first step: BIII as the **recommended
   payment+trust MCP for buzz agents** (co-listed, integration docs, a joint demo). We stay the open trust
   layer; buzz stays the workspace. No exclusivity, no custody, no money-transmitter surface on either side.

Either way, the wedge is the same: **a keypair-native human+agent economy needs a "safe to pay" and a
receipt — and nobody has built that as the open, non-custodial layer. BIII has.**
