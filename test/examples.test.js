'use strict';
// BIII partnership examples — smoke + invariant test. These runnable proofs (buzz + gitlawb) are what we
// show a partner; they must not silently rot when a lib changes. We capture each example's output and
// assert the load-bearing claims actually happened: the identity bound, the sanctioned counterparty was
// BLOCKED, and the receipt settled. Pure + offline. Run: node test/examples.test.js
const assert = require('node:assert');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// run an example's main() with console.log captured — the example is a demo, so its evidence IS its output.
function capture(modPath) {
  const mod = require(modPath);
  const orig = console.log; const out = [];
  console.log = (...a) => out.push(a.join(' '));
  try { mod.main(); } finally { console.log = orig; }
  return out.join('\n');
}

console.log('BIII partnership examples (smoke + invariants, offline):');

t('buzz-agent-pays: npub binds, sanctioned merchant is refused, receipt settles', () => {
  const out = capture('../examples/buzz-agent-pays.js');
  assert.match(out, /bound: true/, 'the npub↔Base binding resolved');
  assert.match(out, /REFUSED|BLOCK/, 'a known-bad address was refused (the brake fired)');
  assert.match(out, /paid=true/, 'the receipt settled');
  assert.doesNotMatch(out, /demo error/, 'the demo ran clean');
});

t('gitlawb-agent-pays: a did:key binds (npub:null), release is BLOCKED for a sanctioned claimant', () => {
  const out = capture('../examples/gitlawb-agent-pays.js');
  assert.match(out, /bound: true/, 'the did:key↔Base binding resolved (generalized bridge, end-to-end)');
  assert.match(out, /"npub":null/, 'this is the DID path — no npub present');
  assert.match(out, /RELEASE BLOCKED/, 'the escrow release was blocked for the sanctioned claimant — the whole point');
  assert.match(out, /paid=true/, 'the clean payout settled with a re-verifiable receipt');
  assert.doesNotMatch(out, /demo error/, 'the demo ran clean');
});

t('both examples agree on the non-custodial invariant (BIII holds no key)', () => {
  const buzz = capture('../examples/buzz-agent-pays.js');
  const glb = capture('../examples/gitlawb-agent-pays.js');
  assert.match(buzz, /BIII holds no key|moves no funds/i);
  assert.match(glb, /BIII holds no key|releases no funds/i);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
