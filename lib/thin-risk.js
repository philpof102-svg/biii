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

const DIVULGATION = 'Statistique de POPULATION observee par ce noeud, jamais une affirmation sur cet '
  + 'actif. Le taux n est publie QUE dans la branche ou il a ete mesure; ailleurs il est RETENU parce '
  + 'que la meme lecture y est saturee. Mesure in-sample a l annonce, notee vers l avant depuis.';

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
function observationThin({ status, siblingCount, gradedForward = 0 } = {}) {
  const a = annonce();
  if (!a) return null;

  const base = {
    reading: CLE,
    label: a.label,
    bound: 'financeur ayant paye moins de ' + SEUIL_FRERES + ' wallets freres LUS',
    announcedAt: a.announcedAt,
    gradedForward,
    inSample: gradedForward === 0,
    disclosure: DIVULGATION,
  };

  /* Le statut doit etre LU et VERIFIE. `not_a_candidate` et `unknown` veulent dire « pas verifie », et
   * les compter comme « pas thin » coute 3,3 points sur quatre lignes dans ce terrain — mesure. */
  if (typeof status !== 'string' || status === 'not_a_candidate' || status === 'unknown') {
    return { ...base, boundChecked: false, applies: null, rate: null,
      why: 'le symbole n a pas ete verifie — « pas verifie » n est pas « pas thin », donc rien ne se publie' };
  }

  if (typeof siblingCount !== 'number' || !Number.isFinite(siblingCount)) {
    return { ...base, boundChecked: false, applies: null, rate: null,
      why: 'le financeur n a pas ete trace: on ignore si ce token tombe dans la branche mesuree, donc le '
        + 'taux est RETENU. Hors de cette branche la meme lecture ne separe que de 15,1 points pour 20 '
        + 'disponibles et ne vaut rien.',
      howToCheck: 'tracer le financeur (siblingCount) puis rappeler avec cette valeur' };
  }

  if (siblingCount >= SEUIL_FRERES) {
    return { ...base, boundChecked: true, applies: false, rate: null, siblingCount,
      why: 'financeur AU-DESSUS du seuil: la population y rugge deja massivement et cette lecture n y '
        + 'separe rien — un taux publie ici serait un plafond deguise en signal' };
  }

  const cote = status === 'thin' ? 'danger' : 'safe';
  const rate = cote === 'danger' ? a.predicted.dangerRate : a.predicted.safeRate;
  return { ...base, boundChecked: true, applies: true, siblingCount, side: cote, rate,
    baseRate: a.basis.baseRate,
    n: a.basis.n,
    funders: cote === 'danger' ? a.basis.dangerFunders : a.basis.safeFunders,
    why: cote === 'danger'
      ? 'symbole `thin` DANS la branche mesuree: les tokens qui portent cette lecture ont rugge a '
        + (100 * rate).toFixed(1) + ' % contre une base de ' + (100 * a.basis.baseRate).toFixed(1) + ' %'
      : 'symbole verifie NON-thin DANS la branche mesuree: ces tokens ont rugge a '
        + (100 * rate).toFixed(1) + ' % contre une base de ' + (100 * a.basis.baseRate).toFixed(1) + ' %' };
}

module.exports = { observationThin, CLE, SEUIL_FRERES, DIVULGATION };
