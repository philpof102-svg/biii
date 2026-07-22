'use strict';
// Vendor parity — the vendored trust-core (vendor/trust-core, shipped so BIII deploys self-contained) must
// stay byte-identical to the upstream sibling repo. This test ASSERTS parity WHEN the sibling is present
// (dev machine), and is a NO-OP when it isn't (a standalone PaaS checkout / CI) — so drift is caught locally
// without ever breaking a self-contained deploy. Run: node test/vendor-parity.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let pass = 0, fail = 0, skip = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const VENDOR = path.join(__dirname, '..', 'vendor', 'trust-core');
const SIBLING = path.join(__dirname, '..', '..', 'trust-core');   // the upstream repo, dev-only
const FILES = ['index.js', 'score.js'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('BIII vendor parity — the vendored trust-core matches upstream (when present):');

t('the vendored trust-core loads and exposes verdict() (the deploy-critical require path)', () => {
  const TC = require('trust-core');   // resolves to vendor/trust-core via the file: dep — MUST work in prod
  assert.equal(typeof TC.verdict, 'function', 'vendored trust-core must expose verdict()');
});

if (fs.existsSync(SIBLING)) {
  t('vendored index.js + score.js are byte-identical to the upstream sibling (no drift)', () => {
    for (const f of FILES) {
      const v = path.join(VENDOR, f), s = path.join(SIBLING, f);
      assert.ok(fs.existsSync(v), 'vendored ' + f + ' exists');
      assert.equal(sha(v), sha(s), f + ' drifted from upstream — re-copy per vendor/trust-core/VENDORED.md');
    }
  });
} else {
  skip++;
  console.log('  ⊘ upstream sibling not present (standalone/CI checkout) — parity check skipped by design');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
