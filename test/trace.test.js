#!/usr/bin/env node
'use strict';
/**
 * trace — the module written during a real theft, at 14 % coverage until today.
 *
 * WHAT IT DOES AND WHY THE STAKES ARE UNUSUAL HERE
 * It follows stolen funds across chains. Everything it produces ends up in a document a person reads about
 * their own loss, or shows to somebody else. A bug in this file does not return a wrong number — it names a
 * WRONG ADDRESS, and a wrong address in a theft report is an accusation pointed at whoever happens to hold it.
 *
 * THE TWO FAULTS THE MODULE WAS BUILT AROUND, both pinned below:
 *
 *   1. A CHAIN ID READS AS AN AMOUNT. The bridge exit in the real case carried `0x2b6653dc` = 728126428,
 *      TRON mainnet. Read as a token amount at six decimals it is 728.13 — entirely plausible in a report.
 *      Misreading it cost an hour and produced a confident wrong answer. Chain ids are therefore checked
 *      against a table BEFORE any field is called an amount.
 *   2. TRANSCRIBING AN ADDRESS BY HAND. TRON explorers disagree about whether they hand back base58 or
 *      0x41-prefixed hex, so both directions exist here — precisely so nobody retypes one. The conversion is
 *      base58check over a 21-byte payload, which is easy to get subtly and silently wrong.
 *
 * ⚠️ A ROUND-TRIP TEST THAT ONLY CHECKS ITSELF PROVES NOTHING: hexToTron(tronToHex(x)) === x holds even if
 * both directions share the same bug. So the fixtures below are anchored on an address whose base58 form is
 * publicly documented OUTSIDE this codebase — the USDT-TRC20 contract — and the round-trip is checked
 * against THAT, not against its own output.
 *
 * No network: only the pure functions are exercised here.
 */
const assert = require('node:assert');
const { hexToTron, tronToHex, CHAIN_IDS, EVM } = require('../lib/trace.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

/* Temoin EXTERNE: le contrat USDT-TRC20. Sa forme base58 est publique et verifiable ailleurs que dans ce
 * depot, donc elle ancre la conversion sur autre chose que sur elle-meme. */
const USDT_B58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

console.log('trace: une adresse fausse dans un rapport de vol accuse quelqu un');

t('base58 -> hex donne la valeur ATTENDUE, pas seulement une valeur', () => {
  /* L assertion qui compte: on compare a une constante connue de l exterieur. Un aller-retour seul
   * passerait meme si les deux sens partageaient la meme erreur. */
  assert.strictEqual(tronToHex(USDT_B58), USDT_HEX);
});

t('hex -> base58 redonne exactement l adresse publique', () => {
  assert.strictEqual(hexToTron(USDT_HEX), USDT_B58);
});

t('le prefixe TRON 0x41 est present et obligatoire', () => {
  assert.ok(USDT_HEX.startsWith('41'), 'la forme hex TRON porte 0x41 en tete');
  // 21 octets: 1 de prefixe + 20 d adresse
  assert.strictEqual(USDT_HEX.length / 2, 21);
});

t('une charge utile SANS le prefixe 0x41 est refusee, pas convertie', () => {
  /* Une adresse EVM fait 20 octets et n a pas de prefixe. La convertir en base58 produirait une chaine
   * bien formee designant une adresse TRON qui n a rien a voir — le pire cas possible ici. */
  const evm = '0x' + 'a1'.repeat(20);
  assert.strictEqual(hexToTron(evm), null, 'une adresse EVM ne se convertit pas en TRON');
  assert.strictEqual(hexToTron('00' + USDT_HEX.slice(2)), null, 'mauvais prefixe -> null');
});

t('une longueur incorrecte est refusee', () => {
  for (const mauvais of ['41', '41a6', USDT_HEX + 'ff', USDT_HEX.slice(0, -2), '', '0x']) {
    assert.strictEqual(hexToTron(mauvais), null, JSON.stringify(mauvais.slice(0, 12)));
  }
});

t('une base58 mal formee est refusee — jamais une conversion approximative', () => {
  for (const mauvais of [
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6',      // un caractere de moins
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tX',    // un de plus
    'XR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',     // ne commence pas par T
    '0x' + 'a1'.repeat(20),                    // une adresse EVM
    '', null, undefined,
  ]) {
    assert.strictEqual(tronToHex(mauvais), null, JSON.stringify(String(mauvais).slice(0, 16)));
  }
});

t('les caracteres ambigus sont hors de l alphabet base58 (0, O, I, l)', () => {
  /* base58 les exclut justement pour qu une adresse recopiee a l oeil ne devienne pas une autre adresse
   * valide. Si l implementation les acceptait, une faute de frappe designerait quelqu un d autre. */
  for (const c of ['0', 'O', 'I', 'l']) {
    const truque = 'T' + c + USDT_B58.slice(2);
    assert.strictEqual(tronToHex(truque), null, 'le caractere ambigu "' + c + '" doit etre refuse');
  }
});

console.log('\nle piege qui a coute une heure: un identifiant de chaine lu comme un montant');

t('0x2b6653dc est TRON dans la table, et vaut 728126428', () => {
  const v = 0x2b6653dc;
  assert.strictEqual(v, 728126428);
  assert.strictEqual(CHAIN_IDS[v], 'tron', "l'id de chaine doit se resoudre AVANT toute lecture en montant");
});

t('lu comme un montant, ce meme mot donne un chiffre parfaitement credible', () => {
  /* C est ce qui rend la faute dangereuse: elle ne produit pas une valeur absurde qu on remarquerait. */
  const commeMontant = 0x2b6653dc / 1e6;
  assert.ok(commeMontant > 100 && commeMontant < 10000,
    'un montant plausible (' + commeMontant.toFixed(2) + ') — donc rien ne signale l erreur');
});

t('la table couvre les chaines qui apparaissent vraiment dans du calldata de pont', () => {
  for (const [id, nom] of [[1, 'ethereum'], [8453, 'base'], [137, 'polygon'], [42161, 'arbitrum'],
    [10, 'optimism'], [56, 'bsc'], [728126428, 'tron']]) {
    assert.strictEqual(CHAIN_IDS[id], nom, 'chaine ' + id);
  }
  assert.ok(CHAIN_IDS[1151111081099710], 'solana, dont l id ne ressemble a aucun montant');
});

t('un mot qui n est PAS un id de chaine ne se resout pas par hasard', () => {
  /* Sinon la table transformerait n importe quel montant en "chaine", ce qui serait la faute inverse et
   * tout aussi fausse. */
  for (const nonId of [0, 2, 999, 123456, 1e18]) {
    if (CHAIN_IDS[nonId]) assert.fail(nonId + ' ne devrait pas etre un id de chaine connu');
  }
});

console.log('\nles explorateurs cables, et ce qui arrive aux autres');

t('chaque chaine EVM cablee a une URL https absolue', () => {
  const chaines = Object.keys(EVM);
  assert.ok(chaines.length >= 5, 'au moins cinq chaines, vu ' + chaines.length);
  for (const [nom, url] of Object.entries(EVM)) {
    assert.match(url, /^https:\/\/[^\s]+\/api\/v2$/, nom + ' -> ' + url);
  }
});

t('base est cable, et sur le bon explorateur', () => {
  assert.match(EVM.base, /base\.blockscout\.com/);
});

t('une chaine inconnue n a pas d entree — elle ne doit pas retomber sur une autre', () => {
  /* Retomber silencieusement sur un explorateur par defaut irait chercher une transaction sur la mauvaise
   * chaine et rendrait "introuvable" pour une raison qui n a rien a voir. */
  assert.strictEqual(EVM.dogecoin, undefined);
  assert.strictEqual(EVM.tron, undefined, 'TRON n est pas EVM et a son propre chemin');
});

/* ── whatMoved : « rien deplace » et « pas pu lire » sortaient identiques ───────────────────────────
 * Ce module a servi a tracer un vol reel, et sa question est litteralement « qu'est-ce qui a bouge ? ».
 * Deux defauts mesures le 2026-07-28, `lireJson` injecte, aucun reseau :
 *
 * 1. `((xfers && xfers.items) || [])` coalescait un ECHEC de lecture sur le tableau vide. La sortie
 *    portait `ok:true, transfers:[], forgedTransfers:0` — indiscernable d'une transaction qui ne bouge
 *    reellement aucun jeton. Le silence d'un endpoint devenait une phrase sur un flux de fonds.
 *
 * 2. `const dec = (t.total && t.total.decimals) || 18` faisait d'une decimale ABSENTE une mesure, et
 *    cette valeur DIVISE le montant : sur de l'USDC (6 decimales) un champ manquant rendait
 *    0.000000000001 au lieu de 1 — faux de douze ordres de grandeur, sans rien pour le signaler. Le
 *    meme `|| 18` avalait le zero legitime des jetons a 0 decimale (5 devenait 5e-18).
 *
 * ⚠️ Le harnais `t` de ce fichier est SYNCHRONE. On calcule donc tout par `await` AVANT, puis on assertit
 * sur les valeurs : `t('...', async () => ...)` ne pourrait jamais echouer, et la garde de la suite le
 * signalerait a juste titre. */
const { whatMoved } = require('../lib/trace.js');

(async () => {
  const TX = '0x' + 'ab'.repeat(32);
  const SIGNEUR = '0x' + '11'.repeat(20);
  const TIERS = '0x' + '99'.repeat(20);
  const tx = { hash: TX, from: { hash: SIGNEUR }, to: { hash: '0x' + '22'.repeat(20) },
    timestamp: '2026-07-28T00:00:00Z', value: '0' };
  const transfert = (from, dec, val) => ({ from: { hash: from }, to: { hash: '0x' + '33'.repeat(20) },
    token: { symbol: 'USDC' }, total: { decimals: dec, value: val } });
  /* Le bouchon distingue les DEUX endpoints: c'est le second qui peut mourir seul. */
  const rpc = (second) => async (url) => (url.includes('token-transfers') ? second : tx);

  const usdc = await whatMoved('base', TX, rpc({ items: [transfert(SIGNEUR, 6, '1000000')] }));
  const sansDec = await whatMoved('base', TX, rpc({ items: [transfert(SIGNEUR, undefined, '1000000')] }));
  const zeroDec = await whatMoved('base', TX, rpc({ items: [transfert(SIGNEUR, 0, '5')] }));
  const vide = await whatMoved('base', TX, rpc({ items: [] }));
  const nonLue = await whatMoved('base', TX, rpc(null));
  const forge = await whatMoved('base', TX, rpc({ items: [transfert(TIERS, 6, '1000000')] }));

  t('un montant lisible est mis a l echelle correctement', () => {
    assert.strictEqual(usdc.transfers[0].amount, 1);
    assert.strictEqual(usdc.transfers[0].decimals, 6);
  });

  t('une decimale ABSENTE ne devient pas 18 — le montant est null, pas invente', () => {
    assert.strictEqual(sansDec.transfers[0].amount, null);
    assert.strictEqual(sansDec.transfers[0].decimals, null);
    assert.match(sansDec.transfers[0].amountUnread, /wrong amount travels further than a missing one/);
    /* Le brut voyage: un lecteur peut refaire le calcul lui-meme au lieu de nous croire. */
    assert.strictEqual(sansDec.transfers[0].rawValue, '1000000');
  });

  t('un jeton a 0 decimale garde son montant (le `|| 18` l avalait)', () => {
    assert.strictEqual(zeroDec.transfers[0].amount, 5);
    assert.strictEqual(zeroDec.transfers[0].decimals, 0);
  });

  t('« rien deplace » et « pas pu lire » ne sortent plus pareil', () => {
    assert.strictEqual(vide.transfersRead, true);
    assert.strictEqual(nonLue.transfersRead, false);
    assert.strictEqual(vide.transfers.length, 0);
    assert.strictEqual(nonLue.transfers.length, 0);
    /* ⚠️ Le coeur: memes tableaux vides, etats OPPOSES. Sans cette paire, coller `transfersRead: true`
     * en dur passerait au vert. */
    assert.notStrictEqual(vide.transfersRead, nonLue.transfersRead);
    assert.strictEqual(vide.transfersNote, null);
    assert.match(nonLue.transfersNote, /not because nothing moved/);
  });

  t('un evenement dont le signataire n est pas l emetteur reste marque FORGE', () => {
    /* La regle fondatrice du module: un log ERC-20 est du texte controle par l attaquant, seul le
     * signataire de la transaction fait foi. Le durcissement ci-dessus ne doit pas l avoir dilue. */
    assert.strictEqual(forge.transfers[0].authentic, false);
    assert.strictEqual(forge.forgedTransfers, 1);
    assert.strictEqual(usdc.transfers[0].authentic, true);
    assert.strictEqual(usdc.forgedTransfers, 0);
  });

  t('une transaction introuvable reste un refus, pas un resultat vide', () => {
    assert.strictEqual(vide.ok, true);
  });
  const absente = await whatMoved('base', TX, async () => null);
  t('  ... et le refus porte sa raison', () => {
    assert.strictEqual(absente.ok, false);
    assert.match(absente.reason, /not found/);
  });

  /* ── readBridgeExit : calldata NON DECODE ≠ pont sans destination ─────────────────────────────────
   * `(tx.decoded_input && ….parameters) || []` faisait des deux cas le meme tableau vide, et la sortie
   * portait `ok:true, destinationChains: []` — « ce pont ne dit pas ou sont partis les fonds » au lieu de
   * « l'explorateur n'a pas decode le calldata ». Ca arrive des que le contrat n'est pas verifie.
   * Aucun repli sur un champ brut: `raw_input` n'apparait nulle part dans le depot, donc coder dessus
   * serait coder contre un souvenir — c'est ce qui fabrique une fausse piste. */
  const { readBridgeExit, followTron } = require('../lib/trace.js');
  const TXB = '0x' + 'cd'.repeat(32);
  const decode = await readBridgeExit('base', TXB, async () => ({ hash: TXB, decoded_input: { parameters: [] } }));
  const brut = await readBridgeExit('base', TXB, async () => ({ hash: TXB }));

  t('un calldata non decode ne se lit pas comme un pont sans destination', () => {
    assert.strictEqual(decode.calldataDecoded, true);
    assert.strictEqual(brut.calldataDecoded, false);
    /* Les deux ont zero chaine — c'est bien pour ca qu'il faut un AUTRE champ pour les distinguer. */
    assert.strictEqual(decode.destinationChains.length, 0);
    assert.strictEqual(brut.destinationChains.length, 0);
    assert.notStrictEqual(decode.note, brut.note);
    assert.match(brut.note, /NOTHING WAS EXAMINED/);
  });

  /* ── followTron : LE FAUX TERMINUS ────────────────────────────────────────────────────────────────
   * `(txs && txs.data) || []` faisait d'une lecture RATEE une liste vide: aucune sortie, donc
   * `current = null`, donc la boucle s'arretait — et l'adresse etait rapportee comme TERMINUS. Dans une
   * trace de vol le terminus EST la conclusion. Un hoquet reseau fabriquait un faux point d'arrivee. */
  const COMPTE = { data: [{ balance: 5000000, create_time: 1700000000000 }] };
  const ADR = 'T' + 'A'.repeat(33);
  const suivre = (implTx, implCompte) => followTron(ADR, { maxHops: 3,
    lireJson: async (u) => (u.includes('/transactions') ? implTx : (implCompte === undefined ? COMPTE : implCompte)) });

  const coupe = await suivre(null);
  const finReelle = await suivre({ data: [] });
  const compteMuet = await followTron(ADR, { maxHops: 1,
    lireJson: async (u) => (u.includes('/transactions') ? { data: [] } : null) });

  t('une lecture ratee ne fabrique PAS un terminus', () => {
    assert.strictEqual(coupe.stoppedBecause, 'unread');
    assert.strictEqual(coupe.complete, false);
    assert.strictEqual(coupe.hops[0].transactionsRead, false);
    assert.match(coupe.stopNote, /NOT\s+a destination/);
  });

  t('une vraie fin de piste reste une vraie fin de piste', () => {
    /* Les DEUX bornes: si le durcissement rendait tout « non lu », il n'informerait plus. */
    assert.strictEqual(finReelle.stoppedBecause, 'no_outbound');
    assert.strictEqual(finReelle.complete, true);
    assert.strictEqual(finReelle.hops[0].transactionsRead, true);
    assert.notStrictEqual(coupe.stoppedBecause, finReelle.stoppedBecause);
  });

  /* ⚠️ Ce cas a d'abord ete ecrit en RENDANT une promesse au harnais `t`, qui est SYNCHRONE et l'ignore:
   * les assertions du `.then()` n'auraient jamais ete verifiees et le cas serait passe au vert quoi qu'il
   * arrive. Le bug exact que ce depot traque, ecrit ici par moi. On calcule AVANT, on assertit apres. */
  const compteVide = await followTron(ADR, { maxHops: 1, lireJson: async (u) => (u.includes('/transactions')
    ? { data: [] } : { data: [{ balance: 0, create_time: 1700000000000 }] }) });

  t('un compte non lu rend un solde null, pas zero', () => {
    assert.strictEqual(compteMuet.hops[0].balanceTrx, null);
    assert.strictEqual(compteMuet.hops[0].accountRead, false);
    /* Un compte VRAIMENT vide doit rester distinguable d'un compte non lu: 0 et null, pas le meme mot. */
    assert.strictEqual(compteVide.hops[0].balanceTrx, 0);
    assert.strictEqual(compteVide.hops[0].accountRead, true);
    assert.notStrictEqual(compteMuet.hops[0].balanceTrx, compteVide.hops[0].balanceTrx);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* Sans ce filet, une promesse rejetee tuerait le processus AVANT le bilan — et l agregateur compte les
   * bilans. Un fichier sans bilan doit crier, pas disparaitre. */
  console.log('  FAIL harnais async: ' + (e && e.message));
  console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
