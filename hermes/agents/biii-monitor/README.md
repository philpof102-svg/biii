# biii-monitor — a Hermes Agent you control, watching Base for trust threats

Not a skill for someone else's agent — a **complete Hermes Agent profile** (persona + tools + a scheduled
monitor + task delegation) that runs a Base **trust-surveillance bot**. It watches a watchlist of wallets +
token contracts and flags the moment one is **known-bad** or an **impersonation / look-alike** of a real
tokenized asset, then **delegates** a focused follow-up per flag. Powered end-to-end by BIII — fail-closed,
non-custodial, re-verifiable on-chain. It moves no funds and holds no key.

## What's in this profile
- `SOUL.md` — the monitor persona (identity / style / avoid / defaults) → copied to `HERMES_HOME/SOUL.md`.
- `config.yaml` — a **partial** config (deep-merged over Hermes' `DEFAULT_CONFIG`): the `biii` MCP toolset
  (`node bin/biii-mcp.js`, no key) + the skills dir. The **model is left unset** (activation = the operator's
  key gesture) and the **cron is registered via the CLI**, not written here (see below).
- `cron-monitor.md` — the scheduled task: scan → **delegate a sub-task per flag** → one brief.
- `scan.js` — the surveillance engine (pure; uses BIII's committed floor + issuer-verified registry, so it
  flags with **zero network**). Writes `cache/brief.json`.
- `biii-scan.sh` — keyless-watchdog wrapper: `hermes cron … --script biii-scan.sh --no-agent` runs the scan
  and delivers its flags with **no model key**.
- `watchlist.json` — what to watch: `{ addresses: [...], tokens: [{address, claimedIssuer?, claimedSymbol?}] }`.

## Control from Claude
The agent is model-agnostic; here it **runs on Claude** and **you drive it from Claude** — Claude is both the
brain and the operator (via the `hermes` CLI). "Use Hermes at full potential": the `crons` scheduler runs the
monitor unattended, each flag **delegates** its own investigation sub-run, and Hermes' GEPA loop sharpens the
checks over time.

## Run it

Full, runtime-verified runbook: **[`../INSTALL-hermes-agent.md`](../INSTALL-hermes-agent.md)**. In short —
assemble a `HERMES_HOME` (SOUL.md + config.yaml + `skills/base-token-trust`), then:

```bash
export HERMES_HOME=~/.hermes-biii
hermes mcp test biii     # ✓ Connected (~0.9s) · ✓ Tools discovered: 15   (no key needed)
hermes model             # activate: pick Anthropic → a Claude model  (the operator's one gesture)
hermes cron create '30m' '…scan + delegate per flag…' --skill base-token-trust --name biii-monitor
```

Prove the engine with **no runtime and no key** (offline):
```bash
node scan.js watchlist.json          # prints the flags + writes cache/brief.json
```

> **Verified against Hermes Agent v0.19.0:** `hermes doctor` ✓ (persona + skill + config), `hermes mcp test
> biii` → ✓ Connected, **15 tools** discovered, and the keyless `scan.js` raises its 3 fixture flags. The
> only step gated on the operator is the model key.

## Why it beats a heuristic scanner
HOODRADAR-style monitors guess token safety from bytecode/behaviour. This one gives a **verifiable** verdict:
a token claiming to be a known asset is matched against the **issuer's own on-chain address** (Dinari factory
/ Backed API / Ondo docs), so a look-alike of a real dShare/USDY/OUSG is caught, not guessed — and every flag
delegates a deeper on-chain investigation instead of stopping at the alert.
