#!/usr/bin/env node
'use strict';
/**
 * UNE BORNE DE FENETRE ILLISIBLE REPOND-ELLE COMME « AUCUNE FENETRE DEMANDEE » ?
 * ================================================================================================
 * Mesure du 2026-08-09, a travers le vrai `callTool('till_export')` — pas une fixture de fenetre.
 * `bin/biii-mcp.js` gardait ses deux bornes derriere `Number.isFinite(a.fromBlockTime)`, un test de
 * TYPE et non une lecture: faux pour `"1783555200"`, une borne parfaitement valide telle que beaucoup
 * de clients JSON-RPC envoient les nombres. La borne rejetee laissait `window` vide, et `windowRows`
 * prenait alors sa sortie anticipee « aucune date demandee ». Trois recus, un seul dans la journee visee:
 *
 *   bornes valides (nombres) ... count=1  gross=10.00   <- la vraie reponse
 *   bornes "1783555200" ........ count=3  gross=75.00   <- 7,5x trop, MEME OCTET que « pas de fenetre »
 *   bornes "2026-07-08" ........ count=3  gross=75.00   <- idem
 *   aucune fenetre ............. count=3  gross=75.00
 *
 * Le comptable demandait le 8 juillet et recevait le total de TOUS LES TEMPS, avec `undatedExcluded: 0`
 * — « rien ne vous a ete tu ». Une lecture ratee rendait exactement ce que rend une lecture reussie.
 * Et `till_meter` portait les quatre MEMES lignes recopiees: la mauvaise fenetre devenait une FACTURE.
 *
 * Les deux bornes du sujet sont tenues ici, parce qu'un refus pousse trop loin cesse d'informer:
 *   · une borne PRESENTE mais illisible est REFUSEE (§A, §B) — on ne repond pas a une question datee
 *     par un total non date, et on ne consomme pas la demande avant de l'avoir validee;
 *   · une borne ABSENTE ne pose aucune question de date et garde TOUT (§C) — comportement historique.
 *
 * ⛔ Aucun reseau: les recus sont des objets, aucun RPC n'est touche.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../lib/ledger.js');
const { callTool, handleRpc } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

// Journee du 8 juillet 2026 en secondes unix. UN recu dedans, DEUX tres loin avant.
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
const AVANT_B = recu(3, 1_700_100_000, 40);
const RECUS = [DEDANS, AVANT_A, AVANT_B];

const empreinte = (r) => JSON.stringify({ count: r.summary.count, gross: r.summary.grossUsd,
  undated: r.summary.undatedExcluded });

async function main() {
  console.log('\nUNE BORNE ILLISIBLE NE REPOND PAS COMME UNE ABSENCE DE BORNE\n');

  /* ═══ §A — LE COMPORTEMENT, A TRAVERS LE PRODUCTEUR ════════════════════════════════════════════ */

  await t('★ bornes NOMBRES: seule la journee visee est comptee (le TEMOIN — il DOIT differer du reste)',
    async () => {
      const r = await callTool('till_export', { receipts: RECUS, fromBlockTime: DEBUT, toBlockTime: FIN });
      assert.strictEqual(r.summary.count, 1);
      assert.strictEqual(r.summary.grossUsd, '10.00');
    });

  await t('★ bornes NOMBRES vs AUCUNE borne: les deux sorties different vraiment '
    + '(sinon la sonde ne mesure rien et tout le fichier est vide)', async () => {
    const avec = await callTool('till_export', { receipts: RECUS, fromBlockTime: DEBUT, toBlockTime: FIN });
    const sans = await callTool('till_export', { receipts: RECUS });
    assert.notStrictEqual(empreinte(avec), empreinte(sans),
      'la fenetre ne filtre plus rien: le temoin est casse avant le sujet');
    assert.strictEqual(sans.summary.count, 3);
  });

  await t('★ bornes en CHAINES NUMERIQUES ("1783555200") sont LUES, pas jetees '
    + '— c etait le cas silencieux le plus probable en vrai', async () => {
    const r = await callTool('till_export',
      { receipts: RECUS, fromBlockTime: String(DEBUT), toBlockTime: String(FIN) });
    const nombres = await callTool('till_export',
      { receipts: RECUS, fromBlockTime: DEBUT, toBlockTime: FIN });
    assert.strictEqual(empreinte(r), empreinte(nombres),
      'une borne envoyee en chaine numerique doit donner EXACTEMENT la reponse des bornes nombres');
    assert.strictEqual(r.summary.count, 1);
  });

  await t('★ borne ILLISIBLE ("2026-07-08") est REFUSEE — jamais repondue par le total de tous les temps',
    async () => {
      await assert.rejects(
        () => callTool('till_export', { receipts: RECUS, fromBlockTime: '2026-07-08' }),
        (e) => /fromBlockTime/.test(e.message) && /unreadable/.test(e.message),
        'le refus doit NOMMER la borne fautive: un refus generique laisse l appelant deviner');
    });

  await t('★ le refus vaut aussi pour toBlockTime, et sur la route de FACTURATION (till_meter)',
    async () => {
      await assert.rejects(
        () => callTool('till_export', { receipts: RECUS, toBlockTime: 'hier' }), /toBlockTime/);
      await assert.rejects(
        () => callTool('till_meter', { receipts: RECUS, fromBlockTime: '2026-07-08' }), /fromBlockTime/);
      // et till_meter lit bien une chaine numerique, comme sa jumelle
      const m = await callTool('till_meter',
        { receipts: RECUS, fromBlockTime: String(DEBUT), toBlockTime: String(FIN) });
      assert.strictEqual(m.provable.settledReceipts, 1);
    });

  /* ═══ §B — LE REFUS ARRIVE-T-IL A L'AGENT, SANS TUER LE SERVEUR ? ══════════════════════════════ */

  await t('★ par handleRpc: le refus devient une erreur JSON-RPC rendue a l appelant '
    + '(un throw non rattrape tuerait la boucle stdio — pire que le defaut corrige)', async () => {
    const rep = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'till_export', arguments: { receipts: RECUS, fromBlockTime: '2026-07-08' } } });
    assert.ok(rep && rep.error, 'un refus doit remonter en error JSON-RPC, pas en result');
    assert.strictEqual(rep.id, 7);
    assert.ok(/fromBlockTime/.test(JSON.stringify(rep.error)),
      'l erreur rendue doit nommer la borne fautive');
    // le serveur repond encore APRES le refus — la boucle n est pas morte
    const apres = await handleRpc({ jsonrpc: '2.0', id: 8, method: 'ping' });
    assert.deepStrictEqual(apres, { jsonrpc: '2.0', id: 8, result: {} });
  });

  /* ═══ §C — L'AUTRE BORNE: NE PAS TRANSFORMER LE REFUS EN NOUVEAU DEFAUT ════════════════════════ */

  await t('★ AUCUNE borne = aucune question de date: tout est garde, undatedExcluded vaut 0 '
    + '(comportement historique, preserve exactement)', async () => {
    const r = await callTool('till_export', { receipts: RECUS });
    assert.strictEqual(r.summary.count, 3);
    assert.strictEqual(r.summary.undatedExcluded, 0);
    assert.deepStrictEqual(L.windowRows([{ receipt: DEDANS }], {}), { kept: [{ receipt: DEDANS }], undatedExcluded: 0 });
    assert.deepStrictEqual(L.windowRows([{ receipt: DEDANS }], undefined), { kept: [{ receipt: DEDANS }], undatedExcluded: 0 });
  });

  await t('★ un recu SANS date reste ecarte-en-le-disant sous une fenetre lue depuis des CHAINES '
    + '— la divulgation ne doit pas se perdre sur le nouveau chemin', async () => {
    const sansDate = recu(4, null, 7);
    const r = await callTool('till_export',
      { receipts: [DEDANS, sansDate], fromBlockTime: String(DEBUT), toBlockTime: String(FIN) });
    assert.strictEqual(r.summary.count, 1);
    assert.strictEqual(r.summary.undatedExcluded, 1);
    assert.ok(/no on-chain block time/.test(r.note), 'la phrase de divulgation doit atteindre l appelant');
  });

  /* ═══ §D — LA REGLE ELLE-MEME, CAS PAR CAS ════════════════════════════════════════════════════ */

  await t('★ boundStrict: la forme ATTENDUE est exigee, les vides ne deviennent pas ZERO', () => {
    assert.strictEqual(L.boundStrict(undefined, 'x'), null);
    assert.strictEqual(L.boundStrict(null, 'x'), null);
    assert.strictEqual(L.boundStrict(0, 'x'), 0);            // 0 est une borne basse legitime
    assert.strictEqual(L.boundStrict(1783555200, 'x'), 1783555200);
    assert.strictEqual(L.boundStrict('1783555200', 'x'), 1783555200);
    assert.strictEqual(L.boundStrict('  1783555200  ', 'x'), 1783555200);
    assert.strictEqual(L.boundStrict(1783555200n, 'x'), 1783555200);
    // `Number()` seul rendrait ZERO pour les cinq suivantes — une borne basse inventee de toutes pieces
    for (const v of ['', '   ', [], false, true, {}, NaN, Infinity, -Infinity, '12abc', '2026-07-08']) {
      assert.throws(() => L.boundStrict(v, 'fromBlockTime'), /fromBlockTime/,
        'doit refuser ' + JSON.stringify(String(v)) + ' au lieu de le coercer');
    }
  });

  /* ═══ §E — PLUS DE JUMELLE A DIVERGER ═════════════════════════════════════════════════════════ */

  await t('★ le test de TYPE qui jetait les bornes n est revenu dans aucune route de livres', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'biii-mcp.js'), 'utf8');
    assert.doesNotMatch(src, /Number\.isFinite\(a\.(from|to)BlockTime\)/,
      'une borne doit etre LUE par ledger.boundStrict, jamais filtree par un test de type qui '
      + 'rejette silencieusement "1783555200" et laisse repondre le total de tous les temps');
    // et les deux routes passent bien par LA lecture partagee
    // `= fenetreDe(a)` compte les APPELS sans compter la definition (`function fenetreDe(a)`), qui
    // matchait aussi et faisait attendre 3 la ou 2 routes appellent.
    assert.strictEqual((src.match(/=\s*fenetreDe\(a\)/g) || []).length, 2,
      'till_export ET till_meter doivent lire leurs bornes au MEME endroit');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
