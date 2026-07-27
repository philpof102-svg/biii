# Changelog

## 0.2.1 — 2026-07-27

Same contents as the 0.2.0 entry below — the number moved for a release-plumbing reason, not a code one.

**0.2.0 was never usable as a version.** A `v0.2.0` tag already existed on `origin`, pointing at an older
commit whose `package.json` declared `0.1.0`. Nothing in the publish workflow compared the tag name to the
package version, so that run published **0.1.0 under a tag announcing 0.2.0** — which is why npm sat at
0.1.0 while the repo believed a 0.2.0 had shipped. A pushed tag cannot be re-pointed without rewriting
public history, so the clean exit is a new number.

The workflow now **refuses to publish when the tag, `package.json` and `server.json` disagree**, so this
cannot recur by inattention.

## 0.2.0 — never published (tag collision, see above)

A minor bump rather than a patch, because several of these **change what a verdict says**. If you pin
`biii-mcp`, read this before upgrading: calls that used to return one answer now return another, and in
every case the old answer was wrong.

All twelve fixes below came from the same day's work, and all but one from the same root cause: **a read
that failed returned exactly what a read that succeeded-and-found-nothing returns.** The caller could not
tell "nothing there" from "could not look", so an absence became an assertion.

### Verdicts that changed

- **`till_vet_meme` — asking for one chain could return a contract on another.** `chainId` was coerced
  with `Number()`, but DexScreener indexes by slug: `'base'` became `NaN` (falsy, so **no filter at all**)
  and `8453` matched no slug (so **every candidate was discarded**). Measured live on `DEGEN`: asking for
  Base returned a **Solana** contract with `status: "genuine"`. Both the slug and the EVM chain id now
  work, and a chain we cannot map returns **no candidates** rather than silently searching every chain.
  The published OpenAPI schema advertised the broken form too, and so did the paid `/x402/vet-meme` route.

- **Holder-distribution health was the same number for every token.** `top10Concentration` divided the
  top-10 sum by itself, so it was **100 for every distribution** — including 500 perfectly equal holders.
  That kept `rugScore ≥ 80` everywhere, which made `healthy` **always false**. `lib/meme.js` attaches this
  block to every `till_vet_meme` result for a Base token, so those numbers were shipped to callers. The
  denominator is now the total of all positive observed balances; measured after: whale 100, 500 equal
  holders 2, top-10-dominant 99. A `disclosure` field now states what these numbers are **not** — balances
  reconstructed from Transfer logs over a bounded window are deltas, not positions.

- **`till_launch_funder` reported a funding-to-deploy gap of zero on every token.** `deployedAt` carried
  the *funding* timestamp. It now fetches the real creation-transaction timestamp, and
  `FRESH_FUNDING_WINDOW_MS` — defined, exported and used nowhere — is finally applied, in three states
  (`true` / `false` / `null` when a timestamp is missing). The named funder is also flagged
  `funderIsProvablyFirst: false` when the deployer has more incoming transfers than one page holds.

- **`till_watch_wallet` could report an allowance as newly granted when it had simply never been read.**
  A partial approval sweep rewrote the stored baseline with only what it managed to read, dropping the
  rest; the next run announced them as *"Someone granted it since"*. The baseline is now replaced only on
  a **complete** sweep. The counterparty memory cap also kept the oldest entries and discarded the newest,
  so past 500 counterparties every new one re-alerted forever.

- **`till_trust` no longer claims a counterparty has no history when the LAWBOR node is structurally
  blind.** Standing is bounded by the node's own irrecoverable spend; a node that has paid nobody returns
  zero for *every* address. That zero is now `uninformative` — counted as unread, never as a finding.

### Money paths

- **A negative `BIII_VET_PRICE_USD` made the paid endpoint free.** `x402-settle` does
  `BigInt(String(needMicro))`, and `BigInt("-5000000")` is valid, so `paidMicro < priceNeed` was false for
  *any* payment. The price now goes through `till.usdToMicro`, which refuses negatives, `NaN`, exponent
  notation and sub-micro amounts, and the node answers **503 misconfigured** rather than quoting a price
  it cannot read. Both published figures (`x-payment-info` and the 402 `accepts[]`) now derive from one
  validated value and can no longer disagree.
- **The anti-replay guard's two anchors were coalesced to zero.** A missing `confirmations` read as
  "just landed" (freshness always passed) and a missing `blockNumber` recorded the consumed payment at
  block 0, which the next settle pruned away — re-enabling replay. Both are now validated. *This was not
  exploitable*: every `verifyTxHash` branch returning `paid: true` carries both fields. It is fail-closed
  input validation on an exported function.
- **A payment challenge can no longer be built without a recipient** (`payTo: ""`). Also not reachable
  from the server, which already guards it — defence in depth.

### Under the surface

- **`multicall`: an answered-but-unreadable call was filed as a revert.** `success: true` with data that
  does not decode is *unread*, not "definitively no allowance". Filing it as a revert let the approval
  sweep declare itself `complete`, which is what let `wallet-watch` drop unread allowances — the head of
  the chain described above.
- **`biii-router`** (dormant, behind `BIII_ROUTER_ENABLED`): `shouldRoute` returned the same `false` for
  "measured below threshold" and "never scanned". Use `routeVerdict()`, which reports `basis` and also
  handles staleness and the midnight table reset. Its header used to instruct exactly the wiring that
  would refuse to pay every honest merchant under $1k of daily settlement.

### Testing

Five `lib/` modules had **no test at all** and all five held a real defect; two test files contained
**zero assertions** while printing a green check. The suite now counts itself (`npm run test:total`),
refuses an empty success, and fails when fewer bilans are read than files launched — a counter that
previously under-reported the suite by 18% without anyone noticing.

**765 tests, 73 files, every fix mutation-tested.**
