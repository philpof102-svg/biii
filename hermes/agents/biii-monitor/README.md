# biii-monitor — a Hermes Agent you control, watching Base for trust threats

Not a skill for someone else's agent — a **complete Hermes Agent profile** (persona + tools + a scheduled
monitor + task delegation) that runs a Base **trust-surveillance bot**. It watches a watchlist of wallets +
token contracts and flags the moment one is **known-bad** or an **impersonation / look-alike** of a real
tokenized asset, then **delegates** a focused follow-up per flag. Powered end-to-end by BIII — fail-closed,
non-custodial, re-verifiable on-chain. It moves no funds and holds no key.

## What's in this profile
- `SOUL.md` — the monitor persona (identity / style / avoid / defaults).
- `config.yaml` — the model (Claude), the `biii` MCP toolset (`node bin/biii-mcp.js`, no key), the skills
  dir (`hermes/skills/base-token-trust`), and the monitor cron.
- `cron-monitor.md` — the scheduled task: scan → **delegate a sub-task per flag** → one brief.
- `scan.js` — the surveillance engine (pure; uses BIII's committed floor + 147-contract issuer-verified
  registry, so it flags with **zero network**). Writes `cache/brief.json`.
- `watchlist.json` — what to watch: `{ addresses: [...], tokens: [{address, claimedIssuer?, claimedSymbol?}] }`.

## Control from Claude
The agent is model-agnostic; here it **runs on Claude** and **you drive it from Claude** — Claude is both the
brain and the operator (via the `hermes` CLI). "Use Hermes at full potential": the `crons` scheduler runs the
monitor unattended, each flag **delegates** its own investigation sub-run, and Hermes' GEPA loop sharpens the
checks over time.

## Run it
```bash
# 1. install the Hermes Agent runtime (github.com/NousResearch/hermes-agent) — see its README
# 2. point Hermes at this profile and set your model key (your gesture — never committed)
export HERMES_HOME="$(pwd)"          # this folder
export ANTHROPIC_API_KEY="sk-ant-…"  # the model the agent runs on
hermes run                            # the monitor scans on schedule and delegates per flag
```

Prove the engine without the runtime (offline, no key):
```bash
node scan.js watchlist.json          # prints the flags + writes cache/brief.json
```

## Why it beats a heuristic scanner
HOODRADAR-style monitors guess token safety from bytecode/behaviour. This one gives a **verifiable** verdict:
a token claiming to be a known asset is matched against the **issuer's own on-chain address** (Dinari factory
/ Backed API / Ondo docs), so a look-alike of a real dShare/USDY/OUSG is caught, not guessed — and every flag
delegates a deeper on-chain investigation instead of stopping at the alert.
