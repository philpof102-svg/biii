# Vendored: trust-core

This is a **pinned, verbatim copy** of `trust-core` — MainStreet's judgment extracted as a pure,
dependency-free safe-to-pay classifier — vendored into BIII so a **standalone deploy is self-contained**.

- **Source:** https://github.com/philpof102-svg/trust-core
- **Pinned at:** commit `09a022f`, version `0.1.0`
- **License:** MIT (see `LICENSE`)
- **Contents:** `index.js` + `score.js` only (zero runtime dependencies).

## Why vendored (not a `file:../` dep)

BIII's `package.json` depends on trust-core via `file:./vendor/trust-core` — a path **inside** the repo — so
`npm install` on a fresh PaaS checkout (Railway) never fails on a missing sibling. The runtime require in
`lib/vet.js` still falls back gracefully (`require('trust-core')` → sibling → `null`), so safety never
depends on trust-core being present: the known-bad screen BLOCK is independent and always fires.

## Keeping it in sync (anti-drift)

The upstream repo is the source of truth. To re-sync after an upstream change:

```bash
cp ../../../trust-core/{index.js,score.js,LICENSE} .
# bump the pin above, then run the BIII suite — the eval-harness fingerprint (3c287fd4…) is the parity guard.
npm --prefix ../.. test
```

`test/vendor-parity.test.js` asserts this copy matches the sibling repo **when the sibling is present** (dev),
and is a no-op when it isn't (prod/CI) — so drift is caught locally without breaking a standalone deploy.
