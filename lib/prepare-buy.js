'use strict';
/**
 * prepare-buy — a NON-CUSTODIAL, VETTED, CAPPED buy intent. The agent PREPARES; a wallet-policy the OPERATOR
 * controls EXECUTES. BIII holds no key, signs nothing, moves no funds. This is the compliant answer to
 * "let the agent buy": the agent gets full autonomy to FIND + PREPARE the buy, the actual transfer stays
 * gated by the operator's wallet. Fail-closed: it refuses to prepare a buy of an impersonation/unsafe token
 * or a payment to a known-bad recipient — the safe-to-pay brake, applied before an intent is even offered.
 */
const T = require('./till');
const { screenAddress } = require('./screen');
const { assessAsset } = require('./asset');

/**
 * @param {object} o
 * @param {string} o.to             recipient / seller / DEX-router address the USDC goes to
 * @param {string|number} o.amountUsd
 * @param {string|number} [o.maxUsd] hard cap; amount must be ≤ this (defaults to amountUsd)
 * @param {string} [o.token]        the token being ACQUIRED — vetted for genuineness if given
 * @param {string} [o.claimedIssuer] / [o.claimedSymbol]  claims to check the token against (impersonation)
 * @param {Array}  [o.registry]     issuer-verified registry entries (for the asset vet)
 * @param {object} [o.floor]        the known-bad screen (loadFloor()) for the recipient screen
 */
function prepareBuy({ to, amountUsd, maxUsd, token, claimedIssuer, claimedSymbol, registry, floor } = {}) {
  const amt = Number(amountUsd);
  if (!(amt > 0)) return { ok: false, reason: 'amountUsd must be a positive number' };
  const cap = Number(maxUsd != null ? maxUsd : amountUsd);
  if (!(cap > 0) || amt > cap) return { ok: false, reason: `amount $${amt} exceeds the cap $${cap} — refusing (never prepare a buy above the cap)` };
  const recipient = String(to || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) return { ok: false, reason: 'recipient `to` must be a 0x Base (EVM) address' };

  // 1. SAFE-TO-PAY on the recipient — a known-bad payee is a hard refuse (decisive, no intent offered).
  const scr = screenAddress(recipient, floor);
  if (scr.blocked) return { ok: false, reason: 'recipient is KNOWN-BAD (denylist) — refusing to prepare a buy: ' + scr.reason, recipientVerdict: 'known-bad' };
  /* ⛔ « ON N'A PAS PU SCREENER » DEVENAIT « LE DESTINATAIRE N'EST PAS KNOWN-BAD ».
   *
   * `screenAddress` rend TROIS etats et le dit dans sa propre raison:
   *
   *     { blocked: true,  available: true  }   sur la denylist
   *     { blocked: false, available: true  }   verifie, absent de la liste
   *     { blocked: false, available: false }   « no known-bad list loaded — screening UNAVAILABLE,
   *                                              not a clean verdict »
   *
   * Ce fichier ne lisait que `blocked`. Liste non chargee => `blocked === false` => on tombait jusqu'a
   * la construction de l'intention de paiement, qui publie `recipientVerdict: 'not-known-bad'` — une
   * AFFIRMATION sur le destinataire, fabriquee par notre propre incapacite a regarder. Et la
   * divulgation en dessous s'appuyait dessus: « it removes specific risks », un risque jamais verifie.
   *
   * Le module source avertissait dans sa chaine de raison; l'appelant la jetait avec le champ. C'est le
   * miroir exact de « ne jamais accuser sur sa propre incompletude » — ici on ABSOUT, ce qui est pire
   * sur un chemin qui construit une intention de paiement.
   *
   * On REFUSE. Rien n'est consomme ici (aucun paiement, aucun nonce), donc le refus ne coute que sa
   * relance, et il nomme precisement ce qui manque au lieu de renvoyer un « non » opaque. */
  if (scr.available !== true) {
    return { ok: false, recipientVerdict: 'unscreened',
      reason: 'REFUSING to prepare a buy: the known-bad screen is UNAVAILABLE (' + (scr.reason || 'no reason given')
        + '), so the recipient was never checked. This is NOT a finding about the recipient — it is a gap '
        + 'in our own coverage, and absolving an address we could not look up is exactly the error this '
        + 'tool exists to prevent. NOTHING WAS CONSUMED: load the known-bad floor and retry.' };
  }

  // 2. If acquiring a token, VET it — an impersonation / denylisted contract is a hard refuse.
  let asset = null;
  if (token) {
    asset = assessAsset({ token: String(token).toLowerCase(), claimedIssuer, claimedSymbol }, registry ? { registry } : {});
    if (asset.status === 'impersonation' || asset.status === 'unsafe') {
      /* ⚠️ MEME CLE, DEUX FORMES. Sur le refus, `assetVerdict` etait une CHAINE; sur le succes, un OBJET.
       * Un appelant ecrivant `r.assetVerdict.status` — la forme documentee par le chemin qui reussit —
       * recevait `undefined` sur le refus, c'est-a-dire au moment precis ou il devait lire un verdict.
       * Meme famille que la cle `canonical` absente du chemin `thin` dans lib/meme.js, deja corrigee: une
       * forme de reponse qui change selon la branche oblige a deviner. */
      return { ok: false, reason: `the token to acquire is ${asset.status} — refusing to prepare a buy of a look-alike/denylisted contract`,
        assetVerdict: { status: asset.status, provenance: asset.provenance || null,
          safeToAcquire: asset.safeToAcquire === true, issuerKnown: asset.issuerKnown === true,
          reason: asset.reason || null },
        genuine: asset.genuineAddress || null };
    }
  }

  // 3. Build the CAPPED, non-custodial payment intent (USDC on Base). The operator's wallet/policy executes it.
  const charge = T.createCharge({ to: recipient, amountUsd: String(amt),
    label: 'prepared buy' + (asset && asset.symbol ? ' ' + asset.symbol : ''), nowMs: Date.now() });
  return {
    ok: true,
    intent: { paymentURI: T.paymentURI(charge), to: recipient, amountUsd: amt, amountMicro: charge.amountMicro,
      token: T.USDC_BASE, chainId: 8453, capUsd: cap },
    /* Atteignable UNIQUEMENT quand `scr.available === true` (garde plus haut), donc l'affirmation est
     * desormais meritee. Sa provenance voyage avec elle — quelle liste, arretee a quelle date — parce
     * qu'un « not-known-bad » sans sa source ne peut etre ni date ni contredit par un lecteur. */
    recipientVerdict: 'not-known-bad',
    recipientScreen: { available: true, basis: scr.reason || null },
    /* ⚠️ LA NUANCE N'ARRIVAIT PAS JUSQU'A L'ACHETEUR. `assetVerdict` ne portait que `status`, donc deux
     * situations tres differentes se lisaient toutes deux « unknown »: « jamais entendu parler de cet
     * emetteur » et « emetteur VERIFIE chez nous, mais ce produit-la n'est pas dans notre liste ». La
     * seconde est bien plus decidable — elle dit ou aller verifier.
     *
     * Contexte, 2026-07-28: `assessAsset` accusait d'usurpation sur la seule correspondance d'emetteur,
     * donc un autre produit legitime du meme emetteur etait BLOQUE ici par une accusation fausse. Le
     * rétrécissement le laisse passer — correctement — et cette ligne est ce qui empeche « passe » de se
     * lire comme « rien a signaler ». `safeToAcquire` reste `false`, et il doit se VOIR. */
    assetVerdict: asset ? { status: asset.status, provenance: asset.provenance || null,
      safeToAcquire: asset.safeToAcquire === true, issuerKnown: asset.issuerKnown === true,
      reason: asset.reason || null } : null,
    disclosure: 'PREPARED, non-custodial: BIII signs nothing and moves no funds — YOUR wallet/policy executes this capped intent. A not-known-bad recipient + a genuine/unknown token is NOT a buy recommendation; it removes specific risks, nothing more. Re-verify on-chain before executing.',
  };
}

module.exports = { prepareBuy };
