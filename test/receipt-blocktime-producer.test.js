#!/usr/bin/env node
'use strict';
/**
 * Le champ que les livres du marchand filtrent — est-il produit ?
 *
 * `ledger.summary()` est decrit comme « the merchant's provable books for a window », et il filtre par
 * `Number(e.receipt.blockTime) || 0`. Quatre modules font la meme coercition: ledger.js (x2),
 * export.js (x2), meter.js. Un horodatage absent y devient donc l'epoque ZERO, et `0 >= fromBlockTime`
 * est FAUX des qu'une fenetre datee est demandee: le recu disparait des comptes, en silence, et le
 * total brut est sous-evalue.
 *
 * ⚠️ CE QUI REND LA CHOSE ATTEIGNABLE: `bin/biii-mcp.js` expose `fromBlockTime` aux appelants
 * (till_export_receipts, till_till_roll), donc la fenetre n'est pas theorique.
 *
 * ⚠️ ET POURQUOI AUCUN TEST NE L'ATTRAPAIT: les suites existantes FABRIQUENT leurs recus avec un
 * `blockTime` ecrit a la main (test/export.test.js:19 pose 1_752_000_000). Un test qui fabrique son
 * entree ne prouve rien sur ce que le PRODUCTEUR emet. Ce fichier passe donc par la chaine reelle —
 * `chain.verifyTxHash` puis `till.verifyPayment` puis `till.receipt` — et regarde ce qui en sort.
 *
 * ⛔ Aucun reseau: le RPC est injecte.
 */
const assert = require('node:assert');
const { verifyTxHash } = require('../lib/chain.js');
const T = require('../lib/till.js');
const L = require('../lib/ledger.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const USDC = T.USDC_BASE;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MARCHAND = '0x' + '11'.repeat(20);
const PAYEUR = '0x' + 'ee'.repeat(20);
const TX = '0x' + 'ab'.repeat(32);
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);

/** Un vrai recu de transaction Base, tel que l'RPC le rend — et il n'a PAS de champ blockTime. */
const rpc = () => async (url, opts) => {
  const { method } = JSON.parse(opts.body);
  const result = method === 'eth_blockNumber' ? '0x100'
    : method === 'eth_getTransactionReceipt'
      ? { status: '0x1', blockNumber: '0xfa',
        logs: [{ address: USDC, topics: [TRANSFER, pad(PAYEUR), pad(MARCHAND)], data: '0x' + (5_000_000).toString(16) }] }
      : null;
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

async function main() {
  console.log('receipt: le champ que les livres filtrent est-il produit par la chaine ?');

  const fait = await verifyTxHash({ txHash: TX, fetchImpl: rpc() });

  await t('★ le fait de chaine ne porte AUCUN blockTime — c est la racine', () => {
    assert.strictEqual(fait.paid, true, 'la fixture doit produire un paiement valide');
    assert.strictEqual(fait.blockTime, undefined,
      'si la chaine se met a rendre blockTime, ce test doit tomber pour qu on relise les consommateurs');
  });

  const charge = T.createCharge({ to: MARCHAND, amountUsd: '5', label: 'x', nowMs: 1 });
  const verdict = T.verifyPayment(charge, fait);
  const recu = T.receipt(charge, verdict, { merchantName: 'M' });

  await t('★ le recu produit porte donc blockTime NULL, pas un horodatage', () => {
    assert.strictEqual(verdict.paid, true, 'le verdict doit etre paye: ' + JSON.stringify(verdict.reason || ''));
    assert.strictEqual(recu.blockTime, null,
      'attendu null (le producteur ne sait pas dater) — obtenu ' + JSON.stringify(recu.blockTime));
  });

  const lignes = [{ n: 1, no: 'R-1', receipt: recu }];

  await t('sans fenetre, le recu est bien compte — la borne haute du comportement', () => {
    const s = L.summary(lignes);
    assert.strictEqual(s.count, 1, 'un recu paye doit apparaitre dans des livres non fenetres');
    assert.strictEqual(s.grossMicro, '5000000');
  });

  await t('★ AVEC une fenetre datee, le recu DISPARAIT des livres du marchand', () => {
    // Une fenetre parfaitement raisonnable: « la journee du 8 juillet 2025 ».
    const s = L.summary(lignes, { fromBlockTime: 1_752_000_000, toBlockTime: 1_752_086_400 });
    /* C'est le coeur du defaut. `blockTime: null` devient 0, et 0 < fromBlockTime, donc un paiement
     * REEL et confirme sort des comptes sans un mot. Le total brut est sous-evalue et rien ne le dit. */
    assert.strictEqual(s.count, 0, 'comportement actuel — si ce chiffre change, le defaut est corrige');
    assert.strictEqual(s.grossMicro, '0', 'le brut est SOUS-EVALUE: un paiement recu, compte pour zero');
  });

  await t('★ et rien dans la sortie ne signale que des recus ont ete ECARTES faute de date', () => {
    const s = L.summary(lignes, { fromBlockTime: 1_752_000_000 });
    const cles = Object.keys(s).join(' ');
    /* Le test n'exige pas encore un champ precis — il constate qu'AUCUN ne dit l'exclusion. Un livre
     * qui omet une ligne sans le dire est pire qu'un livre qui refuse: il a l'air complet. */
    assert.ok(!/undated|sansDate|excluded|unreadable/i.test(cles),
      'constat du 2026-08-05: aucun champ de divulgation. Si un est ajoute, mettre ce cas a jour '
      + 'plutot que de le supprimer — c est la borne du probleme.');
    assert.strictEqual(s.count, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
