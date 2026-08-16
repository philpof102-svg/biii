'use strict';
/**
 * LES ROUTES FACTURE — la porte HUMAINE sur le meme registre que `till_create_invoice`.
 * ==================================================================================================
 * Ce que ces cas verrouillent, dans l'ordre de ce qui coute le plus cher:
 *
 *   1. `not_observable` DOIT etre atteignable, et SANS lecture de chaine. Une facture reglee par
 *      carte / SEPA / especes n'apparaitra jamais sur Base: l'appeler « impayee » serait une
 *      accusation tiree de NOTRE cecite (never-accuse-on-own-incompleteness), et faire dependre ce
 *      verdict d'un RPC le rendrait indisponible pour le commercant hors ligne — le cas d'usage le
 *      plus concret du produit. Le cas ci-dessous fait donc ECHOUER la chaine expres et exige quand
 *      meme une reponse.
 *   2. Une echeance ILLISIBLE ne doit pas fabriquer un verdict. `Number('')` vaut 0 et
 *      `Number('abc')` vaut NaN: passee crue, elle rendrait `overdue` ou `issued` selon le hasard.
 *   3. La route de CREATION et la route de CONTROLE doivent parler du MEME document — la seconde le
 *      RECONSTRUIT (rien n'est stocke), exactement comme le jumeau MCP. Un total qui ne survit pas
 *      a l'aller-retour est un document different.
 *
 * ⚖️ BORNE: aucun de ces cas ne touche le reseau. `findPayment` est injecte, donc ils prouvent le
 * CABLAGE et les refus, jamais qu'un paiement reel serait reconnu — ca, c'est test/e2e-real-chain.
 *
 * Run: node test/invoice-routes.test.js
 */
const assert = require('node:assert');
const http = require('node:http');

let pass = 0, fail = 0;
const encours = [];
const t = (nom, fn) => encours.push((async () => {
  try { await fn(); pass++; console.log('  ok   ' + nom); }
  catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + ((e && e.message) || e)); }
})());

const MARCHAND = '0x' + 'ab'.repeat(20);

/** Un serveur reel, avec la chaine injectee — on teste les routes, pas Base. */
function demarrer(deps) {
  const { build } = require('../lib/server.js');
  const srv = build(deps || {});
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const appel = (srv, chemin, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: chemin,
    method: opts.method || 'GET', headers: opts.body ? { 'content-type': 'application/json' } : {} }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve({ code: res.statusCode, corps: JSON.parse(d || '{}') }); } catch (e) { reject(new Error('reponse non-JSON: ' + d.slice(0, 120))); } });
  });
  req.on('error', reject);
  if (opts.body) req.write(JSON.stringify(opts.body));
  req.end();
});

console.log('routes facture: le meme registre, une porte humaine');

(async () => {
  /* La chaine JETTE dans tous ces cas: aucun verdict `settled` n'est donc atteignable ici, et c'est
   * voulu — ce qui est teste est ce qui doit tenir MEME quand la chaine est indisponible. */
  const chaineMorte = { findPayment: async () => { throw new Error('RPC injoignable (voulu par le test)'); } };
  const srv = await demarrer(chaineMorte);

  t('POST /invoice cree une facture: total calcule par le module, URI de paiement, facture lisible', async () => {
    const r = await appel(srv, '/invoice', { method: 'POST', body: {
      to: MARCHAND, merchantName: 'BIII Labs', billTo: 'ACME Corp', number: 'INV-2026-001',
      lineItems: [{ description: 'Audit', amountUsd: '250' }, { description: 'Conseil', qty: 3, unitUsd: '80' }] } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corps).slice(0, 200));
    const creee = r.corps.invoice;
    assert.strictEqual(creee.totalUsd, '490.00', '250 + 3x80 — le total vient du module, pas de la page');
    assert.strictEqual(creee.totalMicro, '490000000');
    assert.ok(/^ethereum:/.test(r.corps.paymentURI), 'un EIP-681 doit sortir');
    assert.ok(typeof r.corps.bill === 'string' && r.corps.bill.length > 40, 'la facture lisible voyage');
  });

  t('★ un rail NON OBSERVABLE repond SANS toucher la chaine — la chaine est morte dans ce test', async () => {
    const r = await appel(srv, '/invoice-status?to=' + MARCHAND + '&totalMicro=490000000&rail=card');
    assert.strictEqual(r.code, 200, 'une facture carte ne doit dependre d AUCUN noeud: ' + JSON.stringify(r.corps).slice(0, 160));
    assert.strictEqual(r.corps.status.status, 'not_observable');
    assert.strictEqual(r.corps.fact, null);
    assert.ok(/NOTHING about this customer/i.test(r.corps.note), 'le refus doit dire que l absence n accuse personne');
  });

  t('★ le cas OPPOSE: sans rail nomme, la chaine EST interrogee — et sa panne se dit 502, pas « impaye »', async () => {
    const r = await appel(srv, '/invoice-status?to=' + MARCHAND + '&totalMicro=490000000');
    assert.strictEqual(r.code, 502, 'une panne de lecture n est pas un verdict: ' + JSON.stringify(r.corps).slice(0, 160));
    assert.ok(!/issued|overdue|unpaid/i.test(JSON.stringify(r.corps.status || {})), 'aucun statut ne doit sortir d une panne');
  });

  t('une echeance ILLISIBLE ne fabrique aucun verdict (Number("") vaut 0, Number("abc") vaut NaN)', async () => {
    for (const mauvaise of ['', 'abc', '-1', '0']) {
      const r = await appel(srv, '/invoice-status?to=' + MARCHAND + '&totalMicro=1000000&rail=cash&dueDateMs=' + encodeURIComponent(mauvaise));
      assert.strictEqual(r.code, 200, 'dueDateMs=' + JSON.stringify(mauvaise));
      assert.strictEqual(r.corps.status.status, 'not_observable',
        'dueDateMs=' + JSON.stringify(mauvaise) + ' ne doit pas basculer le verdict');
    }
  });

  t('entrees invalides: refus 400 qui DIT quoi envoyer, jamais un statut', async () => {
    for (const q of ['?to=pasuneadresse&totalMicro=1', '?to=' + MARCHAND, '?to=' + MARCHAND + '&totalMicro=0',
      '?to=' + MARCHAND + '&totalMicro=abc']) {
      const r = await appel(srv, '/invoice-status' + q);
      assert.strictEqual(r.code, 400, q);
      assert.ok(!r.corps.status, 'aucun statut ne doit accompagner un refus d entree: ' + q);
    }
  });

  t('★ ALLER-RETOUR: le total de la facture creee survit a la reconstruction du controle', async () => {
    /* La route de controle ne STOCKE rien: elle rebatit le document depuis l URL. Si le total ne
     * survit pas, les deux routes parlent de deux factures differentes.
     * ⛔ Ce cas CREE sa propre facture: les cas de ce fichier tournent en CONCURRENCE (ils sont
     * empiles puis attendus ensemble), donc dependre d'une variable posee par un autre cas etait un
     * ordre imagine — il rendait `null` et accusait la route. Un cas qui a besoin d'un etat le
     * fabrique lui-meme. */
    const cree = await appel(srv, '/invoice', { method: 'POST', body: { to: MARCHAND,
      lineItems: [{ description: 'Audit', amountUsd: '250' }, { description: 'Conseil', qty: 3, unitUsd: '80' }] } });
    assert.strictEqual(cree.code, 200, JSON.stringify(cree.corps).slice(0, 160));
    const total = cree.corps.invoice.totalMicro;
    assert.strictEqual(total, '490000000');
    const r = await appel(srv, '/invoice-status?to=' + MARCHAND + '&totalMicro=' + total + '&rail=cash');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.corps.status.status, 'not_observable');
    assert.strictEqual(r.corps.status.rail, 'cash', 'le rail doit voyager jusqu au statut');
  });

  t('POST /invoice refuse une saisie vide en le DISANT (400), sans inventer une facture a 0', async () => {
    const r = await appel(srv, '/invoice', { method: 'POST', body: { to: MARCHAND, lineItems: [] } });
    assert.strictEqual(r.code, 400, JSON.stringify(r.corps).slice(0, 160));
    assert.ok(!r.corps.invoice, 'aucune facture ne doit sortir d un refus');
  });

  await Promise.all(encours);
  srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
