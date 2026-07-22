# Running the BIII `biii-monitor` as a real Hermes Agent

A Base **trust-surveillance agent** you (Claude) control: it watches a watchlist of wallets and token
contracts and raises a flag the moment one is **known-bad** or an **impersonation / look-alike** of a real
tokenized asset. Verdicts come from the BIII toolset — fail-closed, non-custodial, re-verifiable on-chain.

Everything below was **run against the real runtime** (Hermes Agent **v0.19.0**, installed from the MIT
source at `github.com/NousResearch/hermes-agent`). The only step that is *not* automated is the model key —
that is the operator's one gesture (see step 5).

---

## Runtime model (why the layout is what it is)

Hermes is **one `HERMES_HOME` = one agent**. That home holds:

| Path | What it is |
|---|---|
| `SOUL.md` | the agent's persona (this repo: `agents/biii-monitor/SOUL.md`) |
| `config.yaml` | a **partial** config, deep-merged over Hermes' `DEFAULT_CONFIG` — you only declare additions |
| `skills/<name>/SKILL.md` | auto-discovered skills (this repo: `skills/base-token-trust`) |
| `cron/jobs.json` | scheduled jobs — **registered via the CLI**, never hand-written |
| `.env` | provider API key(s) — created by `hermes setup` / `hermes model` |

`mcp_servers.<name>.command/args/env` (stdio) is exactly the contract our `bin/biii-mcp.js` already speaks —
the toolset drops in with zero adaptation.

---

## 1. Install the runtime (from auditable source — not `curl | bash`)

```bash
git clone https://github.com/NousResearch/hermes-agent.git ~/hermes-src
# uv (Astral) — from PyPI, not a remote install script:
python3 -m pip install --user uv    # or: pipx install uv
uv venv ~/.hermes-venv --python 3.11
uv pip install --python ~/.hermes-venv/bin/python -e "$HOME/hermes-src[cli,mcp]"
~/.hermes-venv/bin/hermes --version        # → Hermes Agent v0.19.0
```

## 2. Make the BIII toolset runnable (Linux-native, so the vendored dep resolves)

```bash
git clone <this-biii-repo> ~/biii
cd ~/biii && npm install        # wires trust-core (file:./vendor/trust-core), offline, ~1s
node -e 'console.log(require("/root/biii/bin/biii-mcp").TOOLS.length)'   # → 15
```

## 3. Assemble the HERMES_HOME

```bash
HOME_DIR=~/.hermes-biii
mkdir -p "$HOME_DIR/skills" "$HOME_DIR/scripts"
cp ~/biii/hermes/agents/biii-monitor/SOUL.md          "$HOME_DIR/SOUL.md"
cp -r ~/biii/hermes/skills/base-token-trust           "$HOME_DIR/skills/base-token-trust"
cp ~/biii/hermes/agents/biii-monitor/config.yaml      "$HOME_DIR/config.yaml"   # edit the two /ABS/PATH/ lines
cp ~/biii/hermes/agents/biii-monitor/biii-scan.sh     "$HOME_DIR/scripts/biii-scan.sh"
```

## 4. Prove it is wired (no model key needed)

```bash
export HERMES_HOME=~/.hermes-biii
~/.hermes-venv/bin/hermes doctor       # ✓ config.yaml, ✓ SOUL.md (persona configured), ✓ skills/
~/.hermes-venv/bin/hermes mcp test biii
#   Transport: stdio → node · ✓ Connected (~0.9s) · ✓ Tools discovered: 15
#   till_vet_merchant … till_vet_asset … till_authorize
```

The keyless watchdog tier already works end-to-end:

```bash
node ~/biii/hermes/agents/biii-monitor/scan.js ~/biii/hermes/agents/biii-monitor/watchlist.json
#   ⚠ 3 flag(s): known-bad 0x098b716b…, impersonation 0x41f7a637… (BlackRock claim), impersonation 0xababab…
```

## 5. Activate — the operator's one gesture (model key)

```bash
export HERMES_HOME=~/.hermes-biii
~/.hermes-venv/bin/hermes model          # pick Anthropic → a Claude model (or put ANTHROPIC_API_KEY in .env)
```

## 6. Run / schedule (two tiers)

**A — keyless watchdog** (runs the deterministic scan, delivers flags, *no* model key):

```bash
hermes cron create '30m' --script biii-scan.sh --no-agent --name biii-watch --deliver local
```

**B — agent + delegation** (Hermes at full potential — reasons over each flag and *delegates* a follow-up):

```bash
hermes cron create '30m' \
  'Scan the biii watchlist via the base-token-trust skill. For each FLAG, delegate a focused follow-up
   (trace a known-bad wallet'\''s counterparties; find a look-alike'\''s deployer + creation time). Flags
   first, then what you delegated. Never say "safe".' \
  --skill base-token-trust --name biii-monitor --deliver local
```

## Remote control (control-from-Claude)

Once keyed, drive single turns non-interactively — this is how Claude operates the agent:

```bash
hermes -z 'Vet 0x41f7a63713e76c0ab800be03bae9f17b8a356348 claimed issuer BlackRock' \
       -t biii --skills base-token-trust
hermes cron list          # inspect scheduled jobs
hermes status             # components + key state
```

---

**Security posture kept throughout:** installed from auditable source (no `curl | bash`); the model key is
the operator's gesture (never handled here); the BIII toolset needs **no key** because it moves no funds —
it only reads the chain and returns verdicts. Fail-closed, non-custodial, re-verifiable on-chain.
