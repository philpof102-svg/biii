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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
