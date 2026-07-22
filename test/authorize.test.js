'use strict';
// BIII spend authorization (Skyfire Programmable Payment) — a charge executes only inside what the agent's
// OWNER signed off: token, recipient, per-charge max, AND the cumulative cap. Fail-closed. Pure + offline.
// Run: node test/authorize.test.js
const assert = require('node:assert');
const { authorizeCharge } = require('../lib/skyfire');
const T = require('../lib/till');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const MERCHANT = '0x' + 'ca'.repeat(20), OTHER = '0x' + 'bb'.repeat(20);
const charge = (usd, to = MERCHANT) => T.createCharge({ to, amountUsd: usd, nowMs: Date.now() });
const auth = (over = {}) => ({ iss: 'skyfire', sub: 'agent:bot', token: 'USDC', chainId: 8453,
  maxPerChargeMicro: '50000000' /* $50 */, cumulativeCapMicro: '200000000' /* $200 */, verified: true, ...over });

console.log('BIII spend authorization (a charge only executes inside what the owner signed):');

t('a charge within the per-charge max and the cap → authorized, with the remaining computed', () => {
  const r = authorizeCharge(auth(), charge('12.50'), { spentMicro: '0' });
  assert.equal(r.authorized, true);
  assert.equal(r.spentAfterMicro, '12500000');
  assert.equal(r.remainingMicro, '187500000', '$200 cap − $12.50 = $187.50');
});

t('over the PER-CHARGE max → refused ($60 > $50 authorized)', () => {
  const r = authorizeCharge(auth(), charge('60'), { spentMicro: '0' });
  assert.equal(r.authorized, false);
  assert.match(r.reason, /per-charge max/);
});

t('THE DRAIN GUARD: small charges cannot beat the cap by accumulation', () => {
  // $190 already spent, a $12.50 charge would bring it to $202.50 > $200 cap → refused
  const r = authorizeCharge(auth(), charge('12.50'), { spentMicro: '190000000' });
  assert.equal(r.authorized, false);
  assert.match(r.reason, /cumulative|cap/i);
  assert.equal(r.spentAfterMicro, '202500000', 'shows what it WOULD have become');
  // but a $10 charge fits exactly under the remaining $10
  assert.equal(authorizeCharge(auth(), charge('10'), { spentMicro: '190000000' }).authorized, true);
});

t('unverified authorization → refused (a signed authorization is required, a claim is not one)', () => {
  assert.equal(authorizeCharge(auth({ verified: false }), charge('5'), {}).authorized, false);
  assert.match(authorizeCharge(auth({ verified: false }), charge('5'), {}).reason, /not verified/i);
});

t('an EXPIRED authorization → refused', () => {
  const r = authorizeCharge(auth({ exp: Math.floor(Date.now() / 1000) - 10 }), charge('5'), {});
  assert.equal(r.authorized, false);
  assert.match(r.reason, /expired/i);
});

t('recipient ALLOW-LIST is enforced: a charge to an un-allowed address is refused', () => {
  const a = auth({ allowedRecipients: [MERCHANT] });
  assert.equal(authorizeCharge(a, charge('5', MERCHANT), {}).authorized, true);
  assert.equal(authorizeCharge(a, charge('5', OTHER), {}).authorized, false);
  assert.match(authorizeCharge(a, charge('5', OTHER), {}).reason, /allow-list/i);
});

t('FAIL-OPEN CLOSED: a PRESENT-but-empty allow-list ([]) permits NO recipient, not "anyone" (audit)', () => {
  // an issuer who signs allowedRecipients:[] means "nobody" — treating it as "no restriction" was the fail-open
  const empty = authorizeCharge(auth({ allowedRecipients: [] }), charge('5', MERCHANT), {});
  assert.equal(empty.authorized, false);
  assert.match(empty.reason, /empty allow-list|permits NO recipient/i);
  // a present-but-non-array allow-list is a malformed restriction → also refused (not silently ignored)
  assert.equal(authorizeCharge(auth({ allowedRecipients: MERCHANT }), charge('5', MERCHANT), {}).authorized, false);
  assert.match(authorizeCharge(auth({ allowedRecipients: {} }), charge('5', MERCHANT), {}).reason, /not an array|malformed/i);
  // ABSENT allow-list is still fine — the caps bound spend (no recipient restriction intended)
  assert.equal(authorizeCharge(auth(), charge('5', OTHER), {}).authorized, true);
});

t('wrong token/chain is refused on either side (BIII is USDC-on-Base)', () => {
  const wrongCharge = { ...charge('5'), token: '0xdead', chainId: 8453 };
  assert.equal(authorizeCharge(auth(), wrongCharge, {}).authorized, false);
  assert.equal(authorizeCharge(auth({ token: 'DAI' }), charge('5'), {}).authorized, false);
});

t('a JWT-form authorization is honored only when the caller attests the signature (opts.verified)', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = b64({ alg: 'ES256' }) + '.' + b64({ iss: 'skyfire', sub: 'agent:bot', token: 'USDC', chainId: 8453, maxPerChargeMicro: '50000000', cumulativeCapMicro: '200000000' }) + '.sig';
  assert.equal(authorizeCharge(jwt, charge('12.50'), { verified: true }).authorized, true, 'verified JWT → authorized');
  assert.equal(authorizeCharge(jwt, charge('12.50'), {}).authorized, false, 'unverified JWT → refused (claim, not authorization)');
  assert.equal(authorizeCharge('not.a.jwt.x', charge('5'), { verified: true }).authorized, false, 'unparseable → refused');
});

t('no cumulative cap set → per-charge limit still applies, remaining is null (unbounded total)', () => {
  const r = authorizeCharge(auth({ cumulativeCapMicro: null }), charge('40'), { spentMicro: '999999999' });
  assert.equal(r.authorized, true);
  assert.equal(r.remainingMicro, null);
});

// ── ADVERSARIAL (audit 2026-07-22): a MALFORMED limit must FAIL-CLOSED, not silently become "no limit" ──
t('FAIL-OPEN CLOSED: a present-but-unparseable cap/max ("1e999"/"abc"/decimal) is REFUSED, not ignored', () => {
  const huge = () => T.createCharge({ to: MERCHANT, amountMicro: '999999999999999', nowMs: Date.now() }); // ~$1B
  // the security property for EVERY malformed/edge limit is the same: NEVER unlimited spend.
  for (const bad of ['1e999', 'abc', '50000000.5', '0x50', '', 'Infinity', '1_000']) {
    const r = authorizeCharge(auth({ cumulativeCapMicro: bad, maxPerChargeMicro: bad }), huge(), { spentMicro: '0' });
    assert.equal(r.authorized, false, 'a "' + bad + '" limit must not become unlimited spend');
  }
  // the truly-unparseable ones (BigInt THROWS: scientific / letters / decimals) fail-closed as "malformed"
  for (const bad of ['1e999', 'abc', '50000000.5']) {
    assert.match(authorizeCharge(auth({ cumulativeCapMicro: bad }), huge(), {}).reason, /malformed|not a valid integer/i, '"' + bad + '" is malformed');
  }
  // whitespace is fine — BigInt trims it (" 50000000 " parses)
  assert.equal(authorizeCharge(auth({ cumulativeCapMicro: ' 50000000 ', maxPerChargeMicro: ' 50000000 ' }), charge('10'), {}).authorized, true);
});

t('FAIL-OPEN CLOSED: an authorization with NO limit at all is REFUSED (unbounded is a footgun)', () => {
  const r = authorizeCharge({ token: 'USDC', chainId: 8453, verified: true }, charge('40'), {});
  assert.equal(r.authorized, false);
  assert.match(r.reason, /neither a per-charge max nor a cumulative cap|unbounded/i);
  // ...unless the owner DELIBERATELY opts in
  assert.equal(authorizeCharge({ token: 'USDC', chainId: 8453, verified: true, unlimited: true }, charge('40'), {}).authorized, true);
});

t('FAIL-OPEN CLOSED: a garbage or negative spentMicro is REFUSED (cannot trust the cumulative)', () => {
  const a = auth({ cumulativeCapMicro: '200000000' });
  assert.equal(authorizeCharge(a, charge('10'), { spentMicro: 'abc' }).authorized, false);
  assert.equal(authorizeCharge(a, charge('10'), { spentMicro: '-5000000' }).authorized, false);
  assert.match(authorizeCharge(a, charge('10'), { spentMicro: '-5000000' }).reason, /non-negative|running total/i);
  // absent spentMicro still defaults to 0 (a fresh authorization) — that path stays valid
  assert.equal(authorizeCharge(a, charge('10'), {}).authorized, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
