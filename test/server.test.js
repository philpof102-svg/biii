'use strict';
// BIII server — offline (injected findPayment, no network). Run: node test/server.test.js
// The payment flow is chargeId-bound: POST /charge mints a server-owned chargeId; /status & /receipt take
// that chargeId so a prior/unrelated transfer can never satisfy an unbound query (the cross-charge false-PAID).
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const T = require('../lib/till');

const M = '0x' + 'ab'.repeat(20);
const TX = '0x' + 'cd'.repeat(32);
let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, path, body) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let body; try { body = JSON.parse(b || '{}'); } catch { body = null; } resolve({ status: res.statusCode, body, raw: b }); }); });
    if (data) r.write(data); r.end();
  });
}

// a stub chain: pays exactly one merchant with one transfer (TX), unless that TX is already consumed by
// another charge (respects excludeTxHashes — the one-transfer-one-charge guard).
const PAID = { txHash: TX, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), from: '0x' + 'ee'.repeat(20), valueMicro: '4500000', confirmations: 3, blockTime: 1 };
const stubChain = async ({ minMicro, excludeTxHashes }) => {
  if (BigInt(minMicro) > 4500000n) return null;
  const ex = excludeTxHashes instanceof Set ? excludeTxHashes : new Set((excludeTxHashes || []).map((h) => String(h).toLowerCase()));
  return ex.has(TX.toLowerCase()) ? null : PAID;
};
// a fresh server per test — the in-memory charge/consumed store is per-instance, so isolation is deliberate.
async function mkServer(deps = {}) { const s = build({ merchant: M, findPayment: stubChain, ...deps }); await new Promise((r) => s.listen(0, r)); return s; }
const mkCharge = async (s, amountUsd) => (await req(s, 'POST', '/charge', { amountUsd })).body.chargeId;

(async () => {
  console.log('BIII server — non-custodial, chargeId-bound, chain-truthful:');
  const server = await mkServer();

  await t('GET /health reports non-custodial + merchant configured', async () => {
    const r = await req(server, 'GET', '/health');
    assert.equal(r.body.merchantConfigured, true);
    assert.match(r.body.note, /holds no key/);
  });

  /* ── L'ETAT DU COLLECTEUR EST SERVI, ET SES QUATRE ETATS RESTENT DISTINCTS ────────────────────────
   *
   * ⛔ POURQUOI. Mesure du 2026-08-11: `blackouts.json` porte 111,3 h de silence en 9 trous, tous du
   * meme profil — arret le soir/la nuit, reprise en JOURNEE, et la note du plus ancien dit « The
   * machine slept ». Le collecteur SERVEUR existe pour ne plus dependre d'une machine qui dort, mais
   * RIEN ne publiait s'il tournait: `/health` rendait `ok:true` sans un mot, `/radar` la couverture du
   * registre. `radar-tick` « disait » son etat — dans ses LOGS, qui ne sortent pas du conteneur. Le
   * doute a dure des jours faute d'une surface lisible.
   *
   * ⚠️ ET « ACTIF » NE SUFFIT PAS: c'est « arme », pas « tourne ». Les quatre etats doivent rester
   * separes, sinon le champ rassure a tort:
   *   notStarted -> ce processus n'a pas de collecteur (test, serveur lance a la main)
   *   inactive   -> le collecteur existe et attend `RADAR_TICK_MINUTES`
   *   armed      -> arme, JAMAIS tourne encore
   *   running    -> arme ET a tourne; c'est `lastTickAgeMinutes` compare a `everyMinutes` qui montre
   *                 un collecteur MORT, pas la presence du champ. */
  await t('★ GET /health: sans collecteur dans ce processus, il dit `notStarted` — pas « inactif »', async () => {
    const r = await req(server, 'GET', '/health');
    assert.equal(r.body.collector.state, 'notStarted',
      'l absence de collecteur dans CE processus n est pas une panne du collecteur');
    assert.match(r.body.collector.note, /say nothing about the base/);
  });

  await t('★ GET /health: collecteur INACTIF — il nomme la variable qui le reveillerait', async () => {
    const s = await mkServer({ radarEtat: () => ({ actif: false, raison: 'RADAR_TICK_MINUTES absent',
      minutes: null, dir: null, lastTickAt: null, lastTickOk: null, ticks: 0, lastTickAgeMinutes: null }) });
    const r = await req(s, 'GET', '/health');
    s.close();
    assert.equal(r.body.collector.state, 'inactive');
    assert.match(r.body.collector.note, /RADAR_TICK_MINUTES/,
      'dire « inactif » sans dire quoi poser laisse le lecteur devant rien');
  });

  await t('★ GET /health: ARME mais jamais tourne ne se lit PAS comme `running`', async () => {
    const s = await mkServer({ radarEtat: () => ({ actif: true, raison: 'ok', minutes: 60, dir: '/x',
      lastTickAt: null, lastTickOk: null, ticks: 0, lastTickAgeMinutes: null }) });
    const r = await req(s, 'GET', '/health');
    s.close();
    assert.equal(r.body.collector.state, 'armed', '⛔ arme n est pas tourne');
    assert.equal(r.body.collector.lastTickAt, null, 'aucune date inventee');
    assert.match(r.body.collector.note, /NEVER RAN/);
  });

  await t('★ GET /health: `running` porte l AGE — c est lui qui montre un collecteur MORT', async () => {
    const s = await mkServer({ radarEtat: () => ({ actif: true, raison: 'ok', minutes: 60, dir: '/x',
      lastTickAt: '2026-08-11T10:00:00.000Z', lastTickOk: true, ticks: 12, lastTickAgeMinutes: 417.6 }) });
    const r = await req(s, 'GET', '/health');
    s.close();
    assert.equal(r.body.collector.state, 'running');
    assert.equal(r.body.collector.lastTickAgeMinutes, 418, 'l age est arrondi, pas tronque au hasard');
    assert.equal(r.body.collector.everyMinutes, 60);
    assert.equal(r.body.collector.ticks, 12);
    /* ⛔ TEMOIN OPPOSE: un tick ECHOUE reste visible dans la surface servie. */
    const s2 = await mkServer({ radarEtat: () => ({ actif: true, raison: 'ok', minutes: 60, dir: '/x',
      lastTickAt: '2026-08-11T10:00:00.000Z', lastTickOk: false, ticks: 3, lastTickAgeMinutes: 5,
      lastTickRaison: 'code 3' }) });
    const r2 = await req(s2, 'GET', '/health');
    s2.close();
    assert.equal(r2.body.collector.lastTickOk, false, 'un echec ne doit pas disparaitre derriere `running`');
    assert.equal(r2.body.collector.lastTickReason, 'code 3');
  });

  await t('GET / serves the merchant PWA same-origin (so the phone app and its API share one URL)', async () => {
    const r = await req(server, 'GET', '/');
    assert.match(String(r.raw || ''), /BIII|Caisse|screen-keypad/, 'the / route serves web/index.html');
  });

  await t('GET /embed.js + /embed-demo.html are served (the drop-in trust badge, not just referenced)', async () => {
    const js = await req(server, 'GET', '/embed.js');
    assert.match(String(js.raw || ''), /BIII trust badge|data-biii-address/, 'the embeddable badge script is served');
    const demo = await req(server, 'GET', '/embed-demo.html');
    assert.match(String(demo.raw || ''), /embed\.js|data-biii-address/, 'the badge demo page is served');
    const radar = await req(server, 'GET', '/radar.html');
    assert.match(String(radar.raw || ''), /Trust Radar/, 'the radar dashboard page is served');
    const p2p = await req(server, 'GET', '/p2p.html');
    assert.match(String(p2p.raw || ''), /Payer un ami|parse-qr/, 'the P2P pay-a-friend page is served');
  });

  await t('POST /charge → charge + chargeId + EIP-681 URI (uses configured merchant)', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', label: 'flat white' });
    assert.equal(r.body.charge.amountMicro, '4500000');
    assert.match(String(r.body.chargeId), /^[0-9a-f]{24}$/, 'the server mints a chargeId that binds this charge');
    assert.equal(r.body.paymentURI, `ethereum:${T.USDC_BASE}@8453/transfer?address=${M.toLowerCase()}&uint256=4500000`);
    assert.equal((await req(server, 'POST', '/charge', { amountUsd: 'xyz' })).status, 400);
  });

  await t('GET /status?chargeId → paid once the transfer exists (bound to THIS charge)', async () => {
    const s = await mkServer();
    const id = await mkCharge(s, '4.50');
    const r = await req(s, 'GET', `/status?chargeId=${id}`);
    assert.equal(r.body.verdict.paid, true);
    assert.equal(r.body.verdict.tier, 'confirmed');
    const bigId = await mkCharge(s, '9.00');      // stub returns null for > 4.5 → unpaid
    assert.equal((await req(s, 'GET', `/status?chargeId=${bigId}`)).body.verdict.paid, false);
    s.close();
  });

  await t('GET /receipt?chargeId → verified receipt with txHash; 404 when unpaid', async () => {
    const s = await mkServer();
    const id = await mkCharge(s, '4.50');
    const r = await req(s, 'GET', `/receipt?chargeId=${id}&name=Cafe`);
    assert.equal(r.body.receipt.txHash, TX);
    assert.ok(r.body.receipt.explorer.includes('basescan.org'));
    const bigId = await mkCharge(s, '9.00');
    assert.equal((await req(s, 'GET', `/receipt?chargeId=${bigId}`)).status, 404);
    s.close();
  });

  await t('the configured merchant is FIXED — a caller cannot redirect the charge to another address', async () => {
    const r = await req(server, 'POST', '/charge', { amountUsd: '4.50', to: '0x' + '99'.repeat(20) });
    assert.equal(r.body.charge.to, M.toLowerCase(), 'caller-supplied `to` is ignored when a merchant is configured');
  });

  await t('P2P: /receive builds a show-to-receive QR, /parse-qr validates a scanned one (Base USDC, fail-closed)', async () => {
    const alice = '0x' + 'a1'.repeat(20);
    const rec = await req(server, 'GET', `/receive?address=${alice}&amountUsd=7.50`);
    assert.match(rec.body.paymentURI, /^ethereum:.*@8453\/transfer\?address=.*uint256=7500000$/);
    const ok = await req(server, 'GET', `/parse-qr?text=${encodeURIComponent(rec.body.paymentURI)}`);
    assert.equal(ok.status, 200); assert.equal(ok.body.parsed.to, alice); assert.equal(ok.body.parsed.amountUsd, '7.50');
    // fail-closed: a non-Base / garbage QR → 422, not valid
    assert.equal((await req(server, 'GET', '/parse-qr?text=hello')).status, 422);
    assert.equal((await req(server, 'GET', `/parse-qr?text=${encodeURIComponent('ethereum:0x' + '2b'.repeat(20) + '@1')}`)).body.parsed.valid, false);
    assert.equal((await req(server, 'GET', '/receive?address=nope')).status, 400);
  });

  await t('GET /verify?txHash — accounting proof: 400 on a bad hash, chain facts on a real one', async () => {
    const s = await mkServer({ verifyTxHash: async ({ txHash }) => ({ found: true, paid: true, txHash, from: '0x' + 'ee'.repeat(20), to: M.toLowerCase(), valueMicro: '4500000', valueUsd: '4.50', confirmations: 3, explorer: 'https://basescan.org/tx/' + txHash }) });
    assert.equal((await req(s, 'GET', '/verify?txHash=0xdead')).status, 400, 'a malformed hash gets no verdict');
    const r = await req(s, 'GET', '/verify?txHash=0x' + 'ab'.repeat(32));
    assert.equal(r.body.proof.paid, true); assert.equal(r.body.proof.valueUsd, '4.50');
    assert.match(r.body.note, /Confirmed on Base|basescan/);
    s.close();
  });

  // ── the CRITICAL false-PAID fixes ──
  await t('NO chargeId → never paid: an unbound /status can\'t be satisfied by a prior/unrelated transfer', async () => {
    const s = await mkServer();
    const r = await req(s, 'GET', '/status');           // no chargeId at all — the cross-charge replay vector
    assert.equal(r.body.verdict.paid, false);
    assert.match(r.body.verdict.reason, /chargeId/);
    // a bogus/expired chargeId is likewise never paid
    assert.equal((await req(s, 'GET', '/status?chargeId=deadbeefdeadbeefdeadbeef')).body.verdict.paid, false);
    assert.equal((await req(s, 'GET', '/receipt?chargeId=deadbeefdeadbeefdeadbeef')).status, 404);
    s.close();
  });

  await t('ONE transfer, ONE charge: a second same-amount charge can\'t re-claim a consumed transfer (two-register)', async () => {
    const s = await mkServer();
    const a = await mkCharge(s, '4.50');
    assert.equal((await req(s, 'GET', `/status?chargeId=${a}`)).body.verdict.paid, true, 'charge A claims the transfer');
    const b = await mkCharge(s, '4.50');                 // second register, same amount, same merchant
    const rb = await req(s, 'GET', `/status?chargeId=${b}`);
    // B is NOT paid — whether via the exclude path (findPayment never returns A's consumed tx → "no chain
    // fact") or the race backstop ("another charge already applied it"). The security property is paid:false.
    assert.equal(rb.body.verdict.paid, false, 'charge B must NOT re-use the transfer already applied to A');
    // A stays paid on re-poll (the guard rejects only OTHER charges, never the owner)
    assert.equal((await req(s, 'GET', `/status?chargeId=${a}`)).body.verdict.paid, true);
    s.close();
  });

  await t('the freshness window is SERVER-authoritative + narrow for a fresh charge (no client timestamp to spoof)', async () => {
    let seen = null;
    const s = await mkServer({ findPayment: async ({ lookbackBlocks }) => { seen = lookbackBlocks; return null; } });
    const id = await mkCharge(s, '4.50');
    await req(s, 'GET', `/status?chargeId=${id}`);
    assert.ok(seen < 900 && seen >= 1, `a just-created charge narrows the window server-side (got ${seen}), not 900 blocks of history`);
    s.close();
  });

  server.close();
  /* ── /radar : UNE COUVERTURE NON LUE N'EST PAS UNE COUVERTURE NULLE ────────────────────────────────
   * Le chargeur de `issuer-verified.json` faisait retomber QUATRE causes d'echec sur le meme `[]`:
   * fichier absent · JSON illisible (`catch {}`) · cle `entries` manquante · `entries: null`. Mesure du
   * 2026-07-28: le fichier reel du depot porte **183 entrees sur 11 chaines**, et les quatre echecs
   * rendaient 0. `/radar` est une surface PUBLIQUE — la couverture passait de 183 a 0 sans un mot, et un
   * lecteur en concluait que ce noeud n'authentifie aucun emetteur.
   *
   * Le cas qui donne son sens a tout: une liste VIDE LEGITIME doit rester distinguable d'une liste non
   * lue. `0 / read:true` contre `null / read:false`. */
  {
    const os = require('node:os'), fsx = require('node:fs'), px = require('node:path');
    const BAC = px.join(os.tmpdir(), 'biii-issuer-' + process.pid);
    fsx.mkdirSync(BAC, { recursive: true });
    const ecrire = (nom, contenu) => { const p = px.join(BAC, nom); fsx.writeFileSync(p, contenu); return p; };
    const couverture = async (deps) => {
      const s = build(deps); await new Promise((r) => s.listen(0, r));
      const rep = await new Promise((r) => http.get(
        { host: '127.0.0.1', port: s.address().port, path: '/radar' },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(JSON.parse(d))); }));
      s.close();
      return rep.radar.coverage;
    };

    const reel = await couverture({});
    const absent = await couverture({ issuerVerifiedPath: px.join(BAC, 'jamais-cree.json') });
    const casse = await couverture({ issuerVerifiedPath: ecrire('casse.json', '{"entries":[') });
    const sansCle = await couverture({ issuerVerifiedPath: ecrire('sans.json', '{"autre":1}') });
    const videLegitime = await couverture({ issuerVerifiedPath: ecrire('vide.json', '{"entries":[]}') });

    await t('la liste reelle du depot est lue et comptee', () => {
      assert.equal(reel.issuerListRead, true);
      assert.ok(reel.issuerVerified > 0, 'le depot embarque une vraie liste');
      assert.ok(reel.chains > 0);
    });

    await t('une liste NON LUE rend null, jamais 0', () => {
      for (const [nom, c] of [['absente', absent], ['illisible', casse], ['sans entries', sansCle]]) {
        assert.equal(c.issuerListRead, false, nom + ': doit se declarer non lue');
        assert.equal(c.issuerVerified, null, nom + ': null, pas 0 — un zero muet est une affirmation');
        assert.equal(c.chains, null, nom);
        assert.match(c.issuerListNote, /NOT zero, it is UNREAD/, nom + ': la raison doit etre publiee');
      }
    });

    await t('une liste VIDE LEGITIME reste un vrai zero — les deux bornes', () => {
      /* Si le durcissement rendait `null` pour tout, il n'informerait plus: un noeud qui n'authentifie
       * reellement aucun emetteur doit pouvoir le dire. */
      assert.equal(videLegitime.issuerListRead, true);
      assert.equal(videLegitime.issuerVerified, 0);
      assert.equal(videLegitime.issuerListNote, undefined, 'pas de note parasite sur un cas lu');
    });

    await t('les quatre causes d echec portent des raisons DISTINCTES', () => {
      /* Sans ca, « non lu » redeviendrait un seul mot fourre-tout et on perdrait ce qu'il faut reparer. */
      const raisons = new Set([absent, casse, sansCle].map((c) => c.issuerListNote));
      assert.equal(raisons.size, 3, 'absente / illisible / sans-cle doivent se distinguer');
    });

    fsx.rmSync(BAC, { recursive: true, force: true });
    await t('la fixture issuer a bien ete supprimee', () => {
      assert.equal(fsx.existsSync(BAC), false);
    });
  }

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
