'use strict';
// BIII invoice — the SAME registry for Web2-style bills. Run: node test/invoice.test.js
const assert = require('node:assert');
const T = require('../lib/till');
const I = require('../lib/invoice');
const L = require('../lib/ledger');
const { assessTriangle } = require('../lib/trust');

let pass = 0, fail = 0;
/* ⚠️ CE HARNAIS ETAIT SYNCHRONE, ET IL RENDAIT TOUT TEST `async` INCAPABLE D'ECHOUER.
 *
 *     const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; } };
 *
 * Un corps `async` ne jette JAMAIS de facon synchrone: il rend une promesse rejetee. Le `catch` ne voit
 * donc rien et `pass++` s'execute toujours. Trois cas ajoutes le 2026-07-27 pour couvrir la chaine MCP
 * des factures passaient ainsi inconditionnellement — decouvert parce que 4 mutations sur 4 sont restees
 * VERTES. Sans le mutation-test, trois tests verts auraient garanti un chemin non couvert.
 *
 * Les cas sont desormais EMPILES et deroules en sequence, chacun attendu. Un test qui ne peut pas
 * echouer est pire qu'absent: il occupe la place et il rassure. */
const files = [];
const t = (n, fn) => files.push([n, fn]);

const MERCHANT = '0x' + 'ab'.repeat(20);
const NOW = 1753100000000; // injected clock — the core never reads Date.now()
const inv = () => I.createInvoice({
  to: MERCHANT, number: 'INV-2026-041', merchantName: 'Atelier Dupont',
  billTo: 'Acme SARL', issueDateMs: NOW, dueDateMs: NOW + 14 * 86400000,
  lineItems: [
    { description: 'Site vitrine', amountUsd: '1200' },
    { description: 'Maintenance', qty: 3, unitUsd: '90.50' },
  ],
  nowMs: NOW,
});

console.log('BIII invoice — a Web2 bill on the same non-custodial registry:');

t('line items sum EXACTLY in micro (qty × unit, no float drift) and drive the charge', () => {
  const v = inv();
  assert.equal(v.totalMicro, (1200_000000n + 3n * 90_500000n).toString()); // 1471.50
  assert.equal(v.totalUsd, '1471.50');
  assert.equal(v.charge.amountMicro, v.totalMicro);           // the charge IS the invoice total
  assert.equal(v.charge.to, MERCHANT.toLowerCase());          // non-custodial: merchant's own address
  assert.equal(v.status, 'issued');
});

t('bad line items fail closed (negative, zero qty, garbage amounts)', () => {
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', amountUsd: '-5' }], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', qty: 0, unitUsd: '5' }], nowMs: NOW }));
  assert.throws(() => I.createInvoice({ to: MERCHANT, lineItems: [{ description: 'x', qty: 1.5, unitUsd: '5' }], nowMs: NOW }));
});

t('invoiceURI IS the same EIP-681 rail as any BIII charge', () => {
  const v = inv();
  assert.equal(I.invoiceURI(v), T.paymentURI(v.charge));
  assert.ok(I.invoiceURI(v).startsWith('ethereum:' + T.USDC_BASE + '@8453/transfer?address='));
});

t('verifyInvoice = the same field-for-field chain discipline (underpay ⇒ NOT paid)', () => {
  const v = inv();
  const under = I.verifyInvoice(v, { txHash: '0x1', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: '1471000000', confirmations: 3 });
  assert.equal(under.paid, false);
  assert.match(under.reason, /underpaid/);
  const ok = I.verifyInvoice(v, { txHash: '0x2', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 3, blockTime: 1753100400 });
  assert.equal(ok.paid, true);
});

t('status lifecycle: issued → overdue (past due, unpaid) → settled (chain confirms)', () => {
  const v = inv();
  assert.equal(I.invoiceStatus(v, null, NOW + 1000).status, 'issued');
  assert.equal(I.invoiceStatus(v, null, NOW + 15 * 86400000).status, 'overdue');
  const paid = I.verifyInvoice(v, { txHash: '0x2', chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 12 });
  const st = I.invoiceStatus(v, paid, NOW + 20 * 86400000);   // paid late is still SETTLED
  assert.equal(st.status, 'settled');
  assert.equal(st.tier, 'final');
});

t('ONE till roll: an invoice receipt and a café receipt land in the SAME provable ledger', () => {
  const v = inv();
  const paid = I.verifyInvoice(v, { txHash: '0x' + 'aa'.repeat(32), chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: v.totalMicro, confirmations: 3, blockTime: 1753100400, from: '0x' + 'cc'.repeat(20) });
  const invoiceRec = I.invoiceReceipt(v, paid);
  assert.equal(invoiceRec.kind, 'basetill-receipt');          // it IS a normal registry receipt
  assert.equal(invoiceRec.invoiceNumber, 'INV-2026-041');     // …with the bill on top

  // café sale in the same roll
  const charge = T.createCharge({ to: MERCHANT, amountUsd: '4.50', label: 'Flat white', nowMs: NOW });
  const cafePaid = T.verifyPayment(charge, { txHash: '0x' + 'bb'.repeat(32), chainId: 8453, token: T.USDC_BASE, to: MERCHANT, valueMicro: '5000000', confirmations: 1, blockTime: 1753100500 });
  const cafeRec = T.receipt(charge, cafePaid, { merchantName: 'Atelier Dupont' });

  let rows = [];
  ({ rows } = L.appendReceipt(rows, invoiceRec));
  ({ rows } = L.appendReceipt(rows, cafeRec));
  assert.equal(rows.length, 2);
  const s = L.summary(rows);
  assert.equal(s.count, 2);
  assert.equal(s.grossMicro, (BigInt(v.totalMicro) + 5000000n).toString());  // both flows, one book
  assert.equal(s.tipsUsd, '0.50');                                           // café overpay = tip
  // and the SAME trust triangle judges the invoice's settlement
  const tri = assessTriangle({ settlement: paid });
  assert.equal(tri.trust, 'settled');
  assert.equal(tri.vertices.settlement.txHash, paid.txHash);
});

t('renderInvoice: a non-crypto human reads the bill (FR too), pay line is the EIP-681', () => {
  const v = inv();
  const en = I.renderInvoice(v);
  assert.match(en, /INVOICE {2}INV-2026-041/);
  assert.match(en, /Maintenance ×3/);
  assert.match(en, /TOTAL:.*1471\.50 USDC/);
  assert.ok(en.includes(I.invoiceURI(v)));
  const fr = I.renderInvoice(v, { lang: 'fr' });
  assert.match(fr, /FACTURE/); assert.match(fr, /Échéance/);
});

/* ── « OVERDUE — PAST DUE, UNPAID » SUR UNE FACTURE PAYEE PAR CARTE ─────────────────────────────────
 * Mesure du 2026-07-27, sur ce module: une facture Web2 echue depuis deux jours et reglee PAR CARTE
 * ressortait en `overdue / past due, unpaid`. Le client avait paye. BIII avait regarde Base, n'y avait
 * rien vu, et en avait conclu un impaye.
 *
 * C'est la sortie la plus lourde de cette famille dans tout le produit: ce n'est pas un score, c'est une
 * phrase sur une PERSONNE, dans un outil pense pour « en personne + factures Web2 + agents ». Une facture
 * reglee en especes, par virement ou par carte n'apparaitra jamais sur Base — l'absence de trace n'y est
 * pas une information sur le client. */
/* ⚠️ CES CAS PASSENT PAR createInvoice, PAS PAR UN OBJET LITTERAL.
 * Premiere version: `I.invoiceStatus({ dueDateMs, rail }, ...)`. Ils passaient tous — pendant que
 * `createInvoice` ne posait AUCUN champ `rail`. Le champ n'existait sur aucune facture que ce module
 * sache produire, et les tests ne pouvaient pas s'en apercevoir puisqu'ils fabriquaient l'entree
 * eux-memes.
 *
 * 💎 Un test qui CONSTRUIT son entree a la main ne prouve pas que cette entree existe. C'est la
 * troisieme fois dans la journee que j'ecris le lecteur avant l'ecrivain (FRESH_FUNDING_WINDOW_MS dans
 * feeder, l'etat not_observable dans trust.js, ce champ-ci) — et les trois fois, des tests verts. Passer
 * par le producteur est ce qui transforme « la fonction gere ce cas » en « ce cas peut arriver ». */
const facture = (rail, dueDateMs) => I.createInvoice({
  to: '0x' + 'a'.repeat(40),
  lineItems: [{ label: 'prestation', qty: 1, unitUsd: '250.00' }],
  dueDateMs, rail, nowMs: Date.now(),
});

t('★ une facture sur un rail non lisible n est PAS declaree impayee', () => {
  const hier = Date.now() - 48 * 3600 * 1000;
  for (const rail of ['carte', 'sepa', 'especes', 'mastercard-agent-pay']) {
    const inv = facture(rail, hier);
    assert.strictEqual(inv.rail, rail, 'createInvoice doit POSER le rail — sinon rien ne le lit jamais');
    const r = I.invoiceStatus(inv, null, Date.now());
    assert.strictEqual(r.status, 'not_observable', 'rail ' + rail);
    assert.strictEqual(r.rail, rail, 'le rail doit revenir au lecteur');
    assert.match(r.reason, /merchant's own records/i, 'dire OU se trouve la reponse');
    assert.match(r.reason, /NOT "unpaid"/, 'la difference doit etre dite, pas devinee');
    assert.ok(!/past due/.test(r.reason), 'aucune formulation d impaye ne doit subsister');
  }
});

t('un rail INCONNU vaut non lisible, jamais on-chain (fail-closed sur le nom)', () => {
  /* 'bse' pour 'base': se tromper dans ce sens dit « je ne peux pas voir ». Dans l autre, ca produit
   * l accusation qu on vient de retirer. */
  const r = I.invoiceStatus(facture('bse', Date.now() - 1000), null, Date.now());
  assert.strictEqual(r.status, 'not_observable');
});

t('le rail est normalise A LA CREATION, une seule fois', () => {
  assert.strictEqual(facture(' CARTE ', null).rail, 'carte');
  assert.strictEqual(facture('BASE', null).rail, 'base');
  assert.strictEqual(facture(undefined, null).rail, null, 'aucun rail declare reste null');
  assert.strictEqual(facture('   ', null).rail, null, 'des espaces ne sont pas un rail');
});

t('sans rail, ou sur Base, le cycle de vie ne bouge pas', () => {
  /* La borne inverse: si tout devenait non lisible, le module perdrait la seule chose qu il sait prouver,
   * et une vraie facture USDC impayee cesserait d etre signalee. */
  const hier = Date.now() - 48 * 3600 * 1000;
  for (const rail of [undefined, 'base', 'BASE']) {
    assert.strictEqual(I.invoiceStatus(facture(rail, hier), null, Date.now()).status, 'overdue',
      JSON.stringify(rail));
  }
  assert.strictEqual(I.invoiceStatus(facture(undefined, Date.now() + 9e6), null, Date.now()).status, 'issued');
});

t('une PREUVE on-chain l emporte sur le rail declare', () => {
  /* La preuve bat la declaration: si quelqu un annonce « carte » mais paie en USDC et qu on peut le
   * verifier, le fait gagne. Sinon une etiquette suffirait a masquer un reglement reel. */
  const r = I.invoiceStatus(facture('carte', Date.now() - 1000),
    { paid: true, tier: 'confirmed', txHash: '0x' + 'a'.repeat(64) }, Date.now());
  assert.strictEqual(r.status, 'settled');
  assert.strictEqual(r.txHash, '0x' + 'a'.repeat(64));
});

/* ── LA CHAINE MCP, PAS SEULEMENT LE MODULE ─────────────────────────────────────────────────────────
 * `rail` marchait dans lib/invoice.js et etait INATTEIGNABLE par la surface MCP, aux DEUX bouts:
 * till_create_invoice ne le passait pas a createInvoice, et till_check_invoice RECONSTRUIT la facture
 * de zero a partir de ses arguments — il ne recoit jamais l'objet emis. Tout champ non repris dans cette
 * reconstruction est invisible pour le verdict, quoi qu'ait pose le createur.
 *
 * Ces cas passent donc par callTool, pas par le module: c'est le seul niveau ou la rupture se voyait. */
const { callTool } = require('../bin/biii-mcp');

t('★ till_create_invoice transmet le rail jusqu a la facture', async () => {
  const r = await callTool('till_create_invoice', {
    to: '0x' + 'a'.repeat(40), lineItems: [{ description: 'prestation', amountUsd: '250.00' }], rail: 'carte' });
  assert.strictEqual(r.invoice.rail, 'carte');
});

t('★ till_check_invoice rend not_observable — et SANS toucher la chaine', async () => {
  /* Le handler interrogeait Base AVANT de lire le rail: une facture reglee en especes brulait un appel
   * RPC incapable de rien apprendre, et une panne de ce RPC faisait echouer tout l outil alors que la
   * reponse etait connue d avance. Constate a l ecriture: `rpc eth_getLogs HTTP 413`.
   * Un commercant hors ligne avec une facture reglee en especes ne doit dependre d aucun noeud. */
  const r = await callTool('till_check_invoice', {
    to: '0x' + 'a'.repeat(40), totalMicro: '250000000', rail: 'especes', dueDateMs: Date.now() - 86400000 });
  assert.strictEqual(r.status.status, 'not_observable');
  assert.strictEqual(r.fact, null, 'aucun fait on-chain ne doit avoir ete cherche');
  assert.strictEqual(r.verdict, null, 'ni verdict de chaine');
  assert.match(r.note, /No chain read was attempted/i, 'le lecteur doit savoir qu on n a rien interroge');
});

t('un rail temoignable, lui, passe bien par la chaine', async () => {
  /* La borne inverse: si le raccourci s appliquait a tout, une vraie facture USDC ne serait plus jamais
   * verifiee. On ne peut pas tester le succes on-chain sans reseau, mais on peut prouver que le chemin
   * n est PAS court-circuite — il tente la lecture, donc il echoue ou rend un fait. */
  let atteintLaChaine = false;
  try {
    const r = await callTool('till_check_invoice', {
      to: '0x' + 'a'.repeat(40), totalMicro: '250000000', rail: 'base', lookbackBlocks: 10 });
    atteintLaChaine = r.note === undefined || !/No chain read/i.test(r.note || '');
  } catch { atteintLaChaine = true; }        // une erreur RPC prouve aussi qu on a tente
  assert.ok(atteintLaChaine, 'rail base = la chaine doit rester le juge');
});

/* ── DEUX CHAMPS QUI SE CONTREDISENT NE SE TRANCHENT PAS EN SILENCE ─────────────────────────────────
 * Mesure du 2026-07-28: `{qty:2, unitUsd:'5.00', amountUsd:'100.00'}` rendait **10,00 $** et jetait le
 * 100,00 sans un mot. Les deux valeurs different d'un facteur dix, et le client etait facture sur celle
 * que le code avait choisie tout seul.
 *
 * L'appelant qui envoie les deux a calcule un total quelque part; s'il ne correspond pas au produit,
 * l'un des deux est un bug CHEZ LUI. En choisir un revient a decider a sa place quel montant reclamer a
 * un tiers — la seule chose qu'une couche de facturation ne doit jamais faire seule. C'est la meme regle
 * que le conflit d'etiquettes de l'explorateur, qui ne se resout jamais en silence non plus.
 *
 * ⚠️ Huit des neuf formes essayees etaient DEJA correctes et fail-closed (qty nul, negatif, non entier,
 * montant absent, prix unitaire manquant). Une seule etait un defaut — et l'hypothese « qty sans prix
 * unitaire produit une ligne gratuite » a ete REFUTEE par la mesure: ca refuse. */
t('une ligne dont amountUsd contredit qty x unitUsd est REFUSEE', () => {
  assert.throws(() => I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00', amountUsd: '100.00' }),
    /contradicts/, 'la contradiction doit etre refusee, pas arbitree');
  /* Le message doit porter LES DEUX nombres: un refus qui ne dit pas quoi corriger se contourne au
   * hasard. */
  try { I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00', amountUsd: '100.00' }); }
  catch (e) {
    assert.match(e.message, /100\.00/);
    assert.match(e.message, /10\.00/);
  }
});

t('une redondance COHERENTE reste acceptee', () => {
  /* Les DEUX bornes. Refuser un appelant qui se relit casserait du code correct, et un fail-closed qui
   * refuse le juste cesse d'informer. On ne refuse QUE la contradiction. */
  const r = I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00', amountUsd: '10.00' });
  assert.strictEqual(r.amountUsd, '10.00');
  assert.strictEqual(r.qty, 2);
});

t('les chemins existants ne bougent pas', () => {
  assert.strictEqual(I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00' }).amountUsd, '10.00');
  assert.strictEqual(I.normalizeItem({ description: 'x', amountUsd: '10.00' }).amountUsd, '10.00');
  /* Une chaine vide n'est pas une contradiction: c'est l'absence du champ. */
  assert.strictEqual(I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00', amountUsd: '' }).amountUsd, '10.00');
});

t('les refus deja en place tiennent toujours', () => {
  /* Ce que la mesure a trouve CORRECT et qu'il ne faut pas casser en durcissant ailleurs. */
  for (const mauvais of [{ qty: 0, unitUsd: '5' }, { qty: -3, unitUsd: '5' }, { qty: 1.5, unitUsd: '5' }]) {
    assert.throws(() => I.normalizeItem({ description: 'x', ...mauvais }), /positive integer/);
  }
  assert.throws(() => I.normalizeItem({ description: 'x', qty: 5 }), /invalid USD amount/,
    'qty sans prix unitaire refuse — jamais une ligne gratuite');
  assert.throws(() => I.normalizeItem({ description: 'x' }), /invalid USD amount/);
  assert.throws(() => I.normalizeItem({ description: 'x', qty: 2, unitUsd: '5.00', amountUsd: 'abc' }),
    /invalid USD amount/, 'un montant illisible reste refuse avant toute comparaison');
});

(async () => {
  for (const [n, fn] of files) {
    try { await fn(); pass++; console.log('  ✓ ' + n); }
    catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed · ${fail} failed`);
  /* Un ecart entre cas empiles et cas deroules voudrait dire qu on est sorti de la boucle en route: le
   * bilan serait vrai sur ce qu il a vu et faux sur ce qu il pretend couvrir. */
  if (pass + fail !== files.length) {
    console.log('✗ ' + files.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
