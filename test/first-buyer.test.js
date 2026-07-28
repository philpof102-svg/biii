'use strict';
/* first-buyer — « qui achète en premier », et depuis QUELLE origine on compte.
 *
 * ⚠️ POURQUOI CE FICHIER N'EXISTAIT PAS. `firstBuyOf` était exporté mais n'avait aucune couture
 * d'injection: un lecteur possible qui n'existait pas. Le seul chiffre que ce module produit,
 * `blocksAfterLp`, se mesure depuis une ancre résolue de DEUX façons très différentes —
 * `addLiquidity` LU dans le nom de méthode, ou « première transaction du déployeur » DEVINÉE — et rien
 * n'enregistrait laquelle avait servi. Si l'explorateur cesse de décoder les noms de méthode, tout le
 * corpus bascule sur l'heuristique, systématiquement et en silence.
 *
 * Run: node test/first-buyer.test.js
 */
const assert = require('node:assert');
const { firstBuyOf } = require('../hermes/economy/first-buyer.js');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const DEP = '0x' + 'd'.repeat(40);
const POOL = '0x' + 'p0'.repeat(20);
const ACHETEUR = '0x' + 'b0'.repeat(20);
const DESTINATAIRE = '0x' + 'c0'.repeat(20);   // le `to` du LOG — un contrat receptacle de bot
const TOKEN = '0x' + 'a'.repeat(40);

/* Une chaîne où les DEUX ancres existent et ne tombent PAS au même endroit:
 *   bloc  90  le déployeur envoie des tokens au pool (pré-financement, méthode non décodée)
 *   bloc 100  le déployeur crée la liquidité         (addLiquidityETH, LISIBLE)
 *   bloc 101  le pool sort des tokens                (le premier achat)
 * Ancre lue     -> origine 100 -> blocksAfterLp =  1
 * Ancre devinée -> origine  90 -> blocksAfterLp = 11
 * Le même achat, deux fois le même bloc, et un signal onze fois plus grand. */
const CHAINE = (avecMethode) => [
  { from: DEP, to: POOL, blockNumber: '90', functionName: '', hash: '0xpre' },
  { from: DEP, to: POOL, blockNumber: '100', functionName: avecMethode ? 'addLiquidityETH(address token)' : '', hash: '0xlp' },
  { from: POOL, to: DESTINATAIRE, blockNumber: '101', functionName: '', hash: '0xbuy' },
];

const explorateur = (txs, tx) => async (url) => {
  if (/\/api\/v2\/transactions\//.test(url)) {
    return tx === undefined
      ? { from: { hash: ACHETEUR, is_contract: false }, to: { hash: POOL, name: 'Router' }, value: '1000', method: 'swap' }
      : tx;
  }
  return txs === null ? null : { status: '1', result: txs };
};

(async () => {
  console.log('first-buyer — le nombre ne veut rien dire sans son origine:');

  await t('★ l ancre LUE est enregistrée comme telle', async () => {
    const r = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(CHAINE(true)) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ancre, 'addliquidity_lu');
    assert.strictEqual(r.lpBlock, 100);
    assert.strictEqual(r.blocksAfterLp, 1);
  });

  await t('★ l ancre DEVINÉE est enregistrée comme telle', async () => {
    const r = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(CHAINE(false)) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ancre, 'deployeur_devine', 'sans nom de méthode on TOMBE sur l heuristique — il faut le dire');
    assert.strictEqual(r.lpBlock, 90);
  });

  await t('★ LE CHOIX D ANCRE CHANGE LE CHIFFRE — ce n est pas une étiquette décorative', async () => {
    /* Le contrôle qui justifie tout ce correctif: si les deux ancres donnaient toujours le même nombre,
     * l enregistrer serait cosmétique. Ici le MÊME achat, au MÊME bloc, sort à 1 ou à 11. */
    const lu = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(CHAINE(true)) });
    const devine = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(CHAINE(false)) });
    assert.strictEqual(lu.buyBlock, devine.buyBlock, 'même achat des deux côtés — sinon on compare autre chose');
    assert.strictEqual(lu.blocksAfterLp, 1);
    assert.strictEqual(devine.blocksAfterLp, 11);
    assert.notStrictEqual(lu.ancre, devine.ancre);
  });

  await t('★ LA RÈGLE DU FICHIER: l acheteur est lu dans la TRANSACTION, pas dans le `to` du log', async () => {
    /* L erreur de 2026-07-27 sur PEEPS: le `to` du log était un contrat, et « un contrat a acheté » était
     * faux — `tx.from` était un EOA, le contrat n était que le réceptacle d un bot. */
    const r = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(CHAINE(true)) });
    assert.strictEqual(r.firstBuyer, ACHETEUR, 'le SIGNATAIRE');
    assert.strictEqual(r.logRecipient, DESTINATAIRE.toLowerCase(), 'le destinataire du log, gardé à part');
    assert.strictEqual(r.recipientDiffersFromSigner, true, 'et l écart est mesuré, pas affirmé');
  });

  await t('LES DEUX BORNES: « pas lu » et « lu, rien trouvé » restent distincts', async () => {
    const illisible = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(null) });
    assert.deepStrictEqual(illisible, { ok: false, reason: 'unread' }, 'un succès VIDE n est pas une donnée');
    const vide = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur([]) });
    assert.strictEqual(vide.reason, 'unread');
    /* Lu, mais aucune ancre repérable: c est une VRAIE lecture négative, et elle porte un autre nom. */
    const sansAncre = await firstBuyOf(TOKEN, null, { fetchImpl: explorateur([{ from: ACHETEUR, to: POOL, blockNumber: '1', functionName: '', hash: '0x1' }]) });
    assert.strictEqual(sansAncre.reason, 'no_lp_event');
  });

  await t('un lancement Uniswap V3 est REFUSÉ par son nom, pas deviné', async () => {
    /* Le garde né de la voie de secours qui avait fabriqué 13 réponses: toute la logique suppose V2, et
     * en V3 la liquidité est un NFT de position. Un `unknown` nommé vaut mieux qu un chiffre inventable. */
    const v3 = [
      { from: DEP, to: POOL, blockNumber: '100', functionName: 'addLiquidityETH(address)', hash: '0xlp' },
      { from: DEP, to: POOL, blockNumber: '101', functionName: 'multicall(bytes[])', hash: '0xmc' },
    ];
    const r = await firstBuyOf(TOKEN, DEP, { fetchImpl: explorateur(v3) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'uniswap_v3_launch');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
