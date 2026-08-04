#!/usr/bin/env node
'use strict';
/**
 * « Pas encore minee » n'est pas « n'existe pas sur Base ».
 *
 * `verifyTxHash` lit `eth_getTransactionReceipt` et repond, quand il rend null:
 *
 *     { found: false, paid: false, reason: 'transaction not found on Base' }
 *
 * Or un recu null est la reponse NORMALE du protocole pour une transaction encore en attente — c'est un
 * `result: null` legitime, pas une erreur, donc `rpc()` (qui jette bien sur !r.ok et sur j.error) le rend
 * tel quel. Les deux etats arrivent ici par le meme chemin et un seul est publie: celui qui accuse.
 *
 * Ce que ca coute, sur la route PAYANTE: l'appelant paie, appelle aussitot avec son txHash, et `settleOnce`
 * lui renvoie « no confirmed USDC payment on Base ». Un agent qui lit « la transaction n'existe pas » a une
 * raison de croire que son paiement a echoue et de REPAYER. Un agent qui lit « pas encore minee » attend.
 * La difference entre les deux phrases est une seconde mise.
 *
 * Les deux etats SONT distinguables pour un appel de plus: `eth_getTransactionByHash` rend la transaction
 * pour une pending et null pour une inconnue. Le champ `paid` ne bouge pas — il reste false dans les deux
 * cas, donc aucun consommateur ne change de branche. Seule la RAISON cesse d'affirmer plus qu'on ne sait.
 */
const assert = require('node:assert');
const { verifyTxHash } = require('../lib/chain');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const TX = '0x' + 'ab'.repeat(32);

/** Un faux RPC pilote par methode: c'est la seule facon d'atteindre ces etats sans la chaine. */
function faussRpc(parMethode) {
  return async (url, opts) => {
    const { method } = JSON.parse(opts.body);
    if (!(method in parMethode)) throw new Error('methode non stubbee: ' + method);
    const r = parMethode[method];
    if (r instanceof Error) throw r;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: r }) };
  };
}

async function main() {
  console.log('chain: une transaction en attente n\'est pas une transaction absente');

  await t('★ recu null MAIS transaction connue -> etat « en attente », jamais « introuvable »', async () => {
    const r = await verifyTxHash({ txHash: TX, fetchImpl: faussRpc({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: { hash: TX, blockNumber: null },   // minage en cours
    }) });
    assert.strictEqual(r.paid, false, 'une pending n est evidemment pas payee');
    assert.strictEqual(r.pending, true, 'l etat « en attente » doit exister et etre lisible');
    assert.ok(!/not found/i.test(r.reason || ''),
      'la raison ne doit pas affirmer l absence: ' + JSON.stringify(r.reason));
    assert.ok(/pending|not yet|mined/i.test(r.reason || ''), 'la raison doit NOMMER l attente');
  });

  // Le cas OPPOSE, sans lequel le precedent passerait aussi sur un code qui dirait « en attente » a tout
  // le monde — la sortie constante qui ressemble a une mesure.
  await t('★ recu null ET transaction inconnue -> toujours « introuvable »', async () => {
    const r = await verifyTxHash({ txHash: TX, fetchImpl: faussRpc({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: null,
    }) });
    assert.strictEqual(r.paid, false);
    assert.notStrictEqual(r.pending, true, 'une transaction inconnue n est pas en attente');
    assert.ok(/not found/i.test(r.reason || ''), 'l absence reelle se dit toujours');
  });

  await t('une transaction revertee reste revertee, pas en attente', async () => {
    const r = await verifyTxHash({ txHash: TX, fetchImpl: faussRpc({
      eth_getTransactionReceipt: { status: '0x0', blockNumber: '0x10', logs: [] },
    }) });
    assert.strictEqual(r.paid, false);
    assert.strictEqual(r.found, true);
    assert.ok(/revert/i.test(r.reason || ''));
  });

  /* Le garde du transport, verifie et NON corrige: `rpc()` jette sur !r.ok et sur j.error, donc une panne
   * RPC ne peut PAS se transformer en « transaction introuvable ». C'etait l'hypothese de depart de ce
   * sweep et elle est fausse — on l'ecrit dans la suite pour qu'un futur refactor qui remplacerait ce jet
   * par un `return null` fasse tomber un test au lieu de creer une fausse accusation en silence. */
  await t('★ une panne de transport JETTE — elle ne devient jamais un verdict sur la chaine', async () => {
    await assert.rejects(
      () => verifyTxHash({ txHash: TX, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
      /HTTP 503/, 'un 503 doit remonter, pas se lire « transaction not found »');
    await assert.rejects(
      () => verifyTxHash({ txHash: TX, fetchImpl: faussRpc({ eth_getTransactionReceipt: new Error('socket hang up') }) }),
      /socket hang up/, 'une coupure reseau doit remonter');
  });

  /* La couche du dessus. Un correctif que l'appelant ne voit pas n'est pas un correctif: `settleOnce`
   * ecrasait les trois raisons par un generique, donc l'etat distingue plus bas mourait ici. */
  await t('★ settleOnce fait REMONTER la raison au lieu de la remplacer par un generique', async () => {
    const { settleOnce } = require('../lib/x402-settle');
    const enAttente = settleOnce({ proof: { paid: false, pending: true, reason: 'transaction is known to the node but NOT yet mined (pending)' },
      merchant: '0x' + '11'.repeat(20), needMicro: '250000' });
    assert.strictEqual(enAttente.ok, false, 'une pending n est toujours pas un paiement');
    assert.strictEqual(enAttente.code, 402, 'et le refus reste un 402');
    assert.strictEqual(enAttente.pending, true, 'l etat doit survivre a la remontee');
    assert.ok(/pending|not yet mined/i.test(enAttente.reason), 'la raison precise doit atteindre l appelant');

    // Cas oppose: sans raison en entree, on ne fabrique pas de detail — et surtout pas « pending ».
    const nu = settleOnce({ proof: { paid: false }, merchant: '0x' + '11'.repeat(20), needMicro: '250000' });
    assert.strictEqual(nu.ok, false);
    assert.notStrictEqual(nu.pending, true, 'aucune pending inventee quand rien ne la signale');
    assert.ok(!/pending/i.test(nu.reason), 'pas de detail invente: ' + nu.reason);
  });

  await t('un txHash malforme est refuse avant tout appel reseau', async () => {
    const r = await verifyTxHash({ txHash: '0xnope', fetchImpl: async () => { throw new Error('ne doit pas etre appele'); } });
    assert.strictEqual(r.paid, false);
    assert.ok(/32-byte/i.test(r.reason || ''));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
