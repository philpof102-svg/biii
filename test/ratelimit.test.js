'use strict';
// per-IP rate limiter — allow under the cap, block over it, distinct IPs separate, window resets.
// Run: node test/ratelimit.test.js
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { rateLimit, clientIdentity } = require('../lib/ratelimit');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const reqFrom = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: {} });
const now = 1_000_000;

t('under the cap is allowed', () => {
  const r = reqFrom('1.1.1.1');
  for (let i = 0; i < 3; i++) assert.strictEqual(rateLimit(r, now, { max: 5, windowMs: 60000 }).allowed, true);
});
t('over the cap is blocked', () => {
  const r = reqFrom('2.2.2.2');
  for (let i = 0; i < 5; i++) rateLimit(r, now, { max: 5, windowMs: 60000 });
  assert.strictEqual(rateLimit(r, now, { max: 5, windowMs: 60000 }).allowed, false);
});
t('a different IP has its own bucket', () => {
  const r = reqFrom('3.3.3.3');
  assert.strictEqual(rateLimit(r, now, { max: 1, windowMs: 60000 }).allowed, true);
  assert.strictEqual(rateLimit(r, now, { max: 1, windowMs: 60000 }).allowed, false);
  assert.strictEqual(rateLimit(reqFrom('4.4.4.4'), now, { max: 1, windowMs: 60000 }).allowed, true);
});
t('the window resets after it elapses', () => {
  const r = reqFrom('5.5.5.5');
  assert.strictEqual(rateLimit(r, now, { max: 1, windowMs: 1000 }).allowed, true);
  assert.strictEqual(rateLimit(r, now, { max: 1, windowMs: 1000 }).allowed, false);
  assert.strictEqual(rateLimit(r, now + 2000, { max: 1, windowMs: 1000 }).allowed, true);
});

// ── an unread client must not be confusable with a client that SAID something ──────────────────────
// Measured 2026-08-06 on the version before this: clientIp() returned the bare string 'unknown' for BOTH
// "we could not read the caller" and "the caller sent x-forwarded-for: unknown", so one spoofed request
// burned the shared bucket for every caller whose IP we genuinely cannot read.
t('clientIdentity reports the SOURCE, three states, never collapsed', () => {
  assert.deepStrictEqual(clientIdentity(reqFrom('1.2.3.4')), { id: '1.2.3.4', source: 'xff', key: 'xff:1.2.3.4' });
  assert.deepStrictEqual(clientIdentity({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }),
    { id: '9.9.9.9', source: 'socket', key: 'sock:9.9.9.9' });
  assert.deepStrictEqual(clientIdentity({ headers: {}, socket: {} }),
    { id: null, source: 'unreadable', key: 'unreadable' });
});
t('a caller sending "unknown"/"unreadable" cannot enter the unread bucket', () => {
  // NB: an EMPTY x-forwarded-for is not in this list on purpose — that is the caller saying nothing, so
  // landing in the unread bucket is the correct answer for it. Only non-empty, caller-CHOSEN text applies.
  for (const spoof of ['unknown', 'unreadable', 'sock:9.9.9.9', 'null', '0']) {
    const got = clientIdentity(reqFrom(spoof));
    assert.notStrictEqual(got.key, 'unreadable', `x-forwarded-for: ${JSON.stringify(spoof)} reached the unread bucket`);
  }
});
t('a spoofed "unknown" cannot deny a genuinely unread caller', () => {
  const opts = { max: 1, windowMs: 60000 };
  const spoofer = reqFrom('unknown');
  assert.strictEqual(rateLimit(spoofer, now, opts).allowed, true);
  assert.strictEqual(rateLimit(spoofer, now, opts).allowed, false);      // the spoofer burns its OWN bucket
  const victim = rateLimit({ headers: {}, socket: {} }, now, opts);
  assert.strictEqual(victim.allowed, true, 'an unread caller was denied by someone else header text');
  assert.strictEqual(victim.identitySource, 'unreadable');
});
t('an empty or whitespace x-forwarded-for falls through to the socket, not to unread', () => {
  for (const blank of ['', '   ', ' , 1.1.1.1']) {
    const who = clientIdentity({ headers: { 'x-forwarded-for': blank }, socket: { remoteAddress: '8.8.8.8' } });
    assert.strictEqual(who.source, 'socket');
    assert.strictEqual(who.key, 'sock:8.8.8.8');
  }
});
t('a request with no headers is unreadable, not a throw', () => {
  assert.strictEqual(clientIdentity({ socket: {} }).source, 'unreadable');
  assert.strictEqual(clientIdentity({}).source, 'unreadable');
  assert.strictEqual(rateLimit({}, now, { max: 5, windowMs: 60000 }).allowed, true);
});
t('clientIp is no longer exported — a stale consumer must fail loudly', () => {
  assert.strictEqual(require('../lib/ratelimit').clientIp, undefined);
});

// ── a misspelt tuning knob must not silently become NaN ────────────────────────────────────────────
// Measured 2026-08-06 before the fix: BIII_RL_MAX=abc denied EVERY request from the first one, forever,
// and the 429 body carried `limit: null`. BIII_RL_WINDOW_MS=1min made the window unable to ever elapse.
const RL = path.join(__dirname, '..', 'lib', 'ratelimit.js').replace(/\\/g, '/');
const under = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
  `const {rateLimit}=require(${JSON.stringify(RL)});` +
  `const r={headers:{'x-forwarded-for':'1.1.1.1'},socket:{}};rateLimit(r,1e6);` +
  `console.log(JSON.stringify(rateLimit(r,1e6)));`
], { env: { ...process.env, ...env }, encoding: 'utf8' }));

t('a sane env is read, and it actually travels (the witness)', () => {
  const r = under({ BIII_RL_MAX: '7', BIII_RL_WINDOW_MS: '30000' });
  assert.strictEqual(r.limit, 7);
  assert.strictEqual(r.retryAfterSec, 30);
  assert.deepStrictEqual(r.configWarnings, []);                          // ran, rejected nothing
});
t('an unparseable env falls back to the default AND says so', () => {
  const r = under({ BIII_RL_MAX: 'abc' });
  assert.strictEqual(r.limit, 120, 'NaN limit — a typo took the whole surface down');
  assert.strictEqual(r.allowed, true, 'a typo in a knob denied a caller under the cap');
  assert.strictEqual(r.configWarnings.length, 1);
  assert.match(r.configWarnings[0], /BIII_RL_MAX="abc".*positive finite/);
});
t('an unparseable window keeps the window finite and elapsing', () => {
  const r = under({ BIII_RL_WINDOW_MS: '1min' });
  assert.strictEqual(Number.isFinite(r.retryAfterSec), true, 'Retry-After: NaN would go out on the wire');
  assert.strictEqual(r.retryAfterSec, 60);
  assert.strictEqual(r.configWarnings.length, 1);
});
t('zero and negative knobs are rejected too, not obeyed', () => {
  assert.strictEqual(under({ BIII_RL_MAX: '0' }).limit, 120);            // max:0 would deny everyone
  assert.strictEqual(under({ BIII_RL_WINDOW_MS: '-5' }).retryAfterSec, 60);
});
t('a NaN option override falls back instead of poisoning the verdict', () => {
  const r = rateLimit(reqFrom('6.6.6.6'), now, { max: NaN, windowMs: NaN });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.limit, 120);
  assert.strictEqual(Number.isFinite(r.retryAfterSec), true);
});

console.log(`\nratelimit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
