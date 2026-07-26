#!/usr/bin/env node
'use strict';
/**
 * The regression guard for a fail-open that shipped and was measured, not imagined.
 *
 * `rugsignals.js` scores every owner-gated danger conditionally on the owner still existing — that is the
 * module's central idea and the reason it produces less noise than a flag list. The check for it was a boolean,
 * and it folded the MISSING field into "not live":
 *
 *     if (!o || o === '0x000…0') return false;
 *
 * So a token whose owner the index simply did not report was scored exactly like a token whose owner had
 * provably renounced, and its armed flags were moved to `defused` under the message "(defused by renounced
 * ownership)" — a sentence about something never observed. Absence of evidence read as evidence of safety.
 *
 * Measured on one flag set (mintable + pausable + slippage-modifiable): live owner -> rug_ready with 3 armed;
 * renounced -> unknown with 3 defused; ABSENT -> unknown with 3 defused. Identical to renounced.
 *
 * It surfaced while adding the Robinhood chain, whose GoPlus response has no `owner_address` at all — that
 * whole chain would have read quiet however armed a token was. It was never chain-specific: any token anywhere
 * with a missing owner field had the same hole.
 */
const assert = require('node:assert');
const { assessRugFields, ownerState } = require('../lib/rugsignals');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const ARMED_FLAGS = { is_mintable: '1', transfer_pausable: '1', slippage_modifiable: '1',
  holder_count: '1500', lp_holder_count: '6', is_honeypot: '0' };
const withOwner = (o) => Object.assign({}, ARMED_FLAGS, o === undefined ? {} : { owner_address: o });

console.log('the three owner states:');
t('a live owner reads live', () => assert.equal(ownerState({ owner_address: '0x1111111111111111111111111111111111111111' }), 'live'));
t('the zero address reads renounced', () => assert.equal(ownerState({ owner_address: '0x0000000000000000000000000000000000000000' }), 'renounced'));
t('the dead address reads renounced', () => assert.equal(ownerState({ owner_address: '0x000000000000000000000000000000000000dEaD' }), 'renounced'));
t('a MISSING field reads unknown, not renounced', () => assert.equal(ownerState({}), 'unknown'));
t('an empty string reads unknown', () => assert.equal(ownerState({ owner_address: '' }), 'unknown'));

console.log('\nwhat each state does to the same three dangerous flags:');
t('live owner -> rug_ready, flags ARMED', () => {
  const r = assessRugFields(withOwner('0x1111111111111111111111111111111111111111'));
  assert.equal(r.verdict, 'rug_ready');
  assert.ok(r.armed.length >= 1, 'expected armed powers');
  assert.equal(r.defused.length, 0);
});
t('renounced owner -> flags DEFUSED, and that claim is true', () => {
  const r = assessRugFields(withOwner('0x0000000000000000000000000000000000000000'));
  assert.equal(r.armed.length, 0);
  assert.ok(r.defused.length >= 1, 'expected defused powers');
  assert.notEqual(r.verdict, 'rug_ready');
});
t('THE FIX: unknown owner keeps them as FLAGS — never defused, never armed', () => {
  const r = assessRugFields(withOwner(undefined));
  assert.equal(r.ownerState, 'unknown');
  assert.equal(r.defused.length, 0, 'a missing owner must NOT defuse anything');
  assert.equal(r.armed.length, 0, 'a missing owner must NOT arm anything either');
  assert.ok(r.flags.length >= 3, 'the dangers must survive as flags, got ' + r.flags.length);
});
t('and three surviving flags still escalate past caution', () => {
  const r = assessRugFields(withOwner(undefined));
  assert.equal(r.verdict, 'high_risk', 'an unreadable owner over three dangers must not read quiet');
});
t('the reason says the owner could not be read, and never says renounced', () => {
  const r = assessRugFields(withOwner(undefined));
  assert.match(r.reason, /could NOT be read|NOT reported/i);
  assert.doesNotMatch(r.reason, /renounced/i);
});

console.log('\nnon-regression: the case this whole design was built from:');
t('BRETT — renounced owner, modifiable tax, unlocked LP — is still not a rug', () => {
  const r = assessRugFields({ owner_address: '0x0000000000000000000000000000000000000000',
    slippage_modifiable: '1', is_mintable: '0', holder_count: '70000', lp_holder_count: '12', is_honeypot: '0' });
  assert.notEqual(r.verdict, 'rug_ready');
  assert.equal(r.armed.length, 0);
});
t('an ungated honeypot is armed regardless of who owns it', () => {
  const r = assessRugFields({ is_honeypot: '1' });          // no owner field at all
  assert.equal(r.verdict, 'rug_ready');
  assert.ok(r.armed.some((a) => /honeypot/i.test(a)));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
