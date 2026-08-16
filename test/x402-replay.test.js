'use strict';
// x402 anti-replay: one confirmed USDC payment redeems EXACTLY ONE verdict. Offline (injected verifyTxHash).
// Run: node test/x402-replay.test.js
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
process.env.BIII_X402_CONSUMED = path.join(os.tmpdir(), 'biii-x402-replay-' + process.pid + '.json');
process.env.BIII_MERCHANT = '0x' + 'ab'.repeat(20);        // must be set BEFORE requiring the server
const assert = require('node:assert');
const http = require('node:http');
const { build } = require('../lib/server');
const settle = require('../lib/x402-settle');

const M = '0x' + 'ab'.repeat(20);
const tx = (n) => '0x' + String(n).padStart(64, '0');       // distinct valid 64-hex txHashes (digits are hex)
const proof = (o = {}) => ({ paid: true, txHash: tx(1), to: M.toLowerCase(), valueMicro: '10000', confirmations: 3, blockNumber: 5000, ...o });

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

function req(server, method, p, body, headers) {
  return new Promise((resolve) => {
    const addr = server.address(), data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(headers || {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { j = null; } resolve({ status: res.statusCode, body: j }); }); });
    if (data) r.write(data); r.end();
  });
}

(async () => {
  // ── unit: settleOnce ──────────────────────────────────────────────────────
  await t('first use of a fresh valid payment settles', () => {
    settle._reset();
    const r = settle.settleOnce({ proof: proof({ txHash: tx(1) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, true);
  });
  await t('SAME txHash a second time is REJECTED (replay) with 409', () => {
    // (state carries from the previous case — tx(1) is now consumed)
    const r = settle.settleOnce({ proof: proof({ txHash: tx(1) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 409);
  });
  await t('underpayment is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(2), valueMicro: '1000' }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('payment to a different recipient is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(3), to: '0x' + 'cc'.repeat(20) }), merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('a stale payment (too many confirmations) is rejected (402)', () => {
    const r = settle.settleOnce({ proof: proof({ txHash: tx(4), confirmations: 5000 }), merchant: M, needMicro: '2000', maxAgeBlocks: 900 });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });
  await t('a not-paid proof is rejected (402)', () => {
    const r = settle.settleOnce({ proof: { paid: false, txHash: tx(5) }, merchant: M, needMicro: '2000' });
    assert.equal(r.ok, false); assert.equal(r.code, 402);
  });

  // ── integration: the paid endpoint, same payment twice ────────────────────
  settle._reset();
  const PTX = tx(42);
  const server = build({ verifyTxHash: async ({ txHash }) => ({ paid: true, txHash, to: M.toLowerCase(), valueMicro: '300000', confirmations: 3, blockNumber: 6000 }) })
    .listen(0);
  await new Promise((r) => server.once('listening', r));
  const asset = { address: '0x' + '12'.repeat(20), claimedIssuer: 'BlackRock', claimedSymbol: 'BUIDL' };

  await t('POST /x402/vet-asset with a fresh payment → 200 verdict', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': PTX });
    assert.equal(r.status, 200); assert.ok(r.body && r.body.verdict);
  });
  await t('SAME payment reused → 409 (one payment = one verdict)', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': PTX });
    assert.equal(r.status, 409);
  });
  await t('a brand-new payment → 200 again (distinct tx settles)', async () => {
    const r = await req(server, 'POST', '/x402/vet-asset', asset, { 'x-payment': tx(43) });
    assert.equal(r.status, 200);
  });

  /* ── ON ENCAISSAIT AVANT DE VALIDER, ET LA MISE ETAIT PERDUE ────────────────────────────────────
   * `settleOnce` BRULE la transaction — c'est tout son propos — et le controle d'adresse arrivait
   * APRES. Prouve le 2026-07-28 sur un vrai serveur, une seule transaction:
   *
   *   1) POST /x402/vet-address {address:'0x123'}  -> HTTP 400, adresse malformee
   *   2) POST /x402/vet-address {address: valide}  -> HTTP 409, « payment already redeemed »
   *
   * L'appelant a paye, s'est trompe d'un caractere, et a perdu sa mise sans verdict — sans pouvoir
   * reessayer. Ce n'est pas une lecture manquee: c'est un ORDRE D'OPERATIONS. On ne consomme jamais un
   * paiement pour une requete qu'on allait refuser. */
  const PTX_TYPO = tx(44);
  await t('★ une entree invalide est refusee AVANT le reglement — la mise n est pas consommee', async () => {
    const r = await req(server, 'POST', '/x402/vet-address', { address: '0x123' }, { 'x-payment': PTX_TYPO });
    assert.equal(r.status, 400);
    assert.match(String(r.body && r.body.note), /payment was NOT consumed/i,
      'le refus doit DIRE que la mise est intacte, sinon l appelant n ose pas reessayer');
  });

  await t('★ ... et la MEME transaction paie encore un verdict apres correction', async () => {
    const r = await req(server, 'POST', '/x402/vet-address', { address: '0x' + 'c1'.repeat(20) }, { 'x-payment': PTX_TYPO });
    assert.equal(r.status, 200, 'la mise devait survivre a la faute de frappe');
    assert.ok(r.body && r.body.vet, 'et rendre le verdict paye');
  });

  await t('★ LES DEUX BORNES: l anti-rejeu tient toujours apres ce chemin', async () => {
    /* Le durcissement ne doit pas ouvrir la porte qu il longe: une fois le verdict rendu, la meme
     * transaction ne doit plus rien acheter. */
    const r = await req(server, 'POST', '/x402/vet-address', { address: '0x' + 'c1'.repeat(20) }, { 'x-payment': PTX_TYPO });
    assert.equal(r.status, 409);
  });

  await t('LES DEUX BORNES: une sonde NON PAYANTE recoit toujours le defi 402, pas un 400', async () => {
    /* Le corps est lu plus tot qu avant; le defi 402 doit rester en amont, sinon on renseignerait un
     * visiteur non payant sur la validite de son entree. */
    const r = await req(server, 'POST', '/x402/vet-address', { address: '0x123' }, {});
    assert.equal(r.status, 402);
  });

  /* ── LES DEUX CHAMPS QUI ANCRENT LA GARDE, ET LA COERCITION QUI LES ANNULAIT ──────────────────────
   *
   * `Number(proof.confirmations || 0)` faisait d'un champ absent un age de ZERO, c'est-a-dire la
   * fraicheur maximale: le test `age > maxAgeBlocks` passait toujours. Et `Number(proof.blockNumber || 0)`
   * enregistrait l'empreinte consommee au bloc 0, que le reglement suivant purgeait — rendant le
   * paiement rejouable.
   *
   * ⚠️ NON EXPLOITABLE AU MOMENT DE LA CORRECTION, et le dire fait partie du travail: dans lib/chain.js,
   * toute branche de verifyTxHash qui rend `paid: true` porte les deux champs. C'est une validation
   * d'entree fail-closed sur une fonction EXPORTEE, pas la fermeture d'un trou ouvert.
   *
   * Ces cas existent parce que j'ai bouche la coercition DEUX FOIS avant qu'elle soit fermee:
   * `Number(null)` vaut 0, puis `Number('')` vaut 0 aussi. Enumerer les valeurs fautives est un jeu
   * qu'on perd; exiger la forme attendue le termine. */
  await t('un age ou un bloc ILLISIBLE ne franchit pas la garde (toutes les formes falsy)', () => {
    const M = '0x' + 'a'.repeat(40);
    const H = (n) => '0x' + String(n).repeat(64).slice(0, 64);
    const bon = { paid: true, to: M, valueMicro: '250000', confirmations: 5, blockNumber: 30000000 };
    const refuse = (patch, quoi) => {
      settle._reset();
      const r = settle.settleOnce({ proof: { ...bon, ...patch, txHash: H(1) }, merchant: M, needMicro: '250000' });
      assert.equal(r.ok, false, quoi + ' doit etre refuse');
      assert.equal(r.code, 402, quoi + ' -> 402');
    };
    for (const v of [undefined, null, '', '   ', [], false, '5abc', NaN]) {
      refuse({ confirmations: v }, 'confirmations=' + JSON.stringify(v));
      refuse({ blockNumber: v }, 'blockNumber=' + JSON.stringify(v));
    }
  });

  await t('les formes numeriques LEGITIMES passent — la garde ne doit pas tout refuser', () => {
    /* La borne inverse. Un fail-closed pousse trop loin refuserait des preuves valides et fermerait la
     * caisse: il faut tenir les deux cotes, pas seulement celui qui rassure. */
    const M = '0x' + 'a'.repeat(40);
    const H = (n) => '0x' + String(n).repeat(64).slice(0, 64);
    const bon = { paid: true, to: M, valueMicro: '250000', blockNumber: 30000000 };
    [5, '5', 5n].forEach((v, i) => {
      settle._reset();
      const r = settle.settleOnce({ proof: { ...bon, confirmations: v, txHash: H(i + 2) }, merchant: M, needMicro: '250000' });
      assert.equal(r.ok, true, 'confirmations=' + String(v) + ' (' + typeof v + ') doit passer');
    });
  });

  await t('un paiement trop VIEUX reste refuse — la validation n a pas remplace la fraicheur', () => {
    const M = '0x' + 'a'.repeat(40);
    settle._reset();
    const r = settle.settleOnce({
      proof: { paid: true, to: M, valueMicro: '250000', confirmations: 999999, blockNumber: 30000000, txHash: '0x' + '9'.repeat(64) },
      merchant: M, needMicro: '250000' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /too old/i);
  });

  /* ── CE QUI REND L'ABSENCE DE LIAISON PAR ROUTE INOFFENSIVE — ET LE JOUR OU CA CESSERA ──────────
   *
   * Mesure du 2026-08-16 sur le noeud DEPLOYE: les trois routes payantes servent un defi 402
   * IDENTIQUE — meme `amount` (250000), meme `payTo`, et un `resource` generique
   * (`…/x402`, sans le chemin de la route). `challenge402()` RECOIT pourtant un parametre `route`
   * (lib/server.js le passe) et ne s'en sert nulle part. Cote reglement, `settleOnce({ proof,
   * merchant, needMicro })` borne le txHash, le destinataire et le MONTANT — jamais la route.
   *
   * ⚖️ CE N'EST PAS UNE FUITE AUJOURD'HUI, et il ne faut pas le survendre: les trois routes valent
   * le MEME prix (`need` est calcule une seule fois depuis BIII_VET_PRICE_USD, pas par route), et
   * un paiement redime EXACTEMENT un verdict. Payer $0,25 et appeler n'importe laquelle des trois
   * est donc exactement ce qui a ete achete.
   *
   * ⛔ CE QUI LE RENDRAIT LETAL TIENT EN UNE LIGNE: le jour ou une route coute PLUS CHER qu'une
   * autre, un appelant paierait le prix de la moins chere et appellerait la plus chere — le
   * reglement ne regarde pas laquelle. Et le piege est deja arme d'une facon particulierement
   * traitre: le parametre `route` EXISTE, il est PASSE, et il est SILENCIEUSEMENT JETE. Quiconque
   * lit `challenge402({ …, route })` conclura que la route est prise en compte.
   *
   * Ce cas epingle donc l'INVARIANT qui rend le design actuel sur — un prix unique — pour que sa
   * rupture soit BRUYANTE au lieu d'etre une modification anodine de configuration. */
  await t('★ LE PRIX EST UNIQUE POUR TOUTES LES ROUTES PAYANTES — sinon le reglement doit borner la ROUTE', () => {
    const { challenge402, BAZAAR_ROUTES } = require('../lib/openapi');
    const routes = Object.keys(BAZAAR_ROUTES || {});
    assert.ok(routes.length >= 2, 'succes vide: ' + routes.length + ' route(s) payante(s) lue(s) — rien a comparer');

    const montants = new Set();
    for (const r of routes) {
      const { body } = challenge402({ origin: 'https://x', merchant: M, route: r });
      montants.add(String(body.accepts[0].amount));
    }
    assert.strictEqual(montants.size, 1,
      'les routes payantes n ont plus le MEME prix (' + [...montants].join(' / ') + '). Or `settleOnce` ne '
      + 'borne PAS la route: un appelant peut payer le prix le plus bas et appeler la route la plus chere. '
      + 'Avant de differencier les prix, il faut lier le reglement a la route — et faire porter cette route '
      + 'par le defi 402 servi, qui aujourd hui rend un `resource` generique.');
  });

  await t('le parametre `route` de challenge402 est aujourd hui SANS EFFET — fige, pour que l ajouter se voie', () => {
    /* On ne juge pas: on CONSTATE. Ce cas devient rouge le jour ou quelqu un branche `route` — et
     * c est exactement le moment ou il faut relire le reglement et cette liaison ensemble. */
    const { challenge402 } = require('../lib/openapi');
    const a = challenge402({ origin: 'https://x', merchant: M, route: '/x402/vet-address' }).body.accepts[0];
    const b = challenge402({ origin: 'https://x', merchant: M, route: '/x402/vet-meme' }).body.accepts[0];
    assert.deepStrictEqual(a, b,
      'le defi 402 DIFFERE desormais selon la route — bonne nouvelle, mais alors `settleOnce` doit lier le '
      + 'paiement a cette route, et ce cas doit etre reecrit pour l exiger au lieu de constater l inverse.');
  });

  server.close();
  try { fs.unlinkSync(process.env.BIII_X402_CONSUMED); } catch {}
  console.log(`\nx402-replay: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
