'use strict';
// BIII ledger — the till roll. Offline. Run: node test/ledger.test.js
const assert = require('node:assert');
const T = require('../lib/till');
const L = require('../lib/ledger');

const M = '0x' + 'ab'.repeat(20);
const mkReceipt = (tx, usd, overMicro = '0', bt = 1700000000, label = 'flat white') => ({
  v: 1, kind: 'basetill-receipt', merchant: { name: 'Café Demo', address: M.toLowerCase() },
  label, amountUsd: usd, amountMicro: T.usdToMicro(usd), paidMicro: T.usdToMicro(usd),
  overpaidMicro: overMicro, token: 'USDC', chainId: 8453, txHash: tx,
  payer: '0x' + 'ee'.repeat(20), tier: 'confirmed', blockTime: bt, explorer: 'https://basescan.org/tx/' + tx,
});

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII ledger — a human reads it, and anyone can audit it:');

t('renderReceipt: a paper-ticket a non-crypto human understands (amount, PAID, tip, verify link)', () => {
  const r = L.renderReceipt(mkReceipt('0x' + 'cd'.repeat(32), '4.50', '500000'), { number: 42, lang: 'en' });
  assert.match(r, /Café Demo/);
  assert.match(r, /B3-0042/);
  assert.match(r, /Amount:\s+4\.50 USDC/);
  assert.match(r, /Tip:\s+0\.50 USDC/);
  assert.match(r, /✓ PAID · USDC on Base/);
  assert.match(r, /basescan\.org\/tx\//);
  const fr = L.renderReceipt(mkReceipt('0x' + 'cd'.repeat(32), '4.50'), { lang: 'fr' });
  assert.match(fr, /PAYÉ/); assert.match(fr, /Merci/);
});

t('appendReceipt: append-only, sequential numbers, one txHash at most once (honest books)', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50')));
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '22'.repeat(32), '3.00')));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].no, 'B3-0001'); assert.equal(rows[1].no, 'B3-0002');
  const dup = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50'));   // same tx again
  assert.equal(dup.duplicate, true); assert.equal(dup.rows.length, 2);
  assert.throws(() => L.appendReceipt(rows, { kind: 'x' }), /verified receipt/);
});

t('summary: provable day books — exact micro totals + tips + every txHash re-checkable', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50', '500000', 1700000000)));
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '22'.repeat(32), '3.00', '0', 1700003600)));
  const s = L.summary(rows);
  assert.equal(s.count, 2);
  assert.equal(s.grossUsd, '7.50');
  assert.equal(s.tipsUsd, '0.50');
  assert.equal(s.txHashes.length, 2);
  // windowing by block time
  assert.equal(L.summary(rows, { fromBlockTime: 1700003000 }).count, 1);
});

t('reverify: a past receipt re-checks against the chain — an un-fakeable line', () => {
  const tx = '0x' + '11'.repeat(32);
  const { rows } = L.appendReceipt([], mkReceipt(tx, '4.50'));
  const goodFact = { txHash: tx, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), valueMicro: '4500000', confirmations: 20 };
  assert.equal(L.reverify(rows[0], goodFact).ok, true);
  // a fact for a DIFFERENT tx cannot ratify this receipt
  const wrongTx = { ...goodFact, txHash: '0x' + '99'.repeat(32) };
  assert.equal(L.reverify(rows[0], wrongTx).ok, false);
  // an underpaid fact fails
  assert.equal(L.reverify(rows[0], { ...goodFact, valueMicro: '1' }).ok, false);
});

t('renderRoll: a shareable statement — every line carries its txHash, footer says re-verify on Base', () => {
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '11'.repeat(32), '4.50', '0', 1700000000)));
  ({ rows } = L.appendReceipt(rows, mkReceipt('0x' + '22'.repeat(32), '3.00', '500000', 1700003600)));
  const roll = L.renderRoll(rows, { merchantName: 'Café Demo' });
  assert.match(roll, /PROVABLE TILL ROLL/);
  assert.match(roll, /Receipts: 2/);
  assert.match(roll, /Gross: 7\.50 USDC/);
  assert.match(roll, /Tips: 0\.50 USDC/);
  assert.match(roll, /B3-0001/); assert.match(roll, /B3-0002/);
  assert.match(roll, /0x11111111…111111/, 'a line carries its (shortened) txHash so the reader can re-check it');
  assert.match(roll, /trust no one/i);
  assert.match(roll, /Non-custodial/i);
  const fr = L.renderRoll(rows, { merchantName: 'Café Demo', lang: 'fr' });
  assert.match(fr, /PROUVABLE/); assert.match(fr, /confiance à personne/);
});

t('reverifyRoll: allVerified ONLY when every line re-checks on Base — fail-closed on a missing/tampered fact', () => {
  const tx1 = '0x' + '11'.repeat(32), tx2 = '0x' + '22'.repeat(32);
  let rows = [];
  ({ rows } = L.appendReceipt(rows, mkReceipt(tx1, '4.50')));
  ({ rows } = L.appendReceipt(rows, mkReceipt(tx2, '3.00')));
  const f = (tx, micro) => ({ txHash: tx, chainId: 8453, token: T.USDC_BASE, to: M.toLowerCase(), valueMicro: micro, confirmations: 20 });
  const facts = new Map([[tx1, f(tx1, '4500000')], [tx2, f(tx2, '3000000')]]);
  const all = L.reverifyRoll(rows, facts);
  assert.equal(all.total, 2); assert.equal(all.verified, 2); assert.equal(all.allVerified, true);
  // a MISSING fact fails that line, never passes it (fail-closed)
  const partial = L.reverifyRoll(rows, new Map([[tx1, f(tx1, '4500000')]]));
  assert.equal(partial.verified, 1); assert.equal(partial.allVerified, false);
  assert.equal(partial.results.find((r) => r.txHash === tx2).ok, false);
  // a TAMPERED amount fails that line
  const tampered = new Map([[tx1, f(tx1, '4500000')], [tx2, f(tx2, '1')]]);
  assert.equal(L.reverifyRoll(rows, tampered).allVerified, false);
  // facts may also be a function
  assert.equal(L.reverifyRoll(rows, (h) => facts.get(String(h).toLowerCase())).allVerified, true);
  // empty roll is not "allVerified" (nothing proven is not everything proven)
  assert.equal(L.reverifyRoll([], facts).allVerified, false);
});

/* ── UN NUMERO DE RECU N'A QU'UN SEUL TRAVAIL: ETRE UNIQUE ──────────────────────────────────────────
 * `receiptNo(r.length + 1)` le derivait de la LONGUEUR du registre. Mesure du 2026-07-28: trois recus
 * (B3-0001..0003), on retire le deuxieme du tableau — correction, purge, migration, rien d'exotique pour
 * un registre stocke en JSON — puis on ajoute. La longueur etant retombee a 2, le nouveau recu sortait en
 * **B3-0003**: deux recus differents, le meme numero, dans les livres d'un commerçant.
 *
 * Une quantite derivee ne peut pas garantir l'unicite parce qu'elle DESCEND. Un compteur monotone le
 * peut. C'est la meme lecon que l'horloge qui ne sait pas ordonner deux evenements du meme tick. */
const recu = (h) => ({ txHash: '0x' + String(h).repeat(64).slice(0, 64), blockTime: 1,
  valueMicro: '1000000', to: '0x' + 'a'.repeat(40) });
const numeros = (rows) => rows.map((e) => e.no);
const aDesDoublons = (l) => new Set(l).size !== l.length;

t('un numero de recu n est JAMAIS reutilise apres un retrait', () => {
  let r = [];
  for (const h of ['1', '2', '3']) r = L.appendReceipt(r, recu(h)).rows;
  assert.deepStrictEqual(numeros(r), ['B3-0001', 'B3-0002', 'B3-0003']);
  r.splice(1, 1);                                   // le #2 disparait du tableau
  r = L.appendReceipt(r, recu('4')).rows;
  /* ⚠️ Avant: ['B3-0001','B3-0003','B3-0003']. */
  assert.strictEqual(aDesDoublons(numeros(r)), false, 'un numero deja emis ne doit jamais revenir');
  assert.strictEqual(numeros(r)[2], 'B3-0004');
});

t('le compteur ne redescend pas, meme apres plusieurs retraits', () => {
  let r = [];
  for (const h of ['1', '2', '3', '4', '5']) r = L.appendReceipt(r, recu(h)).rows;
  r.splice(0, 4);                                   // il ne reste que le #5
  r = L.appendReceipt(r, recu('6')).rows;
  assert.strictEqual(numeros(r)[1], 'B3-0006', 'le suivant vient du plus grand n, pas du nombre de lignes');
});

t('un registre ancien SANS `n` ne retombe pas sur un numero qui pourrait exister', () => {
  /* La ceinture: sans `n` nulle part, le maximum vaut 0 et on retomberait sur 1 — qui existe peut-etre
   * deja sous une autre forme dans un registre importe. */
  const vieux = [{ receipt: recu('7') }, { receipt: recu('8') }];
  assert.strictEqual(L.appendReceipt(vieux, recu('9')).entry.no, 'B3-0003');
});

t('le durcissement n a rien avale: le doublon de txHash est toujours refuse', () => {
  /* Les deux bornes. Un compteur monotone ne doit pas devenir une excuse pour accepter deux fois la meme
   * transaction — c'est la protection d'origine et elle reste entiere. */
  let r = L.appendReceipt([], recu('1')).rows;
  const encore = L.appendReceipt(r, recu('1'));
  assert.strictEqual(encore.duplicate, true);
  assert.strictEqual(encore.entry, null);
  assert.strictEqual(encore.rows.length, 1);
});

t('la numerotation reste STRICTEMENT croissante sur une suite normale', () => {
  let r = [];
  for (let i = 1; i <= 12; i++) r = L.appendReceipt(r, recu(String(i % 10) + String(i))).rows;
  const ns = r.map((e) => e.n);
  for (let i = 1; i < ns.length; i++) assert.ok(ns[i] > ns[i - 1], 'n doit croitre strictement');
  assert.strictEqual(aDesDoublons(numeros(r)), false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
