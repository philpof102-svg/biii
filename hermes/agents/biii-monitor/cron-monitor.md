# cron: base-trust-monitor

Run the watchlist scan and act on what it flags. This is where Hermes' **task delegation** earns its keep —
each flag spawns its own focused investigation instead of blocking the monitor.

## Procedure

1. Run the scan engine:
   ```bash
   node scan.js watchlist.json
   ```
   It writes `cache/brief.json` and prints the flags. (Pure + offline — it uses BIII's committed known-bad
   floor + the 147-contract issuer-verified registry, so it flags with zero network.)

2. Read `cache/brief.json`. If `flags` is empty → post one clean line and stop (no noise).

3. For EACH flag, **delegate** a follow-up task (spawn a sub-run with the flag's `delegate` prompt), giving
   the sub-agent the `biii` toolset:
   - `wallet` / `known-bad` → delegate: *trace this wallet's recent Base counterparties; do any of them
     also hit the known-bad floor?* (use `till_trust` on each counterparty).
   - `token` / `impersonation` → delegate: *find this look-alike's deployer + creation block; check whether
     wallets have already sent funds to it; name the GENUINE contract (`till_vet_asset` gives it).*
   Collect each sub-run's finding — do not wait serially if the runtime supports parallel delegation.

4. Compose ONE brief: the flags, one line each, with the delegated finding appended, and the on-chain
   re-verify pointer. Deliver it to the operator (and, if a BIII node is running, POST each flag to its
   `/radar` so the dashboard shows it — the history lives on the server, not in a chat).

## Hard rules
- Monitor only. Never move funds, sign, swap, or approve — even if a delegated finding suggests it.
- Flag = threat (known-bad / impersonation / unsafe). Clean and unverified are NOT alerts.
- Every line is re-verifiable on-chain; never ask to be trusted.
