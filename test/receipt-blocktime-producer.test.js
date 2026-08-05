#!/usr/bin/env node
'use strict';
/**
 * Le champ que les livres du marchand filtrent — est-il produit ?
 *
 * ─── ETAT AU 2026-08-05, APRES CORRECTION ────────────────────────────────────────────────────────
 * Ce fichier a d'abord CARACTERISE un defaut: `lib/chain.js` ne produisait aucun `blockTime`, donc
 * `till.receipt` posait `blockTime: null`, donc la coercition `Number(bt) || 0` — recopiee dans
 * ledger.js (x2), export.js (x2) et meter.js — datait le recu a l'epoque ZERO. `0 >= fromBlockTime`
 * etant faux pour toute fenetre reelle, un paiement PAYE, confirme et verifiable on-chain sortait des
 * livres SANS UN MOT, et le brut sortait court.
 *
 * Les cas ci-dessous ont ete MIS A JOUR (jamais supprimes — ils sont la borne du probleme) quand les
 * deux moities de la correction ont atterri:
 *   (a) chain.js lit `eth_getBlockByNumber` sur la branche PAYEE et rend un vrai `blockTime`;
 *   (b) ledger/export/meter partagent UNE regle de fenetre (ledger.windowRows) qui EXCLUT un recu sans
 *       date d'une fenetre datee — mais publie `undatedExcluded`, pour qu'aucun total ne soit tu.
 *
 * ⚠️ CE QUI RENDAIT LA CHOSE ATTEIGNABLE: `bin/biii-mcp.js` expose `fromBlockTime` aux appelants
 * (till_export:787, till_meter:797), donc la fenetre n'etait pas theorique. (till_roll, lui, n'a jamais
 * passe de fenetre — sa route datee n'existe que dans la bibliotheque.)
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

// La fenetre du test: « la journee du 8 juillet 2025 ». Le bloc tombe dedans.
const DEBUT = 1_752_000_000, FIN = 1_752_086_400, HORODATAGE = 1_752_003_600;

/**
 * Un vrai recu de transaction Base tel que l'RPC le rend — il ne porte PAS de date, seulement un
 * `blockNumber`. C'est `eth_getBlockByNumber` qui porte le `timestamp`, et `bloc` decide si ce noeud
 * accepte de le servir: c'est toute la difference entre un recu datable et un recu qui ne l'est pas.
 */
const rpc = ({ bloc } = {}) => async (url, opts) => {
  const { method, params } = JSON.parse(opts.body);
  const result = method === 'eth_blockNumber' ? '0x100'
    : method === 'eth_getTransactionReceipt'
      ? { status: '0x1', blockNumber: '0xfa',
        logs: [{ address: USDC, topics: [TRANSFER, pad(PAYEUR), pad(MARCHAND)], data: '0x' + (5_000_000).toString(16) }] }
      : method === 'eth_getBlockByNumber'
        ? (assert.strictEqual(params[0], '0xfa', 'on doit demander LE bloc du recu, pas un autre'),
          bloc === 'illisible' ? null : { timestamp: '0x' + bloc.toString(16) })
        : null;
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

/** Le noeud accepte la transaction mais REFUSE la lecture du bloc — le troisieme etat, celui qui compte. */
const rpcBlocEnPanne = () => async (url, opts) => {
  const { method } = JSON.parse(opts.body);
  if (method === 'eth_getBlockByNumber') throw new Error('rpc eth_getBlockByNumber HTTP 429');
  return rpc({ bloc: HORODATAGE })(url, opts);
};

/** Fait → verdict → recu, par le vrai chemin de production. */
async function produire(fetchImpl) {
  const fait = await verifyTxHash({ txHash: TX, fetchImpl });
  const charge = T.createCharge({ to: MARCHAND, amountUsd: '5', label: 'x', nowMs: 1 });
  const verdict = T.verifyPayment(charge, fait);
  const recu = T.receipt(charge, verdict, { merchantName: 'M' });
  return { fait, verdict, recu, lignes: [{ n: 1, no: 'R-1', receipt: recu }] };
}

async function main() {
  console.log('receipt: le champ que les livres filtrent est-il produit par la chaine ?');

  // ══ A. LE NOEUD SERT LE BLOC — la moitie (a) de la correction ════════════════════════════════
  const A = await produire(rpc({ bloc: HORODATAGE }));

  await t('★ le fait de chaine porte MAINTENANT un vrai blockTime (c etait la racine)', () => {
    assert.strictEqual(A.fait.paid, true, 'la fixture doit produire un paiement valide');
    /* AVANT: `undefined` — chain.js n'emettait aucune date et ce test verrouillait cette absence.
     * Il verrouille desormais sa PRESENCE: si chain.js cesse de dater, les livres redeviennent muets. */
    assert.strictEqual(A.fait.blockTime, HORODATAGE,
      'chain.js doit lire eth_getBlockByNumber sur la branche payee — obtenu ' + JSON.stringify(A.fait.blockTime));
  });

  await t('★ le recu produit porte donc une DATE, plus un null', () => {
    assert.strictEqual(A.verdict.paid, true, 'le verdict doit etre paye: ' + JSON.stringify(A.verdict.reason || ''));
    assert.strictEqual(A.recu.blockTime, HORODATAGE,
      'till.receipt doit relayer la date du fait — obtenu ' + JSON.stringify(A.recu.blockTime));
  });

  await t('★ AVEC une fenetre datee, le recu RESTE dans les livres du marchand', () => {
    const s = L.summary(A.lignes, { fromBlockTime: DEBUT, toBlockTime: FIN });
    /* LE COEUR DU DEFAUT, INVERSE. Ce `count` valait 0 et le brut valait '0' pour un paiement REEL et
     * confirme. S'il repasse a 0, la correction a ete defaite. */
    assert.strictEqual(s.count, 1, 'un paiement date dans la fenetre doit etre compte');
    assert.strictEqual(s.grossMicro, '5000000', 'le brut ne doit plus etre sous-evalue');
    assert.strictEqual(s.undatedExcluded, 0, 'rien n a ete ecarte: rien ne doit etre signale');
  });

  // ══ B. LE NOEUD REFUSE LE BLOC — la moitie (b), et la borne du probleme ══════════════════════
  // Un recu sans date n'a pas disparu du monde: recus historiques emis avant la correction, autres
  // producteurs, RPC rate-limite. C'est pour EUX que la divulgation existe.
  for (const [nom, impl] of [['bloc illisible', rpc({ bloc: 'illisible' })], ['lecture du bloc en panne', rpcBlocEnPanne()]]) {
    const B = await produire(impl);

    await t(`★ ${nom}: le reglement TIENT quand meme — on ne retracte pas un paiement prouve`, () => {
      /* FAIL-SOFT deliberement asymetrique: partout ailleurs chain.js est fail-closed, parce qu y echouer
       * voudrait dire affirmer un paiement non prouve. Ici le paiement est DEJA prouve quand on demande sa
       * date. Une date illisible vaut null — jamais Date.now(), jamais le numero de bloc deguise. */
      assert.strictEqual(B.fait.paid, true, 'une date illisible ne doit PAS annuler un paiement verifie');
      assert.strictEqual(B.fait.blockTime, null, 'et elle ne doit surtout pas etre inventee');
      assert.strictEqual(B.recu.blockTime, null);
    });

    await t(`${nom}: sans fenetre, le recu est bien compte — la borne haute, inchangee`, () => {
      const s = L.summary(B.lignes);
      assert.strictEqual(s.count, 1, 'une fenetre qui ne pose aucune date ne pose aucune question');
      assert.strictEqual(s.grossMicro, '5000000');
      assert.strictEqual(s.undatedExcluded, 0, 'rien n a ete ECARTE: la fenetre n excluait rien');
    });

    await t(`★ ${nom}: dans une fenetre datee il sort — mais il est DIT, plus escamote`, () => {
      const s = L.summary(B.lignes, { fromBlockTime: DEBUT, toBlockTime: FIN });
      /* Le recu sort toujours: sa date ne peut pas etre prouvee, et l'inclure gonflerait une periode
       * fiscale a laquelle il n'appartient peut-etre pas. Ce qui a change est qu'il ne sort plus EN
       * SILENCE. Un livre qui omet une ligne sans le dire est pire qu'un livre qui refuse: il a l'air
       * complet. C'est ce champ, et lui seul, qui separe les deux. */
      assert.strictEqual(s.count, 0, 'un recu indatable ne peut pas etre place dans une journee precise');
      assert.strictEqual(s.grossMicro, '0');
      assert.strictEqual(s.undatedExcluded, 1,
        'LA correction: le brut est court, et les livres le DISENT — obtenu ' + JSON.stringify(s.undatedExcluded));
    });

    await t(`★ ${nom}: le registre imprime l avertissement, pas seulement l objet`, () => {
      const roll = L.renderRoll(B.lignes, { merchantName: 'M', window: { fromBlockTime: DEBUT } });
      /* Une divulgation qui n'existe que dans un champ JSON ne protege pas le marchand qui lit le ticket.
       * Elle doit etre SUR le document dont elle corrige le total. */
      assert.ok(/no on-chain block time/i.test(roll), 'le registre doit porter la phrase:\n' + roll);
      assert.ok(/Receipts: 0/.test(roll), 'et garder le total honnete a cote');
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
