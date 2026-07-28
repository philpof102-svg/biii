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
    assert.deepStrictEqual(items.map((x) => x.address.toLowerCase()), [BAD, DRAINER]);
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
    assert.deepStrictEqual(d.addresses, [...d.addresses].sort(), 'sorted');
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
    /* The point is that a source which FAILED is not listed as if it had worked — not that exactly one
     * source survives. This assertion used to read `every(s => /OFAC/.test(s))`, which quietly encoded
     * "OFAC is the only thing that can succeed here" and went red the moment a legitimate third source
     * (the first-party findings, which need no network and therefore never fail) was added. Testing the
     * absence of the broken one is what the sentence above actually claims. */
    assert.ok(data.sources.some((s) => /OFAC/.test(s)), 'the source that worked is listed');
    assert.ok(!data.sources.some((s) => /eth-labels/.test(s)), 'the source that returned 500 is NOT listed as a source');
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

  /* ── UN RÉSEAU QUI TOMBE NE DOIT PAS RÉTRÉCIR LE PLANCHER ──────────────────────────────────────────
   * Mesure du 2026-07-28, `fetchImpl` bouchonné, sources aux corps réalistes :
   *
   *   toutes vivantes   -> 26 adresses, asOf=aujourd'hui, stale=false
   *   OFAC tombée       ->  1 adresse,  asOf=aujourd'hui, stale=false
   *   les deux tombées  ->  1 adresse,  asOf=aujourd'hui, stale=false
   *
   * Le plancher perdait 96 % de son contenu EN SE DÉCLARANT FRAIS. C'est lui qui porte le BLOCK local
   * décisif : un « pas sur la liste » sortait alors d'une liste qui n'avait presque pas été lue.
   *
   * Le delta était déjà imprimé bruyamment — c'était la bonne intention — mais un cron nocturne ne lit
   * pas stdout : il ne voit que le fichier et le code de sortie. Le témoin existait sans lecteur.
   *
   * ⚠️ Mon premier jet de sonde a rendu la MÊME sortie sur quatre entrées opposées. Variance nulle =
   * l'instrument, pas le sujet : `ingest(fetchImpl, opts)` prend son fetch en PREMIER ARGUMENT
   * positionnel, et je passais un objet. Trois tentatives avant de lire la signature. */
  const ADRS = Array.from({ length: 40 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'));
  const corps = (u) => (/ofac/.test(u) ? ADRS.slice(0, 25).join('\n')
    : /eth-labels/.test(u) ? JSON.stringify(ADRS.slice(25, 40).map((a) => ({ address: a, name: 'phishing hack' })))
      : '[]');
  const reseau = (tombees) => async (u) => {
    if (tombees.some((x) => u.includes(x))) throw new Error('HTTP 503');
    return { ok: true, status: 200, text: async () => corps(u) };
  };

  await t('le fichier écrit PORTE la trace des sources tombées', async () => {
    const vivant = await K.ingest(reseau([]));
    const casse = await K.ingest(reseau(['ofac']));
    assert.deepStrictEqual(vivant.data.sourcesFailed, [], 'aucun échec ⇒ liste vide');
    assert.strictEqual(casse.data.sourcesFailed.length, 1);
    assert.match(casse.data.sourcesFailed[0].error, /503/, 'la RAISON voyage, pas seulement le fait');
    /* Le point qui rendait l'échec invisible: `sources` rétrécit dans les deux cas, donc un lecteur ne
     * pouvait pas distinguer « source retirée du design » de « source tombée cette nuit ». */
    assert.ok(casse.data.sources.length < vivant.data.sources.length);
  });

  await t('le plancher rétrécit VRAIMENT quand une source tombe — le cas est réel', async () => {
    const vivant = await K.ingest(reseau([]));
    const casse = await K.ingest(reseau(['ofac', 'eth-labels']));
    assert.ok(vivant.data.addresses.length > 20, 'sanity: le cas nominal doit produire un vrai plancher');
    assert.ok(casse.data.addresses.length < vivant.data.addresses.length / 5,
      'sans les sources, il ne reste que les trouvailles first-party');
  });

  await t('LE GARDE: échec réseau ET perte d\'adresses ⇒ refus d\'écrire', () => {
    const r = K.shouldRefuseWrite({ data: { sourcesFailed: [{ id: 'ofac' }] }, delta: { lost: ['0x1'] } });
    assert.strictEqual(r.refuse, true);
  });

  await t('LES DEUX BORNES: un retrait amont LÉGITIME s\'écrit toujours', () => {
    /* Sans ce cas, on refuserait des retraits corrects et l'opérateur apprendrait à passer `--force` par
     * réflexe — un garde qu'on contourne machinalement ne garde plus rien. */
    assert.strictEqual(K.shouldRefuseWrite({ data: { sourcesFailed: [] }, delta: { lost: ['0x1', '0x2'] } }).refuse,
      false, 'perte SANS panne = correction amont, on la propage');
    assert.strictEqual(K.shouldRefuseWrite({ data: { sourcesFailed: [{ id: 'a' }] }, delta: { lost: [] } }).refuse,
      false, 'panne SANS perte = la redondance a fait son travail');
    assert.strictEqual(K.shouldRefuseWrite({ data: { sourcesFailed: [] }, delta: null }).refuse,
      false, 'premier run, aucun delta');
  });

  await t('--force reste possible, et il est explicite', () => {
    const sans = K.shouldRefuseWrite({ data: { sourcesFailed: [{ id: 'a' }] }, delta: { lost: ['0x1'] }, force: false });
    const avec = K.shouldRefuseWrite({ data: { sourcesFailed: [{ id: 'a' }] }, delta: { lost: ['0x1'] }, force: true });
    assert.strictEqual(sans.refuse, true);
    assert.strictEqual(avec.refuse, false);
    assert.strictEqual(avec.forced, true, 'le forçage est rapporté, pas silencieux');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
