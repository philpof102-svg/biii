'use strict';
// DISCLAIMER constant — unit test (matches project test pattern)
const assert = require('node:assert');
const { DISCLAIMER } = require('../lib/disclaimer');

let pass = 0, fail = 0;
const t = (n, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + n); }
  catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
};

console.log('DISCLAIMER constant:');

t('exists and is a non-empty string', () => {
  assert.equal(typeof DISCLAIMER, 'string');
  assert.ok(DISCLAIMER.length > 20);
});

t('contains "non-custodial"', () => {
  assert.ok(DISCLAIMER.toLowerCase().includes('non-custodial'));
});

t('contains "not a money transmitter" and "bank"', () => {
  const lower = DISCLAIMER.toLowerCase();
  assert.ok(lower.includes('not a money transmitter'));
  assert.ok(lower.includes('bank'));
});

t('contains "advisory" (verdict posture)', () => {
  assert.ok(DISCLAIMER.toLowerCase().includes('advisory'));
});

t('contains "no chargeback" (settlement finality)', () => {
  assert.ok(DISCLAIMER.toLowerCase().includes('no chargeback'));
});

t('denies being KYC/AML/compliance (negation present)', () => {
  const lower = DISCLAIMER.toLowerCase();
  assert.ok(lower.includes('not kyc/aml'));
  assert.ok(lower.includes('not sanctions compliance'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
