'use strict';
// gitlawb × BIII trust composition — offline, pure. Run: node test/gitlawb-trust.test.js
const assert = require('node:assert');
const { combineAgentTrust, requiredTrust } = require('../lib/gitlawb-trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII × gitlawb — reputation composes with safe-to-pay, fail-closed:');

t('a BIII block is DECISIVE — no gitlawb reputation buys back a denylisted address', () => {
  const r = combineAgentTrust({ biiiAllowed: false, biiiDecision: 'deny', gitlawbTrust: 0.99, amountUsd: '10' });
  assert.equal(r.release, false);
  assert.equal(r.tier, 'blocked');
  assert.match(r.reason, /cannot override/);
});

t('amount-scaled bar: small payout releases on a FRESH agent (0.05); large payout does NOT', () => {
  const small = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.05, amountUsd: '50' });
  assert.equal(small.release, true, '$50 to a fresh but BIII-clear agent is fine');
  assert.equal(small.needed, 0);
  const big = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.05, amountUsd: '250' });
  assert.equal(big.release, false, '$250 needs standing (0.2) the fresh 0.05 agent lacks');
  assert.equal(big.tier, 'caution');
  assert.equal(big.needed, 0.2);
});

t('a reputable agent (0.7) clears a large payout; the 1000+ bar is 0.5', () => {
  assert.equal(requiredTrust('1000'), 0.5);
  const r = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.7, amountUsd: '2000' });
  assert.equal(r.release, true);
  assert.equal(r.tier, 'reputable');
  // exactly at the bar releases; a hair under does not
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.5, amountUsd: '1000' }).release, true);
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.49, amountUsd: '1000' }).release, false);
});

t('unavailable reputation → only sub-$100 payouts proceed (fail-closed on the missing signal)', () => {
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: null, amountUsd: '99' }).release, true);
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: undefined, amountUsd: '100' }).release, false);
  // a garbage / negative score is treated as unavailable, not as a real 0
  const bad = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: -1, amountUsd: '500' });
  assert.equal(bad.gitlawbTrust, null);
  assert.equal(bad.release, false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
