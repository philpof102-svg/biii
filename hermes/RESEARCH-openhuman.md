# openhuman (tinyhumansai) × Hermes — vetting + fit

> "Describe the automation in one sentence. It wires the whole thing, debugs itself, ships it."
> Open-source, ~35k★. github.com/tinyhumansai/openhuman

## What it actually is (facts, not the pitch)
- A **local-first desktop agent platform** — Rust core + Tauri shell + TS frontend. **License GPL-3.0** (copyleft).
- Frameworks: `tinyagents` (agent graphs, checkpointing), `tinyflows` (the visual "Zapier" workflow builder), an
  `agentmemory`-compatible **memory tree** (SQLite) with **Obsidian vault** integration.
- Consumes **5,000+ MCP servers** and 100+ OAuth integrations; **17 messaging channels**; **Claude primary**.
- **Agent-to-agent payments in x402 USDC** are built in. Secrets in the OS keyring. Approval gates before side effects.
- **Runs arbitrary code** (browser, scraper, coder tools) — a large trust surface.

## Verdict for us: INTEROP, not merge
We do **not** fold openhuman into Hermes, and we do **not** fork it:
- **GPL-3.0 is copyleft** — deriving contaminates our licensing (same rule as herdr/AGPL: use is fine, derive is not).
- It's a heavy **Rust + Tauri desktop app**; we **can't build Rust natively here** anyway (no MSVC linker, C: full —
  see memory `disk-c-full-use-d`). There is no lightweight crate to bolt onto the Hermes CLI.
- It **executes arbitrary code + holds OAuth to 100+ services**; the Hermes `readonly-guard` does not cover it. Running it
  autonomously under our fleet would blow the non-custodial / read-only posture wide open. Treat it as an **external peer**.

## The real fit — the two open rails we already share
openhuman independently converged on **our exact primitives** (MCP + x402 + Obsidian memory + Claude). That convergence
*is* the integration surface — no code fusion required:

1. **MCP — BIII as a safe-to-pay tool inside openhuman.** openhuman loads any MCP server. Point it at `biii-mcp`
   (`AGENT-QUICKSTART.md`) and its agents get `vet_asset` / `vet_address` verdicts natively — the fail-closed
   "should I pay this?" check *before* they move funds. This is pure distribution: one more agent host that can call BIII.
2. **x402 — an openhuman agent is a candidate BIII buyer.** Their agents pay in x402 USDC. That is precisely the
   "meet a real external buyer" settle we need: an openhuman agent that pays `/x402/vet-asset` ($0.25) both proves the
   paid path in prod and auto-indexes BIII on the CDP-discovery venues (see `DISTRIBUTION-x402.md`). BIII sits one layer
   *below* their payment as the safety gate.

**Hermes' own "one sentence → automation" ask** is already served by the SKILL pattern (`skills/market-analyst`), not by
importing tinyflows. If we want an authoring skill, we write a small Hermes skill — we do not vendor a GPL desktop app.

## Bottom line
openhuman is a **peer platform and a distribution channel**, not a dependency. Concrete moves, both low-risk:
list `biii-mcp` in its MCP ecosystem, and treat its x402 agents as the external buyer for the first real settle. No fork,
no autonomous run, no license contamination.
