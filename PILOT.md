# BIII — Pilot pack (the graph to first contract)

*Fillable templates. Nothing here is a signed agreement or a claim of an existing customer —
`<angle-bracket>` fields are placeholders for a real counterparty. Keep it honest: only capabilities
that ship today (see README + COMPETITION.md + PRICING.md).*

---

## 1. Outreach (first contact — short, specific, no hype)

> **Subject: a "safe to pay" verdict + provable receipts for your USDC flow**
>
> Hi `<name>`,
>
> You already move USDC for `<their merchants / their users>`. BIII adds the one thing a rail and a
> wallet don't: a **non-custodial trust verdict** — is this counterparty safe to pay? — composed from
> reputation + known-bad screening (via the MainStreet oracle), on-chain settlement, plus a **receipt
> anyone can re-check on-chain**. You never touch the funds.
>
> It's one MCP call. Worth a 20-minute look? I can run your own test address through it live.
>
> `<you>`

*Why it lands: it names their existing flow, offers the missing ingredient (judgment + proof), and
asks for a low-commitment demo — the live "run your own scammer address through it" test is the hook,
because the product now passes it.*

---

## 2. Pilot proposal (one page)

**Parties.** `<Partner Co.>` ("Partner") and `<BIII entity>` ("BIII").
**Term.** 3 months from the effective date, then month-to-month unless either party gives 30 days' notice.
**What BIII provides during the pilot:**
- The `till_trust` verdict API (MCP): reputation + standing + on-chain settlement → one
  fail-closed verdict (`unsafe` / `unknown` / `trusted` / `settled`).
- Known-bad screening — the MainStreet oracle flags OFAC/scam-list addresses and BIII folds that BLOCK
  into the verdict (the list lives in MainStreet, not BIII; BIII does no screening itself).
- The provable till-roll: human-readable receipts + a day-roll re-checkable on Base.
- Up to **5,000 verdicts / month + unlimited receipts** (overage billed at list — see §Fees).
- White-label headers/branding on request; a shared Slack/email channel for integration support.

**What BIII does NOT do (by construction):** hold any key, move or custody any funds, or act as a
money transmitter. The Partner's (or their merchant's) own wallet signs; the chain decides "paid."

**Fees.** **$`<750>` / month**, invoiced monthly, `<net-15>`. Includes the quota above. Overage:
$0.25 / verdict, $0.03 / receipt. No setup fee for the pilot. (List pricing in PRICING.md; pilot is
framed ~60% off list.)

**Data & privacy.** BIII processes counterparty **addresses** and public on-chain data only — no PII,
no fund flow. Reputation inputs are advisory (oracle-reported), never a guarantee or financial advice.

**Success criteria (agree up front).** e.g. `<N verdicts served, p95 latency < X ms, zero known-bad
address returned as "trusted", Partner integrates in < 2 weeks>`. If criteria are met, convert to the
standard license (from $3,000/mo white-label) at `<agreed>` terms.

**Nature of this document.** A pilot ordering document, not investment/financial advice. No exclusivity,
no partnership or agency is created. Either party may walk at the end of the term.

**Signatures.** `<Partner>` ______________________  `<BIII>` ______________________  Date __________

---

## 3. The live demo script (what to actually show in the call)

1. **The scammer test.** Ask them for any address they distrust (or use a known OFAC/drainer address).
   Run `till_vet_merchant` / `till_trust` → **BLOCK / unsafe** (MainStreet flags the address; the verdict
   folds its BLOCK — MainStreet's list is the source, BIII does not attribute a specific list).
   *This is the moment — the product passes the sceptical test.*
2. **A clean merchant.** Run a normal address → the composed verdict + what each vertex contributed.
3. **A real charge → receipt.** `till_create_charge` → the EIP-681 QR → (optionally pay a few cents of
   USDC) → `till_check_payment` verifies field-for-field → `till_receipt` → the bon-de-caisse + the
   Basescan link anyone can re-check.
4. **The invoice path.** `till_create_invoice` → same rail, same registry, a Web2-style bill.
5. **The books.** The day-roll summary — every line re-checkable, one txHash counted once.

*Close on: "same registry for a café, a Web2 invoice, or an agent paying an agent — under your brand,
non-custodial. Pilot's $750/mo, 3 months, and I can have you integrated this week."*
