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

/* ── L'ORDRE TESTAIT LA PRESENCE, PAS LA LISIBILITE ─────────────────────────────────────────────────
 * `const ordered = paidAt != null && committedAt != null` puis `Number(committedAt) >= Number(paidAt)`.
 * Avec des horodatages ISO — le format le plus naturel qu'un appelant puisse envoyer — `Number()` rend
 * NaN: `ordered` valait quand meme true, `NaN >= NaN` etait false, les DEUX branches etaient sautees, et
 * on tombait sur le `served` final, celui qui affirme le plus.
 *
 * Mesure du 2026-07-28, engagement APRES le paiement:
 *   paidAt='2026-07-28T09:00:00Z', committedAt='2026-07-28T10:00:00Z'
 *   -> verdict `served`, phrase: « a commitment recorded at 10:00:00Z, BEFORE the payment at 09:00:00Z »
 *
 * Elle affirmait « avant » EN IMPRIMANT deux dates qui disent le contraire. Ce n'est pas une reserve
 * manquante: c'est une affirmation fausse, contredite par sa propre preuve citee. */
const engagement = commit({ jobId: 'job-ordre', deliverable: 'livrable' });
const juger = (paidAt, committedAt) =>
  assessDelivery({ commitment: engagement, received: 'livrable', paidAt, committedAt });

t('un ordre ISO ne produit plus la phrase forte', () => {
  const r = juger('2026-07-28T09:00:00Z', '2026-07-28T10:00:00Z');
  assert.doesNotMatch(r.reason, /before the payment/,
    'la phrase ne doit plus affirmer « avant » sur des valeurs qu elle n a pas lues');
  assert.match(r.reason, /could not read/);
  assert.equal(r.limits.length, 2, 'la reserve d ordre doit revenir');
});

t('« ordre absent » et « ordre illisible » ne disent PAS la meme chose', () => {
  const absent = juger(null, null);
  const illisible = juger('2026-07-28T09:00:00Z', '2026-07-28T10:00:00Z');
  assert.equal(absent.verdict, illisible.verdict, 'meme verdict — c est la RAISON qui doit differer');
  assert.notEqual(absent.reason, illisible.reason);
  assert.match(absent.reason, /NOT supplied/);
  assert.match(illisible.reason, /SUPPLIED but is not readable/);
});

t('un HASH ne se fait plus comparer comme une date', () => {
  /* `Number('0x' + 'ab'.repeat(32))` vaut 7,76e76 — fini, donc accepte avant, puis compare. Deux hashes
   * produisaient un `commitment_too_late` dont la phrase citait « 0xdef vs 0xabc » comme des instants. */
  const r = juger('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32));
  assert.equal(r.verdict, 'served');
  assert.equal(r.limits.length, 2);
  assert.match(r.reason, /not readable as a number/);
});

t('LES DEUX BORNES: l hexadecimal LEGITIME passe toujours', () => {
  /* Un numero de bloc circule en `0x…` sur tout l ecosysteme. Le rejeter casserait un appelant juste —
   * un fail-closed pousse trop loin cesse d informer. La borne est MAX_SAFE_INTEGER: un bloc tient tres
   * largement en dessous, un hash de 32 octets est 60 ordres de grandeur au-dessus. */
  const r = juger('0x1406f40', '0x1406f00');            // bloc 21000000 paye, engage un peu avant
  assert.equal(r.verdict, 'served');
  assert.equal(r.limits.length, 1, 'ordre LU: pas de reserve supplementaire');
  assert.match(r.reason, /before the money moved/);
});

t('les chemins numeriques d origine ne bougent pas', () => {
  assert.equal(juger(1785240000000, 1785239000000).verdict, 'served');
  assert.equal(juger(1785239000000, 1785240000000).verdict, 'commitment_too_late');
});

t('les quatre situations sont DISTINGUABLES', () => {
  /* Sans ce cas, aplatir deux etats l un sur l autre resterait vert tant qu ils ne se croisent pas. */
  const sig = (r) => r.verdict + ':' + r.limits.length + ':' + /readable/.test(r.reason);
  const vus = new Set([juger(1785240000000, 1785239000000), juger(1785239000000, 1785240000000),
    juger(null, null), juger('2026-07-28T09:00:00Z', '2026-07-28T10:00:00Z')].map(sig));
  assert.equal(vus.size, 4);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
