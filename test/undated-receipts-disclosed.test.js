#!/usr/bin/env node
'use strict';
/**
 * UN RECU SANS DATE EST-IL DIT — SUR LES TROIS ROUTES, ET JUSQU'A L'APPELANT ?
 * ================================================================================================
 * test/receipt-blocktime-producer.test.js prouve le defaut et sa correction a travers le PRODUCTEUR.
 * Ce fichier-ci garde les deux modes d'echec qui, dans ce depot, ont tue des corrections deja justes:
 *
 *   1. LA DIVERGENCE DES JUMELLES. La coercition `Number(receipt.blockTime) || 0` vivait en CINQ
 *      exemplaires (ledger.summary, ledger.renderRoll, export.inWindow, export.isoDate, meter.meterUsage).
 *      Reparer une route et pas ses soeurs est arrive quatre fois ici. On ne verifie donc pas seulement
 *      que les trois modules divulguent: on verifie qu'il ne reste PLUS DE COPIE de la coercition a
 *      diverger (§C — une lecture de la source, pas du comportement).
 *
 *   2. LA MORT A LA COUCHE DE MISE EN FORME. `export.buildExport` ne descend pas `summary` par spread:
 *      il recopie ses champs un par un. `meter` fait pareil pour `provable`. `bin/biii-mcp.js` est un
 *      whitelist — ce qu'il n'enumere pas n'existe pas pour l'agent au bout du fil. Un producteur
 *      correct dont la distinction n'atteint pas l'appelant n'est pas une correction (trois sont mortes
 *      ainsi le 2026-08-04). §B va donc jusqu'au callTool.
 *
 * ⛔ Aucun reseau: les recus sont des objets, aucun RPC n'est touche.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../lib/ledger.js');
const X = require('../lib/export.js');
const { meterUsage } = require('../lib/meter.js');
const { callTool } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const DEBUT = 1_752_000_000, FIN = 1_752_086_400, DEDANS = 1_752_003_600;

const recu = (h, blockTime) => ({
  v: 1, kind: 'basetill-receipt',
  merchant: { name: 'M', address: '0x' + '11'.repeat(20) },
  amountUsd: '5', amountMicro: '5000000', paidMicro: '5000000', overpaidMicro: '0',
  token: 'USDC', chainId: 8453, txHash: '0x' + String(h).repeat(64), payer: '0x' + 'ee'.repeat(20),
  tier: 'confirmed', blockTime,
});

// Un mois reel apres la correction: un recu DATE (nouveau producteur) et un recu SANS DATE (emis avant
// la correction, ou par un noeud dont la lecture de bloc a echoue). C'est le melange qui compte.
const DATE = recu(1, DEDANS);
const SANS_DATE = recu(2, null);
const LIGNES = [{ n: 1, no: 'B3-0001', receipt: DATE }, { n: 2, no: 'B3-0002', receipt: SANS_DATE }];
const FENETRE = { fromBlockTime: DEBUT, toBlockTime: FIN };

async function main() {
  console.log('undated: un recu indatable est-il DIT, sur les trois routes et jusqu a l appelant ?');

  // ══ A. LES TROIS MODULES ════════════════════════════════════════════════════════════════════
  console.log('\n  A. les trois modules ou vivait la coercition');

  await t('ledger.summary — compte 1, et DIT que 1 a ete ecarte', () => {
    const s = L.summary(LIGNES, FENETRE);
    assert.strictEqual(s.count, 1, 'le recu date reste');
    assert.strictEqual(s.grossMicro, '5000000');
    assert.strictEqual(s.undatedExcluded, 1, 'et l autre est SIGNALE, pas escamote');
  });

  await t('export.buildExport — le CSV est court d une ligne, et l objet le dit', () => {
    const ex = X.buildExport(LIGNES, { window: FENETRE });
    /* ⚠️ LA LIGNE OU LA CORRECTION SERAIT MORTE: buildExport recopie summary champ par champ. */
    assert.strictEqual(ex.summary.undatedExcluded, 1,
      'la projection de buildExport doit relayer le champ — sinon il est produit et n atteint personne');
    assert.strictEqual(ex.summary.count, 1);
    assert.ok(/no on-chain block time/i.test(ex.disclosure), 'et la divulgation doit le dire en clair');
    const lignesCsv = ex.csv.trim().split('\r\n');
    assert.strictEqual(lignesCsv.length, 2, 'entete + LA seule ligne datable');
  });

  await t('meter.meterUsage — la facture aussi, et elle dit qu elle est SOUS-facturee', () => {
    const m = meterUsage(LIGNES, { window: FENETRE, plan: { includedReceipts: 0, receiptOverageUsd: 1, monthlyBaseUsd: 0 } });
    assert.strictEqual(m.provable.settledReceipts, 1);
    assert.strictEqual(m.provable.undatedExcluded, 1,
      'un recu escamote SOUS-facture l operateur, et personne ne verifie une facture a la baisse');
    assert.ok(/no on-chain block time/i.test(m.disclosure));
  });

  await t('renderRoll — l avertissement est SUR le document, pas seulement dans un champ JSON', () => {
    const en = L.renderRoll(LIGNES, { merchantName: 'M', window: FENETRE });
    assert.ok(/no on-chain block time/i.test(en), 'en:\n' + en);
    const fr = L.renderRoll(LIGNES, { merchantName: 'M', lang: 'fr', window: FENETRE });
    assert.ok(/sans horodatage on-chain/i.test(fr), 'la version FR doit avertir aussi:\n' + fr);
  });

  await t('SANS fenetre, rien ne change et rien n est signale — la borne basse', () => {
    const s = L.summary(LIGNES);
    assert.strictEqual(s.count, 2, 'aucune date demandee ⇒ aucun recu ecarte');
    assert.strictEqual(s.undatedExcluded, 0, 'et donc rien a divulguer: le champ ne crie pas dans le vide');
    assert.ok(!/no on-chain block time/i.test(X.buildExport(LIGNES, {}).disclosure));
  });

  // ══ B. JUSQU'A L'APPELANT — le whitelist MCP ════════════════════════════════════════════════
  console.log('\n  B. la distinction atteint-elle l agent au bout du fil ?');

  await t('callTool(till_export) porte le compte ET le dit dans la note', async () => {
    const out = await callTool('till_export', { receipts: [DATE, SANS_DATE], fromBlockTime: DEBUT, toBlockTime: FIN });
    assert.strictEqual(out.summary.undatedExcluded, 1, 'le champ doit traverser le whitelist');
    assert.ok(/no on-chain block time/i.test(out.note), 'et la note — ce qu un appelant lit en premier: ' + out.note);
  });

  await t('callTool(till_meter) dit que le total est SOUS-facture', async () => {
    const out = await callTool('till_meter', { receipts: [DATE, SANS_DATE], fromBlockTime: DEBUT, toBlockTime: FIN });
    assert.strictEqual(out.provable.undatedExcluded, 1);
    assert.ok(/UNDER-charged/i.test(out.note), 'la note doit nommer le SENS de l erreur: ' + out.note);
  });

  await t('les descriptions d outils ENUMERENT la regle — sinon elle n existe pas pour l agent', async () => {
    const { TOOLS } = require('../bin/biii-mcp.js');
    for (const nom of ['till_export', 'till_meter']) {
      const d = (TOOLS.find((x) => x.name === nom) || {}).description || '';
      assert.ok(/undatedExcluded/.test(d), `${nom} doit nommer le champ dans sa description`);
      assert.ok(/block time/i.test(d), `${nom} doit expliquer POURQUOI un recu sort d une fenetre datee`);
    }
  });

  await t('till_roll garde la MEME forme, pour qu aucune route ne redevienne l exception', async () => {
    const out = await callTool('till_roll', { receipts: [DATE, SANS_DATE], merchantName: 'M' });
    assert.strictEqual(out.summary.undatedExcluded, 0, 'till_roll ne passe pas de fenetre ⇒ 0, mais le champ EXISTE');
    assert.strictEqual(out.summary.count, 2);
  });

  // ══ C. LA GARDE ANTI-DIVERGENCE ═════════════════════════════════════════════════════════════
  console.log('\n  C. la coercition peut-elle repousser quelque part ?');

  await t('★ aucune copie de `Number(...blockTime) || 0` ne subsiste dans lib/ ni bin/', () => {
    const racine = path.join(__dirname, '..');
    const fautifs = [];
    for (const rel of ['lib', 'bin']) {
      const dir = path.join(racine, rel);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        // On enleve les commentaires: ces fichiers CITENT la coercition pour expliquer pourquoi elle
        // est partie, et une citation ne doit pas faire echouer la garde.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Le motif exact du defaut: un blockTime coerce en nombre puis rabattu sur 0 par `||`.
        if (/Number\([^)]*blockTime[^)]*\)\s*\|\|\s*0/.test(code)) fautifs.push(rel + '/' + f);
      }
    }
    assert.deepStrictEqual(fautifs, [],
      'la coercition qui datait un recu absent a 1970 est revenue dans: ' + fautifs.join(', ')
      + '. Passer par ledger.windowRows / ledger.blockTimeOf — UNE definition, pour qu il n y ait plus'
      + ' de jumelle a diverger.');
  });

  await t('★ les trois modules passent bien par LA regle partagee (ledger.windowRows)', () => {
    const racine = path.join(__dirname, '..');
    for (const f of ['lib/export.js', 'lib/meter.js']) {
      const src = fs.readFileSync(path.join(racine, f), 'utf8');
      assert.ok(/windowRows/.test(src), f + ' doit filtrer par la regle partagee, pas par une copie locale');
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
