'use strict';
/**
 * BIII trust triangle — the sellable core: three independent vertices → one payment verdict.
 * ==========================================================================================
 * The white-label pitch, as code. A partner brings merchants; BIII decides whether a payment
 * is TRUSTED by composing three signals that already exist in the stack — none of which any
 * single party can fake:
 *
 *   REPUTATION  (MainStreet) — is the counterparty safe to pay?      → before money moves
 *   STANDING    (LAWBOR)     — proven paid history, agent↔agent?      → the agent economy
 *   SETTLEMENT  (BIII/chain) — is THIS payment real on-chain?         → the receipt
 *
 * Pure & fail-closed: every vertex is INJECTED (already-fetched data), so this is deterministic,
 * testable, and a partner can wire their OWN oracle for any vertex. Unknown is never "safe".
 * The MCP/server fetches the vertices (MainStreet HTTP, LAWBOR, the chain) and calls this.
 */

const T = require('./till');

/** REPUTATION vertex: MainStreet "safe to pay". rep = { decision, score } | null. */
// ALLOWLIST of safe decisions — never a denylist. MainStreet emits BLOCK/CAUTION/PROCEED/PROCEED_LOW_VALUE;
// the old code only flagged REFUSE/AVOID/BLOCK, so CAUTION (its middle "risky" tier) fell through to 'safe'.
// Now ONLY an explicit proceed clears; CAUTION / unknown / anything else is weak-or-unsafe, never safe.
const REP_SAFE = new Set(['PROCEED', 'PROCEED_LOW_VALUE', 'SAFE', 'OK', 'PASS']);
const REP_UNSAFE = new Set(['BLOCK', 'REFUSE', 'AVOID', 'DENY', 'DECLINE', 'UNSAFE']);
function repVertex(rep, minScore = 40) {
  if (!rep || (rep.decision == null && rep.verdict == null && rep.score == null)) return { status: 'unknown', reason: 'no reputation data' };
  const d = String(rep.decision ?? rep.verdict ?? '').trim().toUpperCase();  // trim: ' REFUSE ' must still flag
  const s = Number(rep.score);
  const hasScore = Number.isFinite(s);
  if (REP_UNSAFE.has(d)) return { status: 'unsafe', reason: `oracle flags this counterparty (${d})`, score: hasScore ? s : null };
  if (REP_SAFE.has(d)) {
    if (hasScore && s < minScore) return { status: 'weak', reason: `${d} but score ${s} < floor ${minScore}`, score: s };
    return { status: 'safe', reason: `oracle: ${d}${hasScore ? ` (${s})` : ''}`, score: hasScore ? s : null };
  }
  if (d) return { status: 'weak', reason: `oracle: ${d} — not an explicit proceed (e.g. CAUTION)`, score: hasScore ? s : null };
  // no decision — a bare score can clear only at/above the floor; a non-finite score is unknown, never safe
  if (!hasScore) return { status: 'unknown', reason: 'no usable reputation signal' };
  return s < minScore ? { status: 'weak', reason: `score ${s} < floor ${minScore}`, score: s }
    : { status: 'safe', reason: `score ${s}`, score: s };
}

/**
 * STANDING vertex: LAWBOR proven paid history WITH this counterparty — in THREE states, because two was
 * a statement we had no right to make.
 *
 * ═══ LA FAUTE CORRIGEE ICI, ET ELLE ETAIT DEJA CONNUE ═══
 * La version precedente repliait `null` et `paidMicro: 0` dans le meme verdict:
 *
 *     if (micro == null || micro <= 0) return { status: 'none', reason: 'no proven history yet' };
 *
 * Or ce sont deux faits OPPOSES. `null` veut dire « on n'a interroge personne » — le noeud LAWBOR n'etait
 * pas configure (BIII_LAWBOR_URL absente de .env.example, verifie: zero occurrence) ou n'a pas repondu.
 * `0` veut dire « on a demande, et il n'y a effectivement aucun historique ». La premiere est une lacune
 * de NOTRE cote; la seconde est une information sur la contrepartie.
 *
 * Mesure du 2026-07-27 sur le binaire livre, sans BIII_LAWBOR_URL: `till_trust` rendait
 * `standing: { status: 'none', reason: 'no proven history yet' }` — une AFFIRMATION sur la contrepartie,
 * alors qu'aucun appel n'avait ete fait. Le mot LAWBOR n'apparaissait nulle part dans la sortie et aucun
 * avertissement ne signalait le sommet manquant. Un appelant lisait un « triangle de confiance » calcule
 * a deux sommets sans le savoir.
 *
 * C'est exactement la reparation deja faite dans rugsignals (`ownerState`: live / renounced / unknown),
 * ou « owner absent » etait lu comme « owner renonce » et desamorcait des drapeaux. Meme faute, un module
 * plus loin, restee en place parce que personne n'etait alle regarder.
 *
 * ═══ ET LA MEME FAUTE, UN CRAN PLUS BAS: UN ZERO N'EST UNE PREUVE QUE SI LE NOEUD POUVAIT VOIR AUTRE CHOSE ═══
 * La correction ci-dessus separe « on n'a pas demande » de « on a demande, c'est vide ». Elle suppose
 * encore qu'un `0` rendu par un noeud CONSULTE veut dire « il n'y a effectivement aucun historique ».
 * C'est faux quand le noeud est structurellement aveugle.
 *
 * Le standing est une quantite CONSERVEE, bornee par la depense irrecuperable du noeud lui-meme
 * (`Σ direct ≤ spend(V)`, voir lawbor/RATING-DESIGN.md). Un noeud qui n'a jamais rien paye a une borne de
 * zero: il rend `directMicro: "0"` pour TOUTE adresse de Base, honnete ou non. Son zero n'est pas une
 * mesure, c'est un angle mort — et il le dit lui-meme dans sa reponse:
 *
 *     "bound": { "spendMicro": "0", "maxTotalMicro": "0" }
 *     "limits": ["cold start is total: a node that has paid nobody sees 0 for everyone,
 *                 including honest workers", ...]
 *
 * Mesure du 2026-07-27 sur le noeud de prod (lawbor-node-production, HTTP 200, format conforme):
 * `spendMicro` = "0". Cabler BIII_LAWBOR_URL dessus aurait transforme le `unqueried` honnete en
 * `none` — « consulte: aucun historique prouve » — pour toutes les contreparties, definitivement.
 * Le sommet aurait compte comme LU (`complete: true`, aucun avertissement) tout en ne portant aucune
 * information. Reparer le sommet manquant aurait donc introduit une affirmation fausse.
 *
 * ⚠️ Cette faute n'etait trouvable qu'en INTERROGEANT l'API vivante: `bound` n'apparait ni dans ce
 * fichier ni dans la doc. Troisieme occurrence du meme motif dans ce depot (rugsignals `ownerState`,
 * puis `standing`, maintenant la borne) — chaque correction descend d'un cran et trouve la distinction
 * encore manquante en dessous.
 *
 * `uninformative` n'est PAS un verdict negatif et n'accorde jamais de confiance: il compte comme non-lu,
 * exactement comme `unqueried`, parce que c'est ce qu'il est.
 *
 * @param st { paidMicro, bound? } | null | { unqueried: true, reason }
 */
function standingVertex(st) {
  /* FAIL-CLOSED: absence d'interrogation != absence d'historique. `unqueried` n'est PAS un vert, et sa
   * raison dit ce qui manque de NOTRE cote plutot que d'affirmer quoi que ce soit sur autrui. */
  if (st == null) {
    return { status: 'unqueried',
      reason: 'the LAWBOR node was not consulted (BIII_LAWBOR_URL unset) — this is NOT a statement about '
        + 'the counterparty, it is a missing vertex on our side' };
  }
  if (st.unqueried) {
    return { status: 'unqueried',
      reason: st.reason || 'the LAWBOR node did not answer — a vertex we could not read, not a verdict' };
  }
  const micro = st.paidMicro ?? st.micro;
  if (micro != null && BigInt(String(micro || '0')) > 0n) {
    return { status: 'proven', reason: 'proven paid history', paidUsd: T.microToUsd(String(micro)) };
  }
  /* Le zero est arrive. Le noeud pouvait-il seulement voir autre chose ? */
  const ceiling = standingCeiling(st.bound);
  if (ceiling === null) {
    /* Borne non declaree: on ne peut PAS verifier que ce zero est une mesure, donc on ne le promeut pas
     * en preuve. Fail-closed sur cet axe aussi — `uninformative` ne peut que rendre le verdict plus
     * prudent, jamais plus confiant. */
    return { status: 'uninformative',
      reason: 'consulted, and it answered zero — but it did not declare its bound, so we cannot tell '
        + 'whether that zero is a measurement or a blind spot. Unread, not empty.' };
  }
  if (ceiling <= 0n) {
    return { status: 'uninformative',
      reason: 'consulted, and it answered zero — but its own bound is zero (it has paid nobody), so it '
        + 'reports zero for EVERY address including honest ones. A cold start is not a finding.' };
  }
  return { status: 'none',
    reason: 'consulted: no proven paid history with this counterparty yet (the node has spend of its own, '
      + 'so this zero is a measurement rather than a blind spot)' };
}

/**
 * Plafond de ce que ce noeud peut attester, en micro-USDC, ou `null` si non declare.
 *
 * La somme DIRECTE est bornee par la depense propre du noeud (`Σ direct ≤ spend(V)`), donc `spendMicro`
 * est la borne juste ici; `maxTotalMicro` — qui vaut (1+alpha)*spend et borne direct+cercle — sert de
 * repli quand le noeud ne publie que celle-la. On ne devine jamais: une borne illisible rend `null`.
 */
function standingCeiling(bound) {
  if (bound == null || typeof bound !== 'object') return null;
  const raw = bound.spendMicro ?? bound.maxTotalMicro;
  if (raw == null) return null;
  try { return BigInt(String(raw)); } catch { return null; }
}

/** SETTLEMENT vertex: the BIII on-chain verification of THIS payment. verdict = till.verifyPayment() | null. */
function settlementVertex(verdict) {
  if (!verdict) return { status: 'pending', reason: 'no payment observed yet' };
  if (verdict.paid === true) return { status: 'settled', reason: `paid on-chain (${verdict.tier})`, txHash: verdict.txHash || null };
  return { status: 'failed', reason: verdict.reason || 'not paid' };
}

/**
 * assessTriangle — compose the three vertices into ONE payment verdict.
 * Inputs are already-fetched vertex data (all optional):
 *   { reputation:{decision,score}|null, standing:{paidMicro}|null, settlement:verifyResult|null }
 * Returns { trust, level, vertices, reasons, greens } where trust ∈
 *   'unsafe'   — the counterparty is flagged: DO NOT PAY (any other green is overridden)
 *   'settled'  — the payment is proven real on-chain (the strongest post-pay state)
 *   'trusted'  — vetted to pay (reputation safe OR proven standing), settlement not yet in
 *   'unknown'  — no positive signal: proceed with caution
 */
function assessTriangle({ reputation, standing, settlement } = {}, opts = {}) {
  const v = {
    reputation: repVertex(reputation, opts.minScore),
    standing: standingVertex(standing),
    settlement: settlementVertex(settlement),
  };
  const greens = ['reputation', 'standing', 'settlement'].filter((k) =>
    ['safe', 'proven', 'settled'].includes(v[k].status)).length;

  let trust;
  if (v.reputation.status === 'unsafe') trust = 'unsafe';           // a flag overrides everything
  else if (v.settlement.status === 'settled') trust = 'settled';    // money is proven — the top state
  else if (v.reputation.status === 'safe' || v.standing.status === 'proven') trust = 'trusted';
  else trust = 'unknown';

  const level = { unsafe: 0, unknown: 1, trusted: 2, settled: 3 }[trust];

  /* COMBIEN DE SOMMETS PORTENT REELLEMENT DE L'INFORMATION.
   * Un triangle calcule a deux sommets n'est pas un triangle, et le lecteur doit le savoir sans avoir a
   * inspecter chaque `status`. 'none', 'weak' et 'pending' sont des REPONSES — on a regarde et voici le
   * resultat — et comptent donc comme lus.
   *
   * DEUX etats comptent comme non-lus, pour la meme raison de fond:
   *   `unqueried`     — on n'a pas pu demander (variable absente, noeud injoignable, HTTP non-200)
   *   `uninformative` — on a demande et on a obtenu une reponse, mais elle ne distingue rien: la source
   *                     rendait la meme chose quelle que soit la contrepartie (voir standingVertex).
   * Le second est le plus traitre des deux, parce qu'il a l'apparence complete d'une reponse. */
  const UNREAD = new Set(['unqueried', 'uninformative']);
  const unqueried = Object.entries(v).filter(([, x]) => UNREAD.has(x.status)).map(([k]) => k);
  const complete = unqueried.length === 0;

  return {
    trust, level, greens, vertices: v,
    reasons: Object.entries(v).map(([k, x]) => `${k}: ${x.status} (${x.reason})`),
    payable: trust === 'trusted' || trust === 'settled',           // safe to hand money to
    proven: trust === 'settled',                                   // money already changed hands, verified
    complete, unqueriedVertices: unqueried,
    /* La note n'apparait QUE quand elle est vraie — un avertissement permanent se lit comme du decor et
     * cesse d'etre lu. */
    ...(complete ? {} : {
      incompleteNote: 'INCOMPLETE: ' + unqueried.length + ' of 3 vertices carry no information ('
        + unqueried.join(', ') + '). Either they could not be read, or they answered without '
        + 'distinguishing this counterparty from any other. A missing vertex is not a negative one: this '
        + 'verdict was composed from fewer signals than it appears to have, and a re-run with them '
        + 'readable may change it.',
    }),
  };
}

module.exports = { assessTriangle, repVertex, standingVertex, settlementVertex, standingCeiling };
