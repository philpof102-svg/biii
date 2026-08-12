#!/usr/bin/env node
'use strict';
/**
 * UNE FENETRE INVERSEE REPOND-ELLE COMME UNE PERIODE SANS VENTE ?
 * ================================================================================================
 * Mesure du 2026-08-12, a travers le vrai `callTool('till_export')` — pas une fixture de fenetre.
 * Trois recus, un seul dans la journee visee:
 *
 *   aucune fenetre ........................ count=3  gross=75.00  undatedExcluded=0
 *   jour du 8 juillet (bornes correctes) .. count=1  gross=10.00  undatedExcluded=0
 *   bornes INVERSEES (from > to) .......... count=0  gross=0.00   undatedExcluded=0   <-- le defaut
 *   journee reellement sans vente ......... count=0  gross=0.00   undatedExcluded=0
 *
 * Les deux dernieres lignes sont identiques OCTET POUR OCTET. Un comptable qui intervertit ses deux
 * bornes — la faute de saisie la plus banale sur une paire de dates — s'entendait donc dire que le
 * commerce n'avait rien encaisse, avec `undatedExcluded: 0` qui AFFIRME en plus que rien ne lui a ete
 * tu. Et `till_meter` porte la meme regle de fenetre: la meme inversion sortait une FACTURE a zero
 * recu facturable. Une lecture ratee de la DEMANDE rendait exactement ce que rend une mesure reussie
 * et vide — la forme que ce depot chasse.
 *
 * ⛔ CE FICHIER TRANCHAIT DEJA LE CAS JUMEAU CORRECTEMENT, et c'est ce qui rend le diagnostic sur:
 * `meter.js` REFUSE un `verdictCount` negatif, au motif qu'« un compte negatif n'est pas un compte bas,
 * c'est un rapport malforme, et le ramener a 0 facturerait comme si l'operateur avait honnetement
 * declare zero ». Une fenetre inversee est ce meme argument du cote de la fenetre.
 *
 * Les deux bornes du sujet sont tenues ici, parce qu'un refus pousse trop loin cesse d'informer. Le
 * critere retenu est « VIDE PAR CONSTRUCTION », pas « bizarre »:
 *   · §A/§B — une fenetre ou AUCUNE donnee ne peut tomber, quelle que soit la donnee, est REFUSEE;
 *   · §C — `from === to` (une seconde) est etroite, pas impossible: elle rend son recu;
 *           `fromBlockTime: -1` SEUL rend TOUT et ce n'est PAS un defaut — une borne basse negative
 *           est lisible, et sa reponse litterale (« au moins -1 ») est vraie. Mesure du meme jour.
 *
 * ⛔ Aucun reseau: les recus sont des objets, aucun RPC n'est touche.
 */
const assert = require('node:assert');

const L = require('../lib/ledger.js');
const { callTool, handleRpc } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

// Journee du 8 juillet 2026 en secondes unix. UN recu dedans, DEUX ailleurs.
const DEBUT = 1_783_555_200, FIN = 1_783_641_599;
const recu = (h, blockTime, usd) => ({
  v: 1, kind: 'basetill-receipt',
  merchant: { name: 'M', address: '0x' + '11'.repeat(20) },
  amountUsd: usd.toFixed(2), amountMicro: String(usd * 1e6), paidMicro: String(usd * 1e6),
  overpaidMicro: '0', token: 'USDC', chainId: 8453,
  txHash: '0x' + String(h).repeat(64), payer: '0x' + 'ee'.repeat(20), tier: 'confirmed', blockTime,
});
const DEDANS = recu(1, 1_783_600_000, 10);
const AVANT_A = recu(2, 1_700_000_000, 25);
const APRES_B = recu(3, 1_783_755_200, 40);
const RECUS = [DEDANS, AVANT_A, APRES_B];

const empreinte = (r) => JSON.stringify({ count: r.summary.count, gross: r.summary.grossUsd,
  undated: r.summary.undatedExcluded });

async function main() {
  console.log('\nUNE FENETRE VIDE PAR CONSTRUCTION N EST PAS UNE PERIODE SANS VENTE\n');

  /* ═══ §A — LE COMPORTEMENT, A TRAVERS LE PRODUCTEUR ════════════════════════════════════════════ */

  await t('★ le TEMOIN: bornes correctes vs aucune borne, les deux sorties different vraiment '
    + '(sinon la sonde ne mesure rien et tout le fichier est vide)', async () => {
    const avec = await callTool('till_export', { receipts: RECUS, fromBlockTime: DEBUT, toBlockTime: FIN });
    const sans = await callTool('till_export', { receipts: RECUS });
    assert.notStrictEqual(empreinte(avec), empreinte(sans),
      'la fenetre ne filtre plus rien: le temoin est casse avant le sujet');
    assert.strictEqual(avec.summary.count, 1);
    assert.strictEqual(avec.summary.grossUsd, '10.00');
    assert.strictEqual(sans.summary.count, 3);
  });

  await t('★ bornes INVERSEES (from > to) sont REFUSEES — jamais repondues par des livres vides',
    async () => {
      await assert.rejects(
        () => callTool('till_export', { receipts: RECUS, fromBlockTime: FIN, toBlockTime: DEBUT }),
        (e) => /fromBlockTime/.test(e.message) && /toBlockTime/.test(e.message)
          && e.invalidParams === true,
        'le refus doit NOMMER les deux bornes et se declarer invalidParams: un refus generique laisse '
        + 'l appelant deviner, et sans le drapeau il ressort en « failed » nu');
    });

  await t('★ le refus NOMME les deux valeurs recues — un comptable doit voir QUOI intervertir',
    async () => {
      await assert.rejects(
        () => callTool('till_export', { receipts: RECUS, fromBlockTime: FIN, toBlockTime: DEBUT }),
        (e) => e.message.includes(String(FIN)) && e.message.includes(String(DEBUT)));
    });

  await t('★ `toBlockTime: -1` SEUL est la meme classe (0 > -1) et est refuse aussi — il rendait '
    + 'lui aussi count=0 gross=0.00, indiscernable d une journee calme', async () => {
    await assert.rejects(
      () => callTool('till_export', { receipts: RECUS, toBlockTime: -1 }),
      (e) => e.invalidParams === true);
  });

  await t('★ le refus vaut sur la route de FACTURATION (till_meter) — la meme inversion sortait '
    + 'une facture a zero recu facturable', async () => {
    await assert.rejects(
      () => callTool('till_meter', { receipts: RECUS, fromBlockTime: FIN, toBlockTime: DEBUT }),
      (e) => e.invalidParams === true && /fromBlockTime/.test(e.message));
    // et la fenetre correcte facture toujours son unique recu: le refus n a pas mange la route
    const m = await callTool('till_meter', { receipts: RECUS, fromBlockTime: DEBUT, toBlockTime: FIN });
    assert.strictEqual(m.provable.settledReceipts, 1);
  });

  await t('★ la regle est UNE — les routes qui ne passent pas par callTool refusent aussi '
    + '(summary, renderRoll, buildExport: quatre appelants, une seule definition)', () => {
    const rows = [{ no: 'B3-0001', receipt: DEDANS }];
    const fenetre = { fromBlockTime: FIN, toBlockTime: DEBUT };
    for (const [nom, fn] of [
      ['ledger.windowRows', () => L.windowRows(rows, fenetre)],
      ['ledger.summary', () => L.summary(rows, fenetre)],
      ['ledger.renderRoll', () => L.renderRoll(rows, { window: fenetre })],
      ['export.buildExport', () => require('../lib/export.js').buildExport([DEDANS], { window: fenetre })],
    ]) {
      assert.throws(fn, (e) => e.invalidParams === true,
        nom + ' doit refuser une fenetre inversee: une seule route qui l accepte fabrique des livres '
        + 'vides que rien ne distingue d une periode calme');
    }
  });

  /* ═══ §B — LE REFUS ARRIVE-T-IL A L'AGENT, SANS TUER LE SERVEUR ? ══════════════════════════════ */

  await t('★ par handleRpc: -32602 rendu a l appelant (un throw non rattrape tuerait la boucle stdio)',
    async () => {
      const rep = await handleRpc({ jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'till_export', arguments: { receipts: RECUS, fromBlockTime: FIN, toBlockTime: DEBUT } } });
      assert.ok(rep && rep.error, 'un refus doit remonter en error JSON-RPC, pas en result');
      assert.strictEqual(rep.id, 11);
      assert.strictEqual(rep.error.code, -32602,
        '-32602 est le code du protocole pour un parametre invalide; -32000 renverrait l appelant '
        + 'soupconner une panne amont');
      assert.ok(/fromBlockTime/.test(rep.error.message), 'l erreur rendue doit nommer la borne fautive');
      // le serveur repond encore APRES le refus — la boucle n est pas morte
      const apres = await handleRpc({ jsonrpc: '2.0', id: 12, method: 'ping' });
      assert.deepStrictEqual(apres, { jsonrpc: '2.0', id: 12, result: {} });
    });

  /* ═══ §C — L'AUTRE BORNE: NE PAS TRANSFORMER LE REFUS EN NOUVEAU DEFAUT ════════════════════════ */

  await t('★ `from === to` (fenetre d une seconde) est ETROITE, pas impossible: elle rend son recu',
    async () => {
      const r = await callTool('till_export',
        { receipts: RECUS, fromBlockTime: DEDANS.blockTime, toBlockTime: DEDANS.blockTime });
      assert.strictEqual(r.summary.count, 1);
      assert.strictEqual(r.summary.grossUsd, '10.00');
    });

  await t('★ `fromBlockTime: -1` SEUL rend TOUT et n est PAS refuse — une borne basse negative est '
    + 'LISIBLE, et sa reponse litterale est vraie (mesure du 2026-08-12, ce n est pas un defaut)',
    async () => {
      const r = await callTool('till_export', { receipts: RECUS, fromBlockTime: -1 });
      assert.strictEqual(r.summary.count, 3);
      assert.strictEqual(r.summary.grossUsd, '75.00');
    });

  await t('★ une journee REELLEMENT sans vente rend toujours des livres vides — le refus ne doit pas '
    + 'avoir avale le cas legitime qu il fallait justement pouvoir distinguer', async () => {
    const r = await callTool('till_export',
      { receipts: RECUS, fromBlockTime: DEBUT + 10 * 86400, toBlockTime: DEBUT + 11 * 86400 });
    assert.strictEqual(r.summary.count, 0);
    assert.strictEqual(r.summary.grossUsd, '0.00');
    assert.strictEqual(r.summary.undatedExcluded, 0);
  });

  await t('★ aucune borne = aucune question de date: tout est garde (comportement historique)', async () => {
    const r = await callTool('till_export', { receipts: RECUS });
    assert.strictEqual(r.summary.count, 3);
    assert.strictEqual(r.summary.undatedExcluded, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
