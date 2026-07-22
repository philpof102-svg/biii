# The BIII Hermes trust node — a portable, un-loseable brain

**Layer 1 of "no single point of failure."** This directory turns the `biii` repo into a
self-bootstrapping agent: `git clone` (or `gl clone`) it onto any Linux host, run `bootstrap.sh`,
and you get the **identical** living-economy agent — same persona, same toolsets, same guard.

## What it is (and what it is *not*)

The living economy is one local Hermes with the toolsets **biii** (Base safe-to-pay), **gitlawb**
(DID + git + jobs), **lawbor** (agent↔agent + reputation), and optionally **recall** (our private
second-brain — off by default on remote hosts). This node packages that whole brain so it is not
trapped on one machine that turns off.

**gitlawb coordinates; it does not compute.** `gl` gives the node an identity (DID), makes its
definition portable (a repo), registers it (agent registry), and lets a fleet coordinate (task
delegation, bounties, lawbor). It does **not** run the agent loop — this `bootstrap.sh` + `run.sh`
do, on a real host with CPU, the OpenRouter key, and network. So "impossible to turn off" is really
**"no single point of failure": a portable brain + redundant always-on runners + coordination.**
Literal immortality isn't a thing (every host has a kill switch); redundancy is.

## The safety lock (non-negotiable)

A node that is **hard to kill must stay a monitor, not an actor.**

- The `pre_tool_call` **guard is baked in** (`hermes/agents/biii-monitor/readonly-guard.js`) and
  blocks every write/spend across biii/gitlawb/lawbor/base. It survives `/yolo`.
- **Never put a wallet key on this node.** It moves no funds and signs nothing — its whole value is
  *verdicts* (known-bad / look-alike), re-verifiable on-chain. An un-killable agent with a wallet is
  a catastrophe; an un-killable *watchdog you can't silence* is the point.
- The `.env` (OpenRouter key only) is written `600` and **never committed** (`.gitignore`).

## Bring up a host (Layer 2 = the real "doesn't turn off")

```bash
# on any always-on Linux host that is NOT your laptop (a small VPS, a box, Railway…)
git clone https://github.com/philpof102-svg/biii.git
OPENROUTER_API_KEY=sk-or-... bash biii/hermes/node/bootstrap.sh
HERMES_HOME=~/.hermes-biii bash biii/hermes/node/run.sh   # under systemd/pm2 for always-on
```

Optional: `MEMORY_ROOTS="/path/to/vault:/path/to/mainstreet-memory"` to also wire **recall**
(only where our private brain actually lives — keep it off public hosts).

Register the node's identity so the fleet can coordinate it (**your gesture**, one-time human step):
`gl register`.

## Layer 3 = redundancy (kill-resistance)

Run `bootstrap.sh` on **≥2 independent hosts**. Each `gl register`s. Use **lawbor** (or gitlawb task
claiming) for **leader election** so exactly one is active and the others take over if it dies. Now
killing any single host does not stop the swarm — that is as close to "impossible to turn off" as is
honest, and it stays safe because every replica is the same read-only monitor.
