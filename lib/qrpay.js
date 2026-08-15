'use strict';
/**
 * BIII qrpay — the peer-to-peer core: turn a SCANNED QR into a validated USDC-on-Base payment target, and
 * build the QR a user SHOWS to receive. This is what lets two people with the app pay each other directly,
 * wallet-to-wallet — scan the other person's receive-QR, enter (or read) the amount, your own wallet sends.
 * Non-custodial: BIII builds the intent, never holds a key. Pure + fail-closed.
 *
 * Fail-closed on the scan side: anything that isn't a Base (8453) USDC recipient — wrong chain, a native-ETH
 * value transfer, a non-USDC token, a malformed address — is REJECTED, so a scan can never silently send the
 * wrong asset on the wrong chain to a bad target.
 */
const T = require('./till');
const CHAIN = 8453;
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

/**
 * parsePaymentQR — parse a scanned QR string into a validated payment target.
 * Accepts: a bare 0x address · `ethereum:0xADDR@8453` · a BIII EIP-681 transfer
 *          `ethereum:<USDC>@8453/transfer?address=0xRECIP&uint256=<micro>`.
 * Returns { valid, to, amountMicro|null, amountUsd|null, token, chainId, form } or { valid:false, reason }.
 */
function parsePaymentQR(text) {
  const s = String(text || '').trim();
  if (!s) return { valid: false, reason: 'empty QR' };

  if (isAddr(s)) return { valid: true, to: s.toLowerCase(), amountMicro: null, amountUsd: null, token: T.USDC_BASE, chainId: CHAIN, form: 'address' };

  const m = s.match(/^ethereum:([^@/?]+)(@\d+)?(\/transfer)?(\?.*)?$/i);
  if (!m) return { valid: false, reason: 'not a 0x address or an ethereum: URI' };
  const target = m[1];
  const chainId = m[2] ? Number(m[2].slice(1)) : CHAIN;
  const isTransfer = !!m[3];
  const params = new URLSearchParams(m[4] ? m[4].slice(1) : '');

  if (!Number.isInteger(chainId) || chainId !== CHAIN) return { valid: false, reason: 'not Base (chainId 8453) — refusing' };

  if (isTransfer) {
    if (String(target).toLowerCase() !== T.USDC_BASE) return { valid: false, reason: 'not a USDC transfer — refusing (BIII is USDC-on-Base)' };
    const to = params.get('address');
    const micro = params.get('uint256');
    if (!isAddr(to)) return { valid: false, reason: 'transfer has no valid recipient address' };
    const amountMicro = (micro != null && /^\d+$/.test(micro) && BigInt(micro) > 0n) ? micro : null;
    return { valid: true, to: to.toLowerCase(), amountMicro, amountUsd: amountMicro ? T.microToUsd(amountMicro) : null, token: T.USDC_BASE, chainId: CHAIN, form: 'eip681-transfer' };
  }

  // bare `ethereum:0xADDR@8453` (no /transfer). A native-ETH `value=` param is IGNORED — a USDC app never
  // auto-sends ETH; the address is taken as the USDC recipient and the amount is entered in-app.
  if (isAddr(target)) return { valid: true, to: target.toLowerCase(), amountMicro: null, amountUsd: null, token: T.USDC_BASE, chainId: CHAIN, form: 'address' };
  return { valid: false, reason: 'unrecognized ethereum: target (not a 0x address)' };
}

/**
 * receiveURI — build the QR a user SHOWS to receive USDC. With an amount, it's a full BIII EIP-681 transfer
 * intent (the payer scans and the amount is prefilled); without one, a bare address URI (the payer enters it).
 */
/* ⛔ UN MONTANT DEMANDE ET ILLISIBLE DEVENAIT « PAS DE MONTANT », SANS UN MOT.
 * La garde etait `Number(amountUsd) > 0`, et elle faisait DEUX fautes opposees a la fois.
 *
 * 1. ELLE REJETAIT CE QUE NOTRE PROPRE PARSEUR ACCEPTE. `usdToMicro` (lib/till.js) fait
 *    `String(usd).trim().replace(',', '.')` — la virgule decimale francaise est geree DEPUIS
 *    TOUJOURS. Mais Number('5,50') vaut NaN, donc la valeur n atteignait jamais le parseur qui
 *    l aurait lue. Ce n est pas une copie plus faible du helper: c est un PORTIER qui refuse ce que
 *    le helper accepte. L interface de ce produit est en francais, et le chemin PAYEUR de
 *    web/p2p.html fait deja `v.replace(",", ".")` — le meme probleme, corrige d un cote seulement.
 *
 * 2. ELLE DEGRADAIT EN SILENCE. Un montant illisible ne levait rien: on retombait sur l URI SANS
 *    montant. Le commercant montre un QR qu il croit porteur de 5,50 $, le payeur scanne et se voit
 *    demander de taper la somme lui-meme. Aucune erreur, aucune trace — le montant disparait.
 *    MESURE DU 2026-08-15: '5,50' et '1_000' -> `ethereum:0x…@8453`, montant perdu, exit normal.
 *
 * ⚖️ LA GARDE NE DOIT DECIDER QUE D UNE CHOSE: un montant a-t-il ete DEMANDE. Sa LISIBILITE
 * appartient a `usdToMicro`, qui la tranche deja, et qui refuse bruyamment avec la valeur vue
 * ('Infinity', '1e6', '0x10', 'true' restent refuses). La route /receive rend alors 400 au lieu de
 * servir un QR ampute. */
function receiveURI({ address, amountUsd } = {}) {
  if (!isAddr(address)) throw new Error('receiveURI needs a 0x Base address');
  const demande = amountUsd != null && String(amountUsd).trim() !== '';
  if (demande) return T.paymentURI(T.createCharge({ to: address, amountUsd, nowMs: Date.now() }));
  return 'ethereum:' + address.toLowerCase() + '@' + CHAIN;
}

module.exports = { parsePaymentQR, receiveURI, USDC_BASE: T.USDC_BASE, CHAIN };
