---
name: x-devradar
description: Watch X (Twitter) + the web for NEW AI-agent dev tools & infra insights so the agent self-improves — it learns what to integrate next (new toolsets, issuers, patterns). Uses Monid's paid data endpoints. SPENDS ~$0.025/cycle — SUPERVISED runs only (needs MONID_ALLOW_SPEND=1).
version: 0.1.0
platforms: [desktop, cli]
metadata:
  hermes:
    tags: [x, twitter, dev-tools, agent-infra, radar, self-improve, monid, x402]
    requires_toolsets: [monid]
required_environment_variables: [MONID_ALLOW_SPEND]
---

# X dev-tools radar — the agent's self-improvement feed

Purpose: keep the agent (and BIII) current. The agentic-payments / MCP / x402 space moves weekly; this
skill watches a small set of X accounts + the open web through **Monid's paid data endpoints**, and turns
what it finds into a tight brief of **new tools / insights worth integrating** — the same self-improving
loop that surfaced the cbBTC registry gap, but pointed OUTWARD at the ecosystem.

## ⚠️ This skill SPENDS money (it is not read-only)
Every cycle costs ~$0.025 on Monid. The read-only guard blocks `monid_run` by default. Run this ONLY in a
**supervised** context with `MONID_ALLOW_SPEND=1` set (a per-run, explicit opt-in). Never wire it into the
unattended keyless cron. Always cap volume (`maxItems`, one search) so a cycle stays a few cents.

## The endpoints (illustrative — DISCOVER the live id each run, never hardcode)
Endpoint **ids drift**; always `monid_discover` to get the current one, then `monid_inspect` for the exact
input schema + cap fields before `monid_run`. As of last discovery the useful ones were, by capability:
- **X/Twitter, one handle's posts** (TikHub family) — ~**$0.0015/call**. Cheapest for a fixed watchlist.
- **X/Twitter by search+handles with engagement/date filters** (Apify tweet-scraper family) — ~**$0.0006/result**, cap with `maxItems`.
- **Web "what's new" search** (Exa search family) — ~**$0.01/call**, filter by category + published-date.
- **Clean deep-read of URLs** (Exa contents family) — ~**$0.002/call**.

## Procedure (one cycle) — DISCOVERY-FIRST, so a stale id never breaks or fabricates
1. **Read the watchlist** (`watchlist.json`: `{ handles:[...], searches:[...] }`).
2. **Ingest X**: `monid_discover query="twitter user tweets"` → pick the cheapest per-handle endpoint → `monid_inspect` it → `monid_run` for each handle (small result cap). For a search term, discover the tweet-search endpoint and run with `maxItems<=20`.
3. **Discover the web**: `monid_discover query="exa web search"` → `monid_inspect` → one `monid_run` on the rotating query with a recent published-date window; `monid_get_run` to poll until done.
4. **Deep-read**: discover the "read url contents" endpoint → `monid_run` on the top 2-3 result URLs (cheap).
   If a discover call fails or the monid gateway is unreachable, STOP and report "$0, gateway down" — never invent a brief.
5. **Synthesize** → a brief: for each NEW item — name, one-line what-it-is, link, and **"integration angle for us"** (a 4th toolset? a new issuer to add? a pattern? a distribution channel?). Skip noise; only genuinely-new, relevant items.
6. **Self-improve**: append the brief to `cache/devradar.json`. Items tagged `integrate` become the backlog the operator (or a follow-up agent run) acts on.

## Known gotchas (learned from live runs, 2026-07-22)
- **Exa search date filter**: the monid gateway coerces an ISO `startPublishedDate` string into a JS Date the
  provider then rejects. Use **`maxAgeHours` nested under `contents`** instead — e.g.
  `{"body":{"query":"…","type":"auto","numResults":5,"contents":{"maxAgeHours":4320}}}`.
- **Gateway flakiness**: monid may go "unreachable after 3 consecutive failures" mid-cycle (auto-retry ~47s).
  On that, STOP + report $0 — never fabricate. Prefer FEW calls per cycle so a flaky window wastes nothing.
- Always `monid_balance` at the start (free) — refuse to run if the balance can't cover the capped cycle.

## Report format (tight)
```
X DEV-RADAR — <n> new items (cycle ~$X):
- <name> — <what> — <link>  → integrate: <angle> [high/med/low]
...
watched: <handles>; searched: "<query>"; spend: $X.XX
```

## Hard rules
- SPEND-GATED: refuse to run any `monid_run` unless MONID_ALLOW_SPEND=1 (the guard enforces this).
- Cap every call (`maxItems`, single search) — a cycle must stay cents, never dollars.
- Judgment, not slop: only surface items with a concrete integration angle for BIII / the agent. Absence of a real find is a clean, cheap cycle — say "nothing new", don't pad.
