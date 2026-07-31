# Argument-level control for readonly-guard — design

*Written 2026-07-31 after auditing the deployed guard. Not implemented: the gating measurement in §1
has not been taken, and building on an unmeasured payload contract is the mistake this document exists
to avoid.*

---

## 0. What problem this actually solves

The deployed guard is a list of dangerous tool NAMES. Measured against it today:

| tool | guard verdict |
|---|---|
| `send`, `swap`, `sign`, `fund` | blocked |
| `import_private_key` | **allowed** |
| `export_wallet`, `backup_seed` | **allowed** |
| `set_operator_key`, `approve`, `unlock` | **allowed** |
| `safe_read` carrying a key in its arguments | **allowed** |

The guard blocks verbs that MOVE value. It blocks nothing that EXFILTRATES it. Exporting a key is a
read in the filter's terms and a catastrophe in real terms.

**Why the obvious fix is wrong.** Adding `export|import|backup|unlock|approve` to the name list breaks
`check_private_key_leak`, `import_findings`, `backup_db` — legitimate read tools. The previous author
already recorded the consequence: *"Un garde qui bloque des lectures se fait desactiver, et on perd
tout."* A control that produces false positives is removed, and then there is no control at all. False
positives are the failure mode that kills this, not false negatives.

**The insight that makes an argument-level control work.** `check_private_key_leak` is safe *precisely
because it does not carry a private key* — it takes an address. `import_private_key` is dangerous
because it carries one. The two are identical in name-space and opposite in payload-space. The
discriminator lives in the arguments, which is the one thing a name filter structurally cannot see.

---

## 1. GATING MEASUREMENT — do this before writing any rule

Everything below assumes the hook can see arguments. That is **evidence, not fact**, today:

- The Hermes binary contains `"tool_input"` (3 occurrences) and `"toolInput"` (3), the same dual-spelling
  pattern already confirmed for `tool_name` / `toolName`. It does **not** contain `arguments` or `params`.
- No real payload has been observed. `observed-shapes.log` is empty because it only records calls the
  guard failed to identify, and none have failed since it was installed.

**Action:** extend the journal to record the top-level key names of *every* call — names only, never
values, since a payload may carry the very secrets this control exists to protect — for a bounded
window (48h is enough at this fleet's cadence). Then read it.

Three outcomes, three different projects:

| what the log shows | what to build |
|---|---|
| `tool_input` present and populated | §2 as written |
| the key exists but is always empty | the hook fires before argument binding — an argument control is impossible here, and the answer moves to the MCP servers themselves |
| neither spelling appears | payload carries the name only — same conclusion |

Building §2 without this step would be a control whose enforcement path has never executed. That is the
shape of every defect found in this system this week.

---

## 2. The rules, ranked by confidence

Three rules, deliberately unequal. Only the first two are proposed for blocking.

### R1 — a value that IS one of our secrets. **Block. Zero false positives by construction.**

Compare argument values against the literal secret strings in the environment (the same primary rule as
the API's outbound scrub: exact values, never guessed shapes). If a tool call carries our own
`OPENROUTER_API_KEY` or an RPC URL with its key, it is exfiltration whatever the tool is called.

Exact matching cannot misfire on an address, a tx hash or a signature — and this fleet's entire job is
to publish those.

### R2 — a secret-shaped VALUE in a secret-NAMED field. **Block. The conjunction is the point.**

Neither half works alone, and this is the crux of the whole design:

- **Shape alone fails.** A 64-hex private key is byte-indistinguishable from a transaction hash.
  MainStreet publishes tx hashes continuously; blocking 64-hex would block the product.
- **Name alone fails.** That is the existing guard, and it is why `check_private_key_leak` cannot be
  separated from `import_private_key`.

So: field name matches `/priv|secret|mnemonic|seed|passphrase|keystore/i` **AND** the value looks like
key material (64 hex with optional `0x`, or a BIP-39 mnemonic — see below). `check_private_key_leak`
passes, because its argument is an address: right name, wrong shape. `import_private_key({value})`
blocks, because the value is a key even though the field is called `value` — wait, it blocks under
**R3**, not R2, since the field name is innocent. Both rules are needed; neither covers the other.

### R3 — a BIP-39 mnemonic anywhere in the arguments. **Observe first, then block.**

A seed phrase is 12 or 24 space-separated words drawn from a fixed 2048-word list. Require ≥11 of 12
words to be wordlist members, so ordinary prose cannot trip it — a 12-word English sentence essentially
never scores 11 hits against BIP-39. Collision risk is low enough that this is probably safe to enforce
immediately, but it is the only rule here that inspects values in fields with innocent names, so it
starts in observe mode and graduates on evidence.

### Explicitly rejected

- **Blocking on 64-hex.** Collides with tx hashes — the core published artifact.
- **Blocking on URLs in arguments.** MainStreet's actual job is probing agent endpoints; a URL argument
  is the normal case, not the suspicious one.
- **More name patterns.** Restates the problem this document exists to escape.

---

## 3. Fail-closed, consistently with what is already there

- `tool_input` present but unparseable → **block**. Same contract as the existing unreadable-payload
  branch: a guard that cannot see the call must not authorise it.
- An exception inside the argument check → **block**. Already the behaviour after the 2026-07-31 graft.
- `tool_input` **absent** → allow, and journal it. The absence may be legitimate (a tool with no
  arguments), so blocking would break every such call — but it must be visible rather than assumed,
  exactly like the empty-stdin case.

---

## 4. Rollout — the part that decides whether this survives

**Ship in OBSERVE mode.** Evaluate every rule, log every would-be block with the tool name and the rule
that fired, block nothing. Run for a week.

Flip to enforce **only when the observe log contains no legitimate call.** If it contains one, the rule
is wrong and gets narrowed — not the control disabled.

This ordering is not caution for its own sake. The previous author's note explains why the control
dies: it blocks a read, someone turns it off, and the fleet runs with nothing. An observe window costs a
week and buys the evidence that the enforcement will not misfire.

---

## 5. What this still will not cover

- **6 of 8 scheduled jobs are `no_agent: true`** — shell scripts that never reach a `pre_tool_call`
  hook. No version of this design touches them. Their only limit is their own source, and three of them
  execute JS from `/mnt/d`, a Windows-writable path, on a machine with a documented compromise window
  (2026-05-29 → 2026-07-25, four implants). That is a larger surface than the one this document
  addresses, and it needs a different answer.
- A dangerous tool with an innocent name, innocent field names, and a value that is neither one of our
  secrets nor key-shaped. Named here rather than papered over.
