# BIII — MCP distribution (get listed where agents discover tools)

BIII ships a stdio MCP server (`bin/biii-mcp.js`, 15 `till_*` tools) that any MCP client can load.
Getting it into the **MCP registry** is the durable "meet the agents" move: the registry is what
openhuman, Claude Desktop, Smithery, and tool-routers like monid index — one listing, many hosts.

## Registry-ready (this repo)
- **`server.json`** — the [official MCP registry](https://registry.modelcontextprotocol.io) manifest
  (`io.github.philpof102-svg/biii`, npm package `biii-mcp`, stdio). Matches our shipped
  `mainstreet` / `lawbor` entries.
- **`package.json`** — publishable: name `biii-mcp`, `mcpName` set, `bundledDependencies: [trust-core]`
  (the vendored classifier is bundled into the tarball, so `npm install biii-mcp` resolves it with
  zero extra steps — proven by installing the packed tarball into a clean dir and running the MCP).
- **`.github/workflows/publish.yml`** — tag `v*.*.*` → run tests → verify the stdio MCP starts →
  `npm publish` → `mcp-publisher` login via **GitHub OIDC** → publish `server.json` to the registry.

## To publish (one release gesture)
Needs the repo secret **`NPM_TOKEN`** (npm automation token) set once. Then:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow publishes `biii-mcp` to npm and `io.github.philpof102-svg/biii` to the MCP registry.
(`workflow_dispatch` with `dry_run=true` runs the whole gate without publishing.)

## Zero-install: the HOSTED endpoint (live now)
The deployed server exposes **MCP over Streamable HTTP at `/mcp`** — the SAME 15 tools + dispatch as
the stdio bin, served over HTTP. Any MCP client points at the URL, **nothing to install**:

```
https://biii-production.up.railway.app/mcp
```

POST JSON-RPC (`initialize` / `tools/list` / `tools/call`); notifications → `202`; `GET` → `405`
(no server→client SSE). Stateless, read-only, non-custodial like every BIII surface. This is the
path for **openhuman** and any host that takes a remote MCP URL — no npm, no local process.

## Use it now (stdio, before the npm publish)
Any MCP client can also run it straight from the repo:

```bash
node bin/biii-mcp.js        # stdio: initialize / tools/list / tools/call
```

**In openhuman** (or any MCP host): point it at the hosted `/mcp` URL above (zero install), or add a
stdio server (`npx biii-mcp` once published, or `node /path/to/biii/bin/biii-mcp.js` today). Its
agents then get the fail-closed safe-to-pay / token-genuineness verdicts natively — the "should I
pay this?" check one layer below their x402 payment. See `RESEARCH-openhuman.md` for why interop
(not a fork) is the fit.

## Posture
Listing describes only what BIII does (fail-closed, non-custodial, re-verifiable on-chain). The MCP
holds no key and moves no funds — the verdict tools are read-only; `till_create_charge` returns an
EIP-681 URI the caller's OWN wallet executes.
