'use strict';
// BIII local classifier — proves BIII computes MainStreet's safe-to-pay verdict on THIS node via trust-core
// (pure, zero-oracle), and that it is surfaced as a SEPARATE lens that never contaminates the trust triangle.
// Pure + offline (no network). Run: node test/local-classifier.test.js
const assert = require('node:assert');
const { localClassify } = require('../bin/biii-mcp.js');
const { repVertex, assessTriangle } = require('../lib/trust');
const knownBad = require('../data/known-bad.json');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const KNOWN_BAD_ADDR = knownBad.addresses[0];
const CLEAN_ADDR = '0x1111111111111111111111111111111111111111';   // not on any list

console.log('BIII local classifier (trust-core on this node, no oracle):');

t('trust-core is wired (localClassify returns a verdict, not null)', () => {
  const v = localClassify(CLEAN_ADDR);
  assert.ok(v, 'localClassify must resolve trust-core (require(trust-core) or the sibling path)');
  assert.ok(v.disclosure.includes('LOCAL CLASSIFIER'));
});

t('a KNOWN-BAD address → BLOCK locally, with zero oracle (the floor, computed by the classifier)', () => {
  const v = localClassify(KNOWN_BAD_ADDR);
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.allowed, false);
  assert.equal(v.color, 'red');
});

t('a CLEAN address → PROCEED_LOW_VALUE (green-unverified): honest "unknown-but-not-bad", never confident PROCEED', () => {
  const v = localClassify(CLEAN_ADDR);
  assert.equal(v.decision, 'PROCEED_LOW_VALUE');
  assert.equal(v.reasonShort, 'green-unverified');
  assert.equal(v.allowed, true);   // allowed for LOW value only — the honest local degrade
});

t('the URL lens is genuinely NEW local power: a phishing/admin endpoint flags red with no network', () => {
  // suspicious-tld + admin-path = 2 medium → yellow; add plain-http (high) → red. Address is clean; the
  // ENDPOINT is what is hostile — a signal BIII could not produce before (it needed no list membership).
  const v = localClassify(CLEAN_ADDR, { resourceUrl: 'http://pay.sketchy-domain.zzz/admin/drain' });
  assert.equal(v.color, 'red');
  assert.ok(v.flags.some((f) => f.key === 'http-not-https'));
  assert.ok(v.flags.some((f) => f.key === 'admin-path'));
});

t('THE COMPOSITION TRAP (why the lens stays separate): folding the local verdict into repVertex manufactures false "safe"', () => {
  const v = localClassify(CLEAN_ADDR);   // { decision:'PROCEED_LOW_VALUE', ... } — note: NO score field
  assert.equal(v.score, undefined, 'the lens carries no behavioral score — that needs the indexer');
  // Feeding the lens object's shape into the reputation vertex: no score ⇒ Number(undefined)=NaN ⇒ the
  // score-floor is skipped ⇒ an explicit PROCEED reads as SAFE. This is the exact false-trusted we avoid.
  const rep = repVertex({ decision: v.decision });
  assert.equal(rep.status, 'safe', 'PROCEED_LOW_VALUE with no score reads as SAFE in repVertex — the trap');
  const tri = assessTriangle({ reputation: { decision: v.decision }, standing: null, settlement: null });
  assert.equal(tri.trust, 'trusted');
  assert.equal(tri.payable, true, 'folding it in would manufacture a false payable on an unobserved address — hence it stays a SEPARATE lens');
});

t('CONTROL: the ACTUAL wiring keeps the triangle honest — a clean, unobserved address with the oracle absent is UNKNOWN, not trusted', () => {
  // mirrors biii-mcp till_trust: reputation fed to the triangle is null when not-locally-blocked and no oracle
  const tri = assessTriangle({ reputation: null, standing: null, settlement: null });
  assert.equal(tri.trust, 'unknown');
  assert.equal(tri.payable, false);
});

t('a known-bad address STILL blocks the reputation path (the floor is independent of trust-core)', () => {
  // the till_trust reputation input on a known-bad address is { decision:'BLOCK' } — unsafe regardless of the lens
  const tri = assessTriangle({ reputation: { decision: 'BLOCK', score: null }, standing: null, settlement: null });
  assert.equal(tri.trust, 'unsafe');
  assert.equal(tri.payable, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
