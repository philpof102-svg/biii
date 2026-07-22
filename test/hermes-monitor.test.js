'use strict';
// biii-monitor scan engine — the surveillance core (scanWatchlist) is fail-closed: it flags known-bad
// wallets + impersonation/unsafe tokens, and NEVER alerts on clean or merely-unverified items. Each flag
// carries a delegate task (Hermes task-delegation). Offline. Run: node test/hermes-monitor.test.js
const assert = require('node:assert');
const { scanWatchlist } = require('../hermes/agents/biii-monitor/scan');
const { loadScreen } = require('../lib/screen');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const BAD = '0x' + 'de'.repeat(20), CLEAN = '0x' + 'c1'.repeat(20);
const REAL = '0x' + '1a'.repeat(20);           // a genuine issuer token in the registry
const FLOOR = loadScreen({ asOf: '2026-07-22', sources: ['t'], addresses: [BAD] });
const REGISTRY = [{ issuer: 'Dinari', symbol: 'AAPL', name: 'Apple - Dinari', chainId: 8453, address: REAL, source: 'issuer: factory (verified)' }];

console.log('biii-monitor scan engine (surveillance, fail-closed, delegating):');

t('flags a KNOWN-BAD wallet and attaches a delegate task', () => {
  const r = scanWatchlist({ addresses: [BAD] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].verdict, 'known-bad');
  assert.match(r.flags[0].delegate, /trace.*counterpart/i, 'a follow-up is delegated, not just alerted');
});

t('flags an IMPERSONATION token (real contract, wrong claimed issuer) with a look-alike investigation', () => {
  const r = scanWatchlist({ tokens: [{ address: REAL, claimedIssuer: 'BlackRock' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].verdict, 'impersonation');
  assert.match(r.flags[0].delegate, /deployer|drained|look-alike/i);
});

t('does NOT alert on a clean wallet or a genuine token (a monitor raises the alarm on threats, not silence)', () => {
  const r = scanWatchlist({ addresses: [CLEAN], tokens: [{ address: REAL, claimedSymbol: 'AAPL' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 0, 'clean wallet + genuine token → zero flags');
  assert.equal(r.checked, 2);
  assert.match(r.brief, /clean/i);
});

t('an UNKNOWN (unverified) token is not a flag either — fail-closed, but not a false alarm', () => {
  const r = scanWatchlist({ tokens: [{ address: '0x' + 'ab'.repeat(20) }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 0, 'unknown ≠ threat; it is surfaced as unverified elsewhere, not alerted here');
});

t('malformed watchlist never throws; a mixed list flags only the threats', () => {
  assert.doesNotThrow(() => scanWatchlist(null, { floor: FLOOR, registry: REGISTRY }));
  const r = scanWatchlist({ addresses: [BAD, CLEAN], tokens: [{ address: REAL, claimedIssuer: 'X' }, { address: REAL, claimedSymbol: 'AAPL' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 2, 'the known-bad wallet + the impersonation; the clean wallet + genuine token stay quiet');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
