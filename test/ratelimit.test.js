'use strict';
// per-IP rate limiter — allow under the cap, block over it, distinct IPs separate, window resets.
// Run: node test/ratelimit.test.js
const assert = require('node:assert');
const { rateLimit } = require('../lib/ratelimit');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const reqFrom = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: {} });
const now = 1_000_000;

t('under the cap is allowed', () => {
  const r = reqFrom('1.1.1.1');
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(r, now, { max: 5, windowMs: 60000 }).allowed, true);
});
t('over the cap is blocked', () => {
  const r = reqFrom('2.2.2.2');
  for (let i = 0; i < 5; i++) rateLimit(r, now, { max: 5, windowMs: 60000 });
  assert.equal(rateLimit(r, now, { max: 5, windowMs: 60000 }).allowed, false);
});
t('a different IP has its own bucket', () => {
  const r = reqFrom('3.3.3.3');
  assert.equal(rateLimit(r, now, { max: 1, windowMs: 60000 }).allowed, true);
  assert.equal(rateLimit(r, now, { max: 1, windowMs: 60000 }).allowed, false);
  assert.equal(rateLimit(reqFrom('4.4.4.4'), now, { max: 1, windowMs: 60000 }).allowed, true);
});
t('the window resets after it elapses', () => {
  const r = reqFrom('5.5.5.5');
  assert.equal(rateLimit(r, now, { max: 1, windowMs: 1000 }).allowed, true);
  assert.equal(rateLimit(r, now, { max: 1, windowMs: 1000 }).allowed, false);
  assert.equal(rateLimit(r, now + 2000, { max: 1, windowMs: 1000 }).allowed, true);
});

console.log(`\nratelimit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
