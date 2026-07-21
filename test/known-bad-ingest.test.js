'use strict';
// BIII known-bad ingest — the hardened public-list filter that builds the decentralized floor. Offline.
// Run: node test/known-bad-ingest.test.js
const assert = require('node:assert');
const K = require('../scripts/biii-known-bad-ingest');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const A = (h) => '0x' + h.repeat(20);
const BAD = A('a1'), DRAINER = A('b1'), LEGIT = A('c1'), SAFE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC Base

(async () => {
  console.log('BIII known-bad ingest — the public-list filter (decentralized floor builder):');

  await t('parseOfac: one address per line, blanks dropped', () => {
    const items = K.parseOfac(`${BAD}\n\n  ${DRAINER}  \n`);
    assert.deepEqual(items.map((x) => x.address.toLowerCase()), [BAD, DRAINER]);
  });

  await t('parseEthLabels: a malicious label is kept; a NON-malicious label is dropped', () => {
    const csv = `address,label,nameTag\n${BAD},phish-hack,\n${LEGIT},exchange,Binance\n${A('d1')},defi,Uniswap\n`;
    const out = K.parseEthLabels(csv).map((x) => x.address);
    assert.ok(out.includes(BAD), 'phish-hack kept');
    assert.ok(!out.includes(LEGIT), 'exchange (legit) dropped');
    assert.ok(!out.includes(A('d1')), 'defi (non-malicious) dropped');
  });

  await t('CO-OCCURRENCE GUARD: an address with a malicious AND a legit label is SKIPPED (avoid false positive)', () => {
    const csv = `address,label,nameTag\n${LEGIT},exploit,\n${LEGIT},token-contract,SomeToken\n`;
    assert.ok(!K.parseEthLabels(csv).some((x) => x.address === LEGIT), 'exploit + token-contract co-occur → not denylisted');
  });

  await t('the malicious PATTERN family matches -exploit / heist / -drain (bounded, anti-FP)', () => {
    const csv = `address,label,nameTag\n${A('e1')},bybit-exploit,\n${A('f1')},wallet-drain,\n${A('01')},heist,\n`;
    assert.equal(K.parseEthLabels(csv).length, 3);
    // and it does NOT over-match a substring: "-drainer" is not the "drain" token
    assert.equal(K.parseEthLabels(`address,label,nameTag\n${A('02')},wallet-drainer,\n`).length, 0);
  });

  await t('normalize: garbage rejected (counted), KNOWN_SAFE guarded, cleaned to lowercase', () => {
    const { kept, rejected } = K.normalize([BAD, 'not-an-addr', '0xshort', SAFE, BAD.toUpperCase().replace('0X', '0x')]);
    assert.ok(kept.every((a) => a === BAD), 'only the valid non-safe address survives (lowercased)');
    assert.ok(!kept.includes(SAFE), 'KNOWN_SAFE (USDC Base) never denylisted');
    assert.equal(rejected, 2, 'two malformed rows counted, not silently lost');
    // dedup is buildKnownBad's job (a Set), not normalize's — proven in the buildKnownBad test above
  });

  await t('buildKnownBad: dedups across sources, PARTIAL cap (never zero), sorted output', () => {
    const d = K.buildKnownBad([
      { items: [{ address: BAD }, { address: DRAINER }, { address: BAD }], cap: 100 },
      { items: [{ address: A('11') }, { address: A('22') }, { address: A('33') }], cap: 2 },   // cap → keep first 2
    ], { asOf: '2026-07-21', sources: ['s1', 's2'] });
    assert.equal(d.addresses.length, 4, '2 from src1 (deduped) + 2 from capped src2');
    assert.deepEqual(d.addresses, [...d.addresses].sort(), 'sorted');
    assert.equal(d.asOf, '2026-07-21');
  });

  await t('ingest: a FAILED source leaves the others intact — never zeros the floor', async () => {
    const fakeFetch = async (url) => {
      if (url.includes('0xB10C')) return { ok: true, text: async () => `${BAD}\n${DRAINER}` };  // OFAC ok
      return { ok: false, status: 500 };   // eth-labels down
    };
    const { data, report } = await K.ingest(fakeFetch, { includeGpl: false });
    assert.ok(data.addresses.includes(BAD), 'OFAC addresses survived the eth-labels failure');
    assert.ok(Object.values(report).some((r) => r.error), 'the failure is reported, not hidden');
    assert.ok(data.sources.every((s) => /OFAC/.test(s)), 'sources lists only the ones that succeeded');
  });

  await t('MIT-default: the GPL ScamSniffer source is NOT pulled unless --include-gpl', async () => {
    let scamSnifferHit = false;
    const fakeFetch = async (url) => { if (url.includes('scamsniffer')) scamSnifferHit = true; return { ok: true, text: async () => `${BAD}` }; };
    await K.ingest(fakeFetch, { includeGpl: false });
    assert.equal(scamSnifferHit, false, 'GPL source untouched by default (license discipline)');
    scamSnifferHit = false;
    await K.ingest(fakeFetch, { includeGpl: true });
    assert.equal(scamSnifferHit, true, 'included only when explicitly opted in');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
