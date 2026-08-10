'use strict';
/**
 * thin-risk.js — servir ce que `thin` a MESURE, sans jamais le confondre avec ce que `thin` DIT.
 * ================================================================================================
 * `vetMeme` repond a une question d'IDENTITE: « est-ce le contrat que tu crois ? ». Son statut `thin`
 * veut dire « aucun contrat a liquidite credible ne porte ce symbole » — une phrase sur le symbole, pas
 * sur l'avenir de l'actif.
 *
 * ⛔ ET CE DEPOT A DEJA RETIRE UNE LECTURE POUR AVOIR MELANGE LES DEUX. `impersonation` a ete sorti du
 * risque parce qu'il repondait a l'identite: « est-ce le token que tu crois ? » n'est pas « est-ce que
 * ca va s'effondrer ? ». Fusionner la mesure de risque de `thin` dans son statut d'identite referait
 * exactement cette faute. Elle est donc servie A COTE, nommee, bornee, et jamais melangee au verdict.
 *
 * CE QUI A ETE MESURE (2026-08-09, annonce dans `announced-rules.js`, note vers l'avant depuis):
 * dans la branche « sur » — financeur ayant paye MOINS de vingt wallets freres lus — les symboles
 * `thin` ruggent a 88,4 % contre 18,9 % pour les autres, sur 242 tokens resolus, 141 et 33 financeurs
 * distincts, contre une base de 83,0 %.
 *
 * ⛔ LE TAUX EST RETENU TANT QUE LA BORNE N'EST PAS VERIFIEE, et c'est le coeur de ce module. Hors de
 * cette branche, la MEME lecture ne separe que de 15,1 points pour 20 disponibles — parce que 83 % de
 * la population entiere rugge et qu'il n'y reste presque rien a separer. Publier 88,4 % sans sa borne
 * donnerait a un appelant un chiffre qui ne s'applique nulle part, et il l'appliquerait partout.
 *
 * ⛔ ET C'EST UNE STATISTIQUE DE POPULATION, JAMAIS UNE AFFIRMATION SUR UN ACTIF. Dire « les tokens qui
 * portent cette lecture ruggent a 88,4 % » est une mesure; dire « CE token va rugger » serait une
 * accusation. La doctrine du depot porte sur la premiere et interdit la seconde.
 *
 * ⚠️ ET LE CHIFFRE SERVI EST LU DANS L'ANNONCE, pas recopie. Un nombre recopie derive en silence le jour
 * ou la mesure est refaite; lu depuis `ANNOUNCED`, il reste ce qu'on a PARIE — et git le prouve.
 */
const { ANNOUNCED } = require('./announced-rules');

const CLE = 'thin-sous-le-seuil';
/** Le seuil de la branche mesuree. Il vit ici ET dans `lib/prequential.js`; le test verifie qu'ils sont d'accord. */
const SEUIL_FRERES = 20;

/* ⛔ LES CHAINES SERVIES SONT EN ANGLAIS, les commentaires restent en francais.
 *
 * Defaut trouve le 2026-08-09 en comparant les DEUX divulgations que cet outil porte desormais: celle
 * de `vetMeme` (identite) est en anglais, la mienne etait en francais. `till_vet_meme` est expose a des
 * agents TIERS via le MCP heberge, et le reste de la reponse — description de l outil, `reason`,
 * `disclosure` — est anglophone.
 *
 * Ce n'est pas cosmetique: la divulgation est la piece CRITIQUE, c'est elle qui dit « jamais une
 * affirmation sur cet actif ». Une mise en garde que son lecteur ne peut pas lire n'est pas une mise
 * en garde. */
const DIVULGATION = 'POPULATION statistic observed by this node, never a claim about this asset. The '
  + 'rate is published ONLY inside the branch where it was measured; elsewhere it is WITHHELD, because '
  + 'the same reading is saturated there. Measured in-sample at announcement, graded forward since.';

/** L'annonce, ou `null` si personne ne l'a ecrite — auquel cas rien ne se sert. */
function annonce() {
  return ANNOUNCED.find((a) => a.key === CLE) || null;
}

/**
 * Compose l'observation servie a cote d'un verdict `vetMeme`.
 *
 * TROIS ETATS POUR LA BORNE, jamais deux:
 *   · `boundChecked: false` — on ne sait pas ou tombe le financeur: aucun taux;
 *   · `applies: false`      — financeur AU-DESSUS du seuil: la lecture y est saturee, aucun taux;
 *   · `applies: true`       — dans la branche mesuree: le taux du cote concerne, avec ses bornes.
 *
 * @param {object} a
 * @param {string} a.status              le statut rendu par `vetMeme`
 * @param {number|null|undefined} a.siblingCount  freres lus du financeur, si on les connait
 * @param {number} [a.gradedForward]     appels deja notes DEPUIS l'annonce (0 au depart, et il faut le dire)
 * @returns {object|null} null si aucune annonce n'existe — rien ne s'invente
 */
function observationThin({ status, siblingCount, gradedForward } = {}) {
  const a = annonce();
  if (!a) return null;

  /* ⛔ `gradedForward = 0` PAR DEFAUT ETAIT UNE AFFIRMATION DEGUISEE EN VALEUR NEUTRE. Mesure du
   * 2026-08-10: AUCUNE des deux routes servies ne le fournit — ni `bin/biii-mcp.js:655`, ni
   * `lib/server.js` — donc `inSample` valait `true` en permanence, c'est-a-dire « le pari n'a encore
   * rien note en avant ». C'est vrai aujourd'hui (0 appel resolu, mesure), et ca le restera dans le
   * texte servi le jour ou ce ne sera plus vrai: une garde qui POURRIT, dans une sortie facturee.
   *
   * « personne ne me l'a dit » n'est pas « rien n'a ete note ». Sans le chiffre, les deux champs sont
   * `null` et la raison est nommee. Le fournir reste possible — `gradeAnnounced()` de `lib/prequential.js`
   * rend exactement ce compte par pari — mais l'appeler dans un chemin de requete est un choix de
   * conception (il charge toute la base d'observations), donc il n'est pas fait ici en douce. */
  const noteFourni = typeof gradedForward === 'number' && Number.isFinite(gradedForward);

  const base = {
    /* `reading` est un IDENTIFIANT, pas de la prose: il nomme l'entree gelee de `announced-rules.js` et
     * doit rester litteralement le meme des deux cotes. Un identifiant ne se traduit pas. */
    reading: CLE,
    /* ⛔ ET LE LABEL EST TRADUIT ICI PLUTOT QUE RELAYE. Celui de l'annonce est en francais, et
     * `announced-rules.js` porte une regle non negociable: « une entree ne se MODIFIE jamais ». Le
     * corriger la-bas casserait la garantie qui rend le pari infalsifiable. Le SERVICE porte donc sa
     * propre description anglaise; l'engagement, lui, reste intact et git le prouve. */
    label: 'symbol reads `thin`, INSIDE the safe branch of the funder-20 rule',
    announcementLabel: a.label,     // la prose de l'engagement, telle quelle, pour qui veut la source
    bound: 'launch funder having paid fewer than ' + SEUIL_FRERES + ' sibling wallets, READ',
    announcedAt: a.announcedAt,
    gradedForward: noteFourni ? gradedForward : null,
    inSample: noteFourni ? gradedForward === 0 : null,
    gradedForwardNote: noteFourni
      ? undefined
      : 'the caller did not supply how many calls this bet has graded since its announcement, so '
        + '`inSample` is UNKNOWN rather than true — "nobody told me" is not "nothing has been graded"',
    disclosure: DIVULGATION,
  };

  /* Le statut doit etre LU et VERIFIE. `not_a_candidate` et `unknown` veulent dire « pas verifie », et
   * les compter comme « pas thin » coute 3,3 points sur quatre lignes dans ce terrain — mesure. */
  if (typeof status !== 'string' || status === 'not_a_candidate' || status === 'unknown') {
    return { ...base, boundChecked: false, applies: null, rate: null,
      why: 'the symbol was not checked — "not checked" is not "checked and not thin", so nothing is published' };
  }

  if (typeof siblingCount !== 'number' || !Number.isFinite(siblingCount)) {
    return { ...base, boundChecked: false, applies: null, rate: null,
      why: 'the funder was not traced, so we cannot tell whether this token falls inside the measured '
        + 'branch: the rate is WITHHELD. Outside that branch the same reading separates by only 15.1 '
        + 'points out of 20 available, and is worth nothing.',
      howToCheck: 'trace the launch funder (siblingCount), then call again with that value' };
  }

  if (siblingCount >= SEUIL_FRERES) {
    return { ...base, boundChecked: true, applies: false, rate: null, siblingCount,
      why: 'funder ABOVE the threshold: almost everything rugs there and this reading separates nothing '
        + '— a rate published here would be a ceiling dressed as a signal' };
  }

  const cote = status === 'thin' ? 'danger' : 'safe';
  const rate = cote === 'danger' ? a.predicted.dangerRate : a.predicted.safeRate;
  return { ...base, boundChecked: true, applies: true, siblingCount, side: cote, rate,
    baseRate: a.basis.baseRate,
    n: a.basis.n,
    funders: cote === 'danger' ? a.basis.dangerFunders : a.basis.safeFunders,
    why: cote === 'danger'
      ? 'symbol reads `thin` INSIDE the measured branch: tokens carrying this reading rugged at '
        + (100 * rate).toFixed(1) + ' % against a base rate of ' + (100 * a.basis.baseRate).toFixed(1) + ' %'
      : 'symbol CHECKED and not thin, INSIDE the measured branch: those tokens rugged at '
        + (100 * rate).toFixed(1) + ' % against a base rate of ' + (100 * a.basis.baseRate).toFixed(1) + ' %' };
}

module.exports = { observationThin, CLE, SEUIL_FRERES, DIVULGATION };
