# Deploy the always-on BIII trust node on Railway (Layer 2)

The real "it doesn't turn off": a read-only Hermes trust node running 24/7 on a host that isn't a
laptop. The keyless watchdog (`biii-watch`, every 30 min) fires on its own; on-demand agents run when
you ask. **The only secret is `OPENROUTER_API_KEY`** — it lives in Railway's service variables, never
in the repo or image.

## One-time deploy (your gesture)

1. **Point Railway at the `biii` repo.** New Railway project → Deploy from GitHub → `philpof102-svg/biii`.
   Railway reads `hermes/node/railway.json`, which builds `hermes/node/Dockerfile`.
   *(Or from the repo: `railway init` then `railway up` — `railway up` deploys the LOCAL tree, so
   rebase/commit first.)*
2. **Set the one secret.** Service → Variables → add `OPENROUTER_API_KEY` = the value from your
   `agent-veille/.env`. (Optional: `HERMES_MODEL` to override `tencent/hy3`; `MEMORY_ROOTS` only if you
   want recall — leave it unset on a public host so our private brain never leaves your machine.)
3. **No public domain needed** — this is a background worker (the gateway binds locally, serves no
   HTTP). Railway just keeps the process alive + restarts on failure.

## What runs

- `entrypoint.sh` renders the config, writes `.env` (600), registers the `biii-watch` cron, and
  `exec hermes gateway run`. Toolsets: **biii** (always) + **gitlawb** (fails closed without `gl`) +
  **lawbor** (if the repo cloned at build) + **recall** (only if `MEMORY_ROOTS` set). Guard: on.
- **Safety:** the baked `pre_tool_call` guard blocks every write/spend. There is no wallet key on this
  node — it produces verdicts, moves nothing. A hard-to-kill node MUST stay a monitor (see NODE.md).

## After it's up

- **Register the node** so the fleet can coordinate it (Layer 3): add `gl` to the image and run
  `gl register` (the node DID). Then run this same service on a **second** host and use lawbor for
  leader election — killing one host no longer stops the swarm.
- Verify it's alive: Railway logs show `▸ BIII trust node up (READ-ONLY)` and the periodic watchdog.

> Note: the Docker image is built by Railway's builders — it was not built locally (this machine has a
> full C: and no Docker/MSVC toolchain). The entrypoint's config render + gateway start are the same
> steps proven on the local node.
