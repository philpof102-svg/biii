'use strict';
// Dinari issuer-direct registry — the PURE core (buildRegistryFromDinari) is fail-closed: only a factory
// DShareAdded log whose token was on-chain-verified (symbol + Dinari name) is admitted; everything else is
// dropped. Offline (fixture logs + verified map). Run: node test/rwa-issuer-direct.test.js
const assert = require('node:assert');
const { buildRegistryFromDinari, DSHARE_ADDED_TOPIC, AAPL, TSLA } = require('../scripts/biii-rwa-issuer-direct');
const { assessAsset } = require('../lib/asset');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const topic = (a) => '0x000000000000000000000000' + a.slice(2);
const log = (addr, topic0 = DSHARE_ADDED_TOPIC) => ({ topics: [topic0, topic(addr)], data: '0x' });
const FAKE = '0x' + 'ff'.repeat(20);
const OTHER_EVENT = '0x' + 'ab'.repeat(32);

console.log('BIII Dinari issuer-direct registry (pure, fail-closed):');

t('GROUND TRUTH: AAPL + TSLA come out when factory-declared AND on-chain-verified', () => {
  const logs = [log(AAPL), log(TSLA)];
  const verified = { [AAPL]: { symbol: 'AAPL', name: 'Apple Inc. - Dinari' }, [TSLA]: { symbol: 'TSLA', name: 'Tesla, Inc. - Dinari' } };
  const reg = buildRegistryFromDinari(logs, verified);
  assert.equal(reg.length, 2);
  const aapl = reg.find((e) => e.address === AAPL);
  assert.equal(aapl.symbol, 'AAPL'); assert.equal(aapl.issuer, 'Dinari'); assert.equal(aapl.chainId, 8453);
  assert.match(aapl.source, /issuer:.*factory.*on-chain verified/i, 'source reads as issuer-official (→ green)');
});

t('FAIL-CLOSED: a factory log with NO on-chain verification is DROPPED (never admitted on the log alone)', () => {
  const reg = buildRegistryFromDinari([log(AAPL), log(FAKE)], { [AAPL]: { symbol: 'AAPL', name: 'Apple Inc. - Dinari' } });
  assert.equal(reg.length, 1, 'FAKE has no verified entry → dropped');
  assert.equal(reg[0].address, AAPL);
});

t('FAIL-CLOSED: a verified token whose name does NOT carry "Dinari" is dropped (lookalike guard)', () => {
  const reg = buildRegistryFromDinari([log(FAKE)], { [FAKE]: { symbol: 'AAPL', name: 'Apple Inc.' } });   // no "Dinari"
  assert.equal(reg.length, 0, 'a token self-describing as AAPL but not a Dinari name is refused');
});

t('a log from a DIFFERENT event (wrong topic0) is ignored — only DShareAdded counts', () => {
  const reg = buildRegistryFromDinari([log(AAPL, OTHER_EVENT)], { [AAPL]: { symbol: 'AAPL', name: 'Apple Inc. - Dinari' } });
  assert.equal(reg.length, 0);
});

t('malformed logs never throw; duplicates collapse to one', () => {
  assert.doesNotThrow(() => buildRegistryFromDinari([null, {}, { topics: [] }, 'x'], {}));
  const dup = buildRegistryFromDinari([log(AAPL), log(AAPL)], { [AAPL]: { symbol: 'AAPL', name: 'Apple - Dinari' } });
  assert.equal(dup.length, 1, 'the same dShare added twice → one entry');
});

t('COMPOSES with assessAsset: an entry reads genuine + issuer-official (the strong green)', () => {
  const reg = buildRegistryFromDinari([log(AAPL)], { [AAPL]: { symbol: 'AAPL', name: 'Apple Inc. - Dinari' } });
  const v = assessAsset({ token: AAPL }, { registry: reg });
  assert.equal(v.status, 'genuine');
  assert.equal(v.provenance, 'issuer-official');
  // and the FBI-lookalike case: the real dAAPL but claimed as another issuer → impersonation
  assert.equal(assessAsset({ token: AAPL, claimedIssuer: 'BlackRock' }, { registry: reg }).status, 'impersonation');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
