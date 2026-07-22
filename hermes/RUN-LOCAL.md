# Run the living economy locally — no Claude terminal needed

One local Hermes agent running our whole stack, driven from a plain **Windows cmd**, so it
keeps working after the Claude session / credits end. The read-only guard stays on the whole time
(blocks every write/spend across all toolsets), so nothing publishes, signs, or moves funds on its own.

**Toolsets (one local Hermes):** `biii` (Base safe-to-pay) · `gitlawb` (DID + git + jobs) ·
`lawbor` (agent↔agent + bazaar + reputation) · `recall` (our Obsidian + mainstreet memory) ·
`monid` (OAuth pay-per-call data — available, not `-t`-selectable; omit `-t` to include it).

## Two commands (in `D:\Users\VolKov\veilleIA\biii\hermes\`)

### 1. Keep the economy alive — `start-hermes.cmd`
Double-click it (or run it in a cmd). It starts the **Hermes gateway**: the scheduler that fires the
keyless watchdog **biii-watch every 30 min** (a $0, no-key Base trust scan). **Keep the window open**;
close it to stop. Re-running it is safe (it kills any old gateway first).

### 2. Ask the agent one thing — `hermes-ask.cmd`
```
hermes-ask "your prompt here"  [model]
```
- Default model: **`tencent/hy3`** (cheap, routine).
- Hard tasks: **`moonshotai/kimi-k3`** — Kimi 3 (1M-token context, ~5× cheaper than frontier, strong
  backend coding; pricier than hy3, use when the task is hard). A parallel variant, **K3 Swarm Max**,
  is built for many-agents-at-once — a fit for our fleet/swarm work if/when OpenRouter exposes it.

Examples:
```
hermes-ask "use memory_search to recall what we decided about buzz"
hermes-ask "vet Base address 0xABC... with till_trust, one-line verdict" moonshotai/kimi-k3
hermes-ask "read the lawbor bazaar, list any open jobs and who posted them"
```

## Prereqs (already set on this machine)
- WSL running; `HERMES_HOME=/root/.hermes-biii` with `config.yaml` (5 toolsets) + `.env` holding
  `OPENROUTER_API_KEY`; hermes at `/root/.hermes-venv/bin/hermes`.

## Gotchas (why the scripts look the way they do)
- **`.cmd` files must be CRLF** — cmd.exe mis-parses LF-only scripts (`'setlocal' not recognized`).
  `.gitattributes` pins `*.cmd eol=crlf` so they stay correct on checkout.
- Prompt/model are passed to WSL via **`WSLENV`** env-var sharing, not inline args — avoids the
  fragile quote-nesting across the cmd → wsl boundary that silently dropped the prompt (agent fell to
  interactive chat).
- `-t` accepts `biii,gitlawb,lawbor,recall`; `monid` is remote/OAuth and is ignored by `-t`.
- Everything writes to **D:** (C: is full); the scripts touch no disk beyond WSL.
