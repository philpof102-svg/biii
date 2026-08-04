'use strict';
/**
 * x402-settle — single-use + freshness guard for the paid /x402 verdicts.
 * =======================================================================
 * A confirmed USDC-on-Base payment TO the merchant, ≥ the price, redeems EXACTLY ONE verdict.
 * Without this, the paywall is trivially defeated: one $0.002 txHash replays into unlimited
 * verdicts, and ANY old qualifying payment to the merchant can be dredged up and reused. That
 * is zero revenue. `lib/chain.js` already binds one transfer to at most one charge; this applies
 * the same discipline to the x402 path.
 *
 * Non-custodial + bounded: we hold no key. Consumed txHashes are remembered only within the
 * freshness window (older ones are rejected by freshness anyway), so the store self-prunes.
 * Persistence is best-effort (survives a restart within the window); on an ephemeral host the
 * freshness window still caps the replay surface to a few minutes. For a stronger guarantee use a
 * persistent volume (BIII_X402_CONSUMED) or an on-chain nonce — see DEPLOY notes.
 */
const fs = require('node:fs'), path = require('node:path');

const STORE = process.env.BIII_X402_CONSUMED || path.join(__dirname, '..', 'data', 'x402-consumed.json');
const DEFAULT_MAX_AGE_BLOCKS = Number(process.env.BIII_X402_MAX_AGE_BLOCKS || 900); // ~30 min on Base (~2s blocks)

const consumed = new Map();   // txHash(lower) -> blockNumber it was consumed at
let loaded = false;
function load() {
  if (loaded) return; loaded = true;
  try { for (const [h, bn] of JSON.parse(fs.readFileSync(STORE, 'utf8'))) consumed.set(String(h).toLowerCase(), Number(bn)); }
  catch { /* no prior store — fresh */ }
}
function persist() {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify([...consumed])); }
  catch { /* best-effort; freshness still caps replay if this fails */ }
}
function prune(headBlock, maxAge) {
  if (!headBlock) return;
  for (const [h, bn] of consumed) if (headBlock - bn > maxAge) consumed.delete(h);
}

/**
 * nombreStrict — un nombre fini, ou `null`. JAMAIS de coercition des valeurs vides.
 *
 * `Number()` transforme `null`, `''`, `'   '`, `[]` et `false` en ZERO. Sur les deux champs qui ancrent
 * la garde anti-rejeu, zero veut dire « vient d'atterrir » et « bloc 0 » — soit la fraicheur maximale et
 * un enregistrement que la purge suivante efface. On exige donc la forme ATTENDUE plutot que d'enumerer
 * les formes fautives: j'ai bouche `null`, et `''` restait ouvert.
 */
function nombreStrict(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/**
 * settleOnce — validate a verifyTxHash proof against the price/merchant AND consume it single-use.
 * @returns {{ok:true}} or {{ok:false, code:number, reason:string}} (code 402 = pay/again, 409 = already redeemed)
 */
function settleOnce({ proof, merchant, needMicro, maxAgeBlocks = DEFAULT_MAX_AGE_BLOCKS } = {}) {
  load();
  /* La raison PRECISE remonte, sinon le correctif d'en dessous n'existe pas pour l'appelant.
   *
   * `verifyTxHash` distingue desormais « pas encore minee » de « introuvable » et de « on n'a pas pu
   * savoir ». Cette ligne ecrasait les trois par un generique, donc l'etat honnete etait calcule puis
   * jete une couche plus haut — le meme defaut que `b20Check: 'ok'` qui enregistrait qu'un controle
   * avait tourne sans jamais dire ce qu'il avait trouve.
   *
   * `ok` et `code` ne bougent pas: une pending n'est toujours PAS un paiement et le 402 reste. Ce qui
   * change est ce que l'agent lit — et entre « votre transaction n'existe pas » et « elle n'est pas
   * encore minee », il y a la decision de repayer. */
  if (!proof || !proof.paid) return { ok: false, code: 402,
    pending: proof && proof.pending === true ? true : undefined,
    reason: 'no confirmed USDC payment on Base'
      + (proof && proof.reason ? ' — ' + proof.reason : '') };
  if (String(proof.to || '').toLowerCase() !== String(merchant || '').toLowerCase())
    return { ok: false, code: 402, reason: 'payment was not sent TO the merchant (payTo)' };
  let paidMicro, priceNeed;
  try { paidMicro = BigInt(String(proof.valueMicro || '0')); priceNeed = BigInt(String(needMicro || '0')); }
  catch { return { ok: false, code: 402, reason: 'unreadable payment amount' }; }   // fail-closed, never throw a 500
  if (paidMicro < priceNeed)
    return { ok: false, code: 402, reason: 'underpaid: payment value < the price' };
  /* ═══ LES DEUX CHAMPS QUI ANCRENT LA GARDE NE PEUVENT PAS ETRE COALESCES ═══
   *
   * `Number(proof.confirmations || 0)` faisait d'un champ ABSENT un age de ZERO — c'est-a-dire
   * « vient d'atterrir », la fraicheur maximale. Le test `age > maxAgeBlocks` passait donc toujours.
   * Sur une garde dont le METIER est de refuser les preuves perimees, coalescer l'absence en fraicheur
   * est exactement le mauvais defaut.
   *
   * `Number(proof.blockNumber || 0)` etait pire par ricochet: l'empreinte consommee etait enregistree
   * au bloc 0, et le premier reglement suivant avec un vrai numero de bloc calculait
   * `head - 0 > maxAge` et PURGEAIT l'entree — le paiement redevenait rejouable.
   *
   * ⚠️ NON EXPLOITABLE AUJOURD'HUI, et il faut le dire: dans lib/chain.js, toute branche de
   * verifyTxHash qui rend `paid: true` porte les deux champs; celles qui les omettent rendent
   * `paid: false` et sont rejetees plus haut. C'est une validation d'entree fail-closed, pas la
   * fermeture d'un trou ouvert. Elle vaut parce que `settleOnce` est EXPORTE et prend un objet
   * quelconque: un futur appelant, un autre verificateur, un chemin rapide mis en cache, et la garde
   * disparait sans qu'un test rougisse. Meme raisonnement que le refus d'un payTo vide dans
   * challenge402, alors que la route le gardait deja.
   *
   * Trois etats, pas deux: un age ABSENT n'est ni recent ni ancien — il est indeterminable, et un
   * indeterminable ne franchit pas une porte. */
  /* `== null` AVANT `Number()`. Un premier jet testait seulement `Number.isFinite`, et `Number(null)`
   * vaut ZERO — fini, positif, donc « fraicheur maximale ». Un champ explicitement nul franchissait
   * ainsi la garde exactement comme un champ absent la franchissait avant. Verifie en test: la forme
   * `confirmations: null` passait encore apres la premiere correction. */
  /* ON EXIGE UNE FORME NUMERIQUE, on n'enumere pas les valeurs falsy. Deux fois de suite j'ai bouche un
   * trou de coercition en laissant le suivant ouvert: `Number(null)` vaut 0, puis `Number('')` vaut 0
   * aussi — « fraicheur maximale » dans les deux cas. Lister les formes fautives est un jeu qu'on perd;
   * exiger la forme ATTENDUE le termine. */
  const age = nombreStrict(proof.confirmations);
  if (age === null || age < 0)
    return { ok: false, code: 402, reason: 'proof carries no usable confirmation count — freshness cannot be established, and an unverifiable age is not a fresh one' };
  if (maxAgeBlocks && age > maxAgeBlocks)
    return { ok: false, code: 402, reason: 'payment too old — pay fresh for this call (anti-reuse of an old transfer)' };
  const bn = nombreStrict(proof.blockNumber);
  if (bn === null || bn <= 0)
    return { ok: false, code: 402, reason: 'proof carries no usable block number — the single-use record could not be anchored, and an unanchored record is pruned away on the next settle' };
  const h = String(proof.txHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) return { ok: false, code: 402, reason: 'missing/invalid txHash in proof' };
  if (consumed.has(h)) return { ok: false, code: 409, reason: 'payment already redeemed — one payment = one verdict' };
  const headNow = bn + age;                                // reconstruct chain head to self-prune stale entries
  prune(headNow, maxAgeBlocks);
  consumed.set(h, bn);
  persist();
  return { ok: true };
}

// test hook: clear in-memory + reload state
function _reset() { consumed.clear(); loaded = false; }

module.exports = { settleOnce, DEFAULT_MAX_AGE_BLOCKS, _consumed: consumed, _reset };
