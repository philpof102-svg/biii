#!/usr/bin/env node
'use strict';
/**
 * The truth table for the question after "safe to pay": can the buyer prove it was SERVED?
 *
 * The rows that matter are the two nobody else models. `commitment_too_late` is the attack this whole thing
 * exists to catch — a seller who publishes the hash AFTER the funds clear can publish the hash of whatever it
 * eventually sent, so a match there proves nothing about prior existence and must not read as `served`. And
 * `unverifiable` is the state almost every agent transaction is in today: a verifier that reports the same
 * thing for a broken promise and an absent promise tells the buyer nothing it can act on.
 */
const assert = require('node:assert');
const { digest, commit, assessDelivery } = require('../lib/delivery');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const WORK = 'the research report the buyer paid for, byte for byte';

console.log('the digest:');
t('deterministic', () => assert.equal(digest(WORK), digest(WORK)));
t('one changed byte changes it', () => assert.notEqual(digest(WORK), digest(WORK + ' ')));
t('buffer and string agree', () => assert.equal(digest(Buffer.from(WORK, 'utf8')), digest(WORK)));

console.log('\ncommitting:');
t('a commitment must name its job', () => assert.throws(() => commit({ deliverable: WORK })));
t('a commitment must have something to commit to', () => assert.throws(() => commit({ jobId: 'j1' })));
t('carries the hash and the algorithm', () => {
  const c = commit({ jobId: 'j1', deliverable: WORK });
  assert.equal(c.deliverableHash, digest(WORK));
  assert.equal(c.algorithm, 'sha256');
});

console.log('\nthe four verdicts:');
const c = commit({ jobId: 'j1', deliverable: WORK, at: 100 });

t('SERVED: bytes match and the commitment provably came first', () => {
  const r = assessDelivery({ commitment: c, received: WORK, committedAt: 100, paidAt: 200 });
  assert.equal(r.verdict, 'served');
  assert.equal(r.matches, true);
});

t('SUBSTITUTED: a commitment exists and the bytes do not match it', () => {
  const r = assessDelivery({ commitment: c, received: 'a cheaper thing sent after the funds cleared', committedAt: 100, paidAt: 200 });
  assert.equal(r.verdict, 'substituted');
  assert.equal(r.matches, false);
});

t('COMMITMENT_TOO_LATE: bytes match but the hash was published after payment', () => {
  const r = assessDelivery({ commitment: c, received: WORK, committedAt: 300, paidAt: 200 });
  assert.equal(r.verdict, 'commitment_too_late');
  assert.equal(r.matches, true, 'the bytes DO match — that is why this is the dangerous case');
});

t('...and equal timestamps are also too late (>=, not >)', () => {
  const r = assessDelivery({ commitment: c, received: WORK, committedAt: 200, paidAt: 200 });
  assert.equal(r.verdict, 'commitment_too_late');
});

t('UNVERIFIABLE: no commitment at all — the state of most of the market', () => {
  const r = assessDelivery({ received: WORK, paidAt: 200 });
  assert.equal(r.verdict, 'unverifiable');
  assert.equal(r.matches, null);
  assert.match(r.reason, /almost every agent transaction/i);
});

t('UNVERIFIABLE: a commitment but nothing received', () => {
  const r = assessDelivery({ commitment: c, committedAt: 100, paidAt: 200 });
  assert.equal(r.verdict, 'unverifiable');
  assert.equal(r.matches, null);
});

console.log('\nhonesty of the output:');
t('a match without ordering is served but SAYS prior existence is unproven', () => {
  const r = assessDelivery({ commitment: c, received: WORK });
  assert.equal(r.verdict, 'served');
  assert.match(r.reason, /prior existence is unproven/i);
  assert.ok(r.limits.length >= 2, 'the missing-ordering limit must be listed');
});
t('every verdict states that quality is not proven', () => {
  for (const r of [
    assessDelivery({ commitment: c, received: WORK, committedAt: 100, paidAt: 200 }),
    assessDelivery({ commitment: c, received: 'x', committedAt: 100, paidAt: 200 }),
    assessDelivery({ commitment: c, received: WORK, committedAt: 300, paidAt: 200 }),
    assessDelivery({ received: WORK }),
  ]) assert.ok(r.limits.some((l) => /says NOTHING about whether the work is any good/i.test(l)), 'missing the quality limit on ' + r.verdict);
});
t('a garbage deliverable verifies perfectly — the limit is real, not decorative', () => {
  const junk = commit({ jobId: 'j2', deliverable: 'lorem ipsum' });
  const r = assessDelivery({ commitment: junk, received: 'lorem ipsum', committedAt: 1, paidAt: 2 });
  assert.equal(r.verdict, 'served');
});

// NO process.exit here. The digest rows below were first appended AFTER an exit that sat on this line, which
// made seven new assertions unreachable while the run printed "15 passed" and returned 0. That is the SECOND
// time in one session — the first was test/agent-vet-gate.js, where the same mistake was fixed and the lesson
// written into a comment a few hours earlier. Knowing a trap and walking into it again is what an append does
// to you: the file grows at the bottom, and the bottom is past the exit. One exit, at the end of the file.

// ── the digest path: compare WITHOUT handing over the artifact ───────────────────────────────────────────
//
// Added when this module was wired into the server, because the first wiring FAKED it: the handler passed an
// empty buffer to mean "matches" and a one-byte buffer to mean "does not", so the module hashed a decoy and
// happened to land on the right verdict. That works by accident and breaks the day a real deliverable IS the
// single byte 0x01 — a correct-looking answer produced by the wrong computation, which is the failure this
// whole module is written against. `receivedHash` is a first-class parameter now, and the 0x01 row below is
// the regression that would have caught the hack.
const H = digest('the deliverable');

console.log('\ncomparing by digest, without sending the artifact:');
t('an identical digest is served', () => {
  assert.equal(assessDelivery({ commitment: { deliverableHash: H }, receivedHash: H, committedAt: 1, paidAt: 2 }).verdict, 'served');
});
t('a different digest is substituted', () => {
  assert.equal(assessDelivery({ commitment: { deliverableHash: H }, receivedHash: digest('something else'), committedAt: 1, paidAt: 2 }).verdict, 'substituted');
});
t('a digest without the 0x prefix still compares', () => {
  assert.equal(assessDelivery({ commitment: { deliverableHash: H }, receivedHash: H.slice(2), committedAt: 1, paidAt: 2 }).verdict, 'served');
});
t('a late commitment is still caught on the digest path', () => {
  assert.equal(assessDelivery({ commitment: { deliverableHash: H }, receivedHash: H, committedAt: 3, paidAt: 2 }).verdict, 'commitment_too_late');
});
t('neither bytes nor digest is unverifiable, not a mismatch', () => {
  assert.equal(assessDelivery({ commitment: { deliverableHash: H }, paidAt: 2 }).verdict, 'unverifiable');
});
t('THE TRAP: a deliverable that really is the byte 0x01 verifies correctly', () => {
  const one = Buffer.from([1]);
  assert.equal(assessDelivery({ commitment: { deliverableHash: digest(one) }, received: one }).verdict, 'served');
});
t('bytes win over a digest when both are supplied — a digest is a claim, bytes are the thing', () => {
  const r = assessDelivery({ commitment: { deliverableHash: H }, received: 'not the deliverable', receivedHash: H });
  assert.equal(r.verdict, 'substituted', 'the caller-supplied digest must not override what was actually handed over');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
