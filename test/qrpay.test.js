'use strict';
// BIII qrpay — the P2P core: parse a scanned QR into a validated USDC-on-Base target, build a receive QR.
// Fail-closed: wrong chain / non-USDC / native-ETH / malformed are refused. Pure. Run: node test/qrpay.test.js
const assert = require('node:assert');
const { parsePaymentQR, receiveURI, USDC_BASE, CHAIN } = require('../lib/qrpay');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const ALICE = '0x' + 'a1'.repeat(20), BOB = '0x' + 'b0'.repeat(20);

console.log('BIII qrpay — scan → validated USDC-on-Base target (P2P), fail-closed:');

t('a bare 0x address → valid recipient, no amount (payer enters it)', () => {
  const r = parsePaymentQR(ALICE);
  assert.equal(r.valid, true); assert.equal(r.to, ALICE); assert.equal(r.amountMicro, null);
  assert.equal(r.token, USDC_BASE); assert.equal(r.chainId, CHAIN); assert.equal(r.form, 'address');
});

t('a BIII EIP-681 USDC transfer → recipient + amount parsed', () => {
  const uri = receiveURI({ address: BOB, amountUsd: '12.50' });
  const r = parsePaymentQR(uri);
  assert.equal(r.valid, true); assert.equal(r.to, BOB);
  assert.equal(r.amountMicro, '12500000'); assert.equal(r.amountUsd, '12.50');
  assert.equal(r.form, 'eip681-transfer');
});

t('a bare ethereum:0xADDR@8453 (no amount) → valid recipient, amount entered in-app', () => {
  const r = parsePaymentQR(receiveURI({ address: ALICE }));
  assert.equal(r.valid, true); assert.equal(r.to, ALICE); assert.equal(r.amountMicro, null);
});

t('FAIL-CLOSED: a non-Base chain is refused (never send on the wrong chain)', () => {
  const r = parsePaymentQR('ethereum:' + USDC_BASE + '@1/transfer?address=' + BOB + '&uint256=1000000');
  assert.equal(r.valid, false); assert.match(r.reason, /base|8453/i);
});

t('FAIL-CLOSED: a non-USDC token transfer is refused', () => {
  const r = parsePaymentQR('ethereum:0x' + 'de'.repeat(20) + '@8453/transfer?address=' + BOB + '&uint256=1000000');
  assert.equal(r.valid, false); assert.match(r.reason, /usdc/i);
});

t('FAIL-CLOSED: a native-ETH value QR is NOT auto-sent as ETH — the address is taken, amount entered as USDC', () => {
  const r = parsePaymentQR('ethereum:' + BOB + '@8453?value=1000000000000000000');
  assert.equal(r.valid, true); assert.equal(r.to, BOB); assert.equal(r.amountMicro, null, 'the ETH value is ignored');
  assert.equal(r.token, USDC_BASE);
});

t('FAIL-CLOSED: garbage / bad address / empty is refused', () => {
  assert.equal(parsePaymentQR('hello').valid, false);
  assert.equal(parsePaymentQR('ethereum:0x123@8453/transfer?address=0xnope&uint256=1').valid, false);
  assert.equal(parsePaymentQR('').valid, false);
  assert.equal(parsePaymentQR(null).valid, false);
});

t('receiveURI: with an amount → a scannable transfer intent; without → a bare address URI', () => {
  assert.match(receiveURI({ address: ALICE, amountUsd: '5' }), new RegExp('^ethereum:' + USDC_BASE + '@8453/transfer\\?address=' + ALICE + '&uint256=5000000$'));
  assert.equal(receiveURI({ address: ALICE }), 'ethereum:' + ALICE + '@8453');
  assert.throws(() => receiveURI({ address: 'nope' }));
});

// the round-trip both users rely on: Alice shows a receive QR → Bob scans it → gets Alice as the target.
t('ROUND-TRIP: Alice\'s receive QR, scanned by Bob, resolves to Alice + the amount', () => {
  const r = parsePaymentQR(receiveURI({ address: ALICE, amountUsd: '4.20' }));
  assert.equal(r.to, ALICE); assert.equal(r.amountUsd, '4.20');
});

/* ── ★ LE CONTRAT DONT LA PAGE DE PAIEMENT DEPEND, ET QUE RIEN N ENONCAIT ────────────────────────
 * `web/p2p.html` construit l intent que le WALLET va signer en interpolant SANS ENCODER:
 *     var uri = "ethereum:<USDC>@8453/transfer?address=" + p.to + "&uint256=" + amtMicro;
 * C est sain aujourd hui, et uniquement grace a deux gardes qui vivent ICI: `to` passe par un
 * /^0x[0-9a-fA-F]{40}$/ ancre, et `amountMicro` par /^\d+$/ avec BigInt > 0 (sinon null).
 * Mesure du 2026-08-15: cablage verifie, lib/server.js sert bien parsePaymentQR sur le texte brut.
 *
 * ⚠️ AUCUN TEST NE LIAIT LES DEUX MODULES. Assouplir `isAddr` — accepter un nom ENS, un alias — est
 * une demande de fonctionnalite banale, et elle rendrait la page injectable EN SILENCE: un `to`
 * portant un `&` ajoute des parametres a l intent, donc le destinataire ou le montant que le wallet
 * propose de SIGNER cessent d etre ceux que l ecran affiche (l ecran, lui, passe par esc()).
 * Un chemin de paiement ne doit pas tenir par accident.
 *
 * ⚖️ LA PROPRIETE N EXIGE PAS LE REFUS: elle exige que **ce qui est ACCEPTE soit interpolable**.
 * Une evolution peut elargir ce qui passe, tant que ce qui passe ne peut pas pirater l URI. */
const META_URI = ['&', '?', '#', '=', '/', '%', ' ', '\n', '"', "'", '\\'];
const porteUnMeta = (v) => META_URI.some((c) => String(v).indexOf(c) >= 0);

const QR_HOSTILES = [
  ALICE + '&uint256=999999999',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + '%26uint256%3D9&uint256=1',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + '&uint256=1&address=' + BOB,
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + '&uint256=1e6',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + '&uint256=-1',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + '&uint256=0x10',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=' + ALICE + ' &uint256=1',
  'ethereum:' + USDC_BASE + '@8453/transfer?address=alice.eth&uint256=1',
];

t('★ CONTRE-BORNE — la batterie porte bien des valeurs qui INJECTERAIENT si rien ne gardait', () => {
  /* Sans ce controle, une batterie de chaines anodines rendrait les cas suivants verts en n ayant
   * rien attaque. On mesure sur la CHAINE SOURCE, avant tout parsing. */
  const injectantes = QR_HOSTILES.filter((s) => porteUnMeta(s.slice(s.indexOf('address=') + 8)));
  assert.ok(injectantes.length >= 5,
    'seulement ' + injectantes.length + ' entree(s) portent un metacaractere apres `address=` — la '
    + 'batterie n attaque pas assez pour que son resultat veuille dire quelque chose');
});

/* ⚠️ JETER N EST PAS VIOLER LA PROPRIETE, ET LES CONFONDRE AFFAIBLIT LE TEST.
 * Mesure du 2026-08-15: en relachant la garde de montant, `parsePaymentQR` JETTE sur `uint256=1e6`
 * (BigInt refuse la notation exponentielle). Ma premiere version laissait l exception remonter: les
 * deux cas rougissaient, la boucle s arretait au 4e QR, et `0x10` — la VRAIE violation, un montant
 * accepte qui n est pas fait de chiffres — n etait jamais atteint. Le test rougissait donc pour la
 * mauvaise raison, et manquait la bonne.
 * Une exception vaut REFUS (la route rend 500, la page dit « Validation indisponible » = fail-closed),
 * donc on la compte comme telle et on CONTINUE la batterie. */
const analyse = (s) => { try { return parsePaymentQR(s); } catch (e) { return { valid: false, jete: e.message }; } };

t('★ tout QR ACCEPTE rend un `to` interpolable tel quel dans l intent EIP-681', () => {
  for (const s of QR_HOSTILES) {
    const r = analyse(s);
    if (!r.valid) continue;                       // refuser est une facon valide de tenir le contrat
    assert.ok(!porteUnMeta(r.to),
      'QR accepte dont le `to` porte un metacaractere d URI: ' + JSON.stringify(r.to) + '\n      '
      + 'la page l interpole SANS encoder — le wallet signerait autre chose que ce que l ecran montre.'
      + '\n      QR: ' + JSON.stringify(s.slice(0, 90)));
  }
});

t('★ tout QR ACCEPTE rend un `amountMicro` fait de CHIFFRES, ou null', () => {
  for (const s of QR_HOSTILES) {
    const r = analyse(s);
    if (!r.valid || r.amountMicro == null) continue;
    assert.match(String(r.amountMicro), /^[0-9]+$/,
      'montant accepte non numerique: ' + JSON.stringify(r.amountMicro) + ' — il part dans l intent '
      + 'que le wallet propose de signer.\n      QR: ' + JSON.stringify(s.slice(0, 90)));
  }
});

t('⚖️ TEMOIN — un QR legitime reste ACCEPTE (le contrat n est pas « tout refuser »)', () => {
  /* ⛔ Sans lui, un parseur qui refuserait absolument tout satisferait les cas ci-dessus en beaute,
   * et la page ne pourrait plus jamais payer personne. */
  const r = parsePaymentQR(receiveURI({ address: BOB, amountUsd: '7.25' }));
  assert.equal(r.valid, true, 'un QR que NOUS produisons doit rester lisible');
  assert.equal(r.to, BOB);
  assert.equal(r.amountMicro, '7250000');
  assert.ok(!porteUnMeta(r.to) && /^[0-9]+$/.test(r.amountMicro), 'et rester interpolable');
});

/* ── ★ UN MONTANT DEMANDE ET ILLISIBLE NE DOIT PAS DEVENIR « PAS DE MONTANT » ────────────────────
 * `receiveURI` gardait le montant par `Number(amountUsd) > 0`, ce qui faisait deux fautes OPPOSEES:
 *   · il REJETAIT ce que notre propre parseur accepte — `usdToMicro` fait
 *     String(usd).trim().replace(',', '.'), donc la virgule decimale francaise est geree depuis
 *     toujours, mais Number('5,50') vaut NaN et la valeur n atteignait jamais ce parseur;
 *   · il DEGRADAIT EN SILENCE — un montant illisible ne levait rien, on retombait sur l URI SANS
 *     montant. Le commercant montre un QR qu il croit porteur de 5,50 $, le payeur scanne et doit
 *     taper la somme lui-meme. Aucune erreur, aucune trace.
 * MESURE DU 2026-08-15 avant correctif: '5,50' et '1_000' rendaient `ethereum:0x…@8453`.
 * ⚖️ Le produit parle FRANCAIS (web/p2p.html: « Montant a envoyer en USDC »), et son chemin PAYEUR
 * fait deja v.replace(',', '.'). Le meme probleme, corrige d un seul cote. */
const SANS_MONTANT = new RegExp('^ethereum:0x[0-9a-f]{40}@' + CHAIN + '$');

t('★ la virgule decimale francaise est un MONTANT, pas une absence de montant', () => {
  const uri = receiveURI({ address: ALICE, amountUsd: '5,50' });
  assert.ok(!SANS_MONTANT.test(uri), 'le montant a disparu du QR: ' + uri);
  assert.match(uri, /&uint256=5500000$/, '5,50 doit valoir 5 500 000 micro-USDC: ' + uri);
});

t('★ un montant DEMANDE mais illisible LEVE, au lieu de rendre un QR ampute', () => {
  for (const mauvais of ['1_000', 'Infinity', '1e6', '0x10', 'cinq', '5$', '-1', '0']) {
    let uri = null;
    try { uri = receiveURI({ address: ALICE, amountUsd: mauvais }); } catch (e) { continue; }
    assert.fail('amountUsd=' + JSON.stringify(mauvais) + ' n a pas leve et a rendu ' + uri
      + (SANS_MONTANT.test(uri) ? '\n      — le montant a ete SILENCIEUSEMENT abandonne: le porteur du '
        + 'QR croit demander une somme, le payeur ne la voit jamais.' : ''));
  }
});

t('⚖️ TEMOIN — ne RIEN demander rend toujours l URI sans montant (c est un cas legitime)', () => {
  /* ⛔ Sans lui, une garde qui leverait sur TOUT satisferait le cas precedent et casserait le QR
   * « adresse seule », qui est une fonctionnalite: le payeur saisit la somme. */
  assert.match(receiveURI({ address: ALICE }), SANS_MONTANT);
  assert.match(receiveURI({ address: ALICE, amountUsd: null }), SANS_MONTANT);
  assert.match(receiveURI({ address: ALICE, amountUsd: '' }), SANS_MONTANT);
  assert.match(receiveURI({ address: ALICE, amountUsd: '   ' }), SANS_MONTANT, 'des espaces = rien demande');
});

t('⚖️ TEMOIN — un montant ordinaire traverse toujours, virgule ou point', () => {
  assert.match(receiveURI({ address: BOB, amountUsd: '12.50' }), /&uint256=12500000$/);
  assert.match(receiveURI({ address: BOB, amountUsd: '12,50' }), /&uint256=12500000$/, 'les deux ecritures sont le MEME montant');
  assert.match(receiveURI({ address: BOB, amountUsd: '  7  ' }), /&uint256=7000000$/, 'les espaces sont retires, pas la valeur');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
