'use strict';
/**
 * poisson.js — l'intervalle de confiance exact d'un TAUX estime sur un petit nombre d'evenements.
 *
 * Ce depot publie des taux. La regle qu'il s'est donnee est qu'un chiffre voyage avec sa borne, et
 * `scorecard-open-calls` va plus loin: quand une quantite est incertaine, on publie les DEUX bornes,
 * pas le point. Pour un compte d'evenements rares — une divergence par jour, un rug sur vingt tokens —
 * le point estime n'a aucune autorite: un seul evenement observe est compatible avec un taux 200 fois
 * plus faible et un taux 5 fois plus fort. Publier le point seul, c'est une affirmation.
 *
 * L'intervalle rendu est l'intervalle de Poisson EXACT (Garwood), bilateral a 95 % par defaut:
 *   borne basse  = le plus PETIT lambda tel que P(X >= k | lambda) >= alpha/2
 *   borne haute  = le plus GRAND lambda tel que P(X <= k | lambda) >= alpha/2
 * Il est conservateur par construction (couverture >= 95 %), ce qui est le bon sens de l'erreur ici:
 * un intervalle trop large fait dire « on ne sait pas encore », un intervalle trop etroit fait agir.
 *
 * ⛔ CE QU'IL NE PEUT PAS FAIRE: valider l'hypothese de Poisson. Il suppose des evenements
 * INDEPENDANTS a taux constant. Quinze tokens derriere un meme financeur ne sont pas quinze tirages,
 * et un taux qui change au milieu de la fenetre n'est pas un taux. Le controle d'independance appartient
 * a l'appelant — c'est la meme faute que `prequential-protocol` traque (N observations != N operateurs).
 */

/** P(X <= k | lambda). Somme directe: exacte et stable pour les lambda que ce depot manipule. */
function cdfPoisson(k, lambda) {
  if (!(k >= 0) || !(lambda >= 0)) return NaN;
  let terme = Math.exp(-lambda), somme = terme;
  for (let i = 1; i <= k; i++) { terme *= lambda / i; somme += terme; }
  return Math.min(somme, 1);
}

/**
 * Intervalle de confiance exact sur le NOMBRE attendu d'evenements, pour k observes.
 * Rend `[basse, haute]`. Pour k = 0 la borne basse vaut 0 — zero evenement n'exclut aucun taux faible,
 * et rendre autre chose ferait dire a une absence d'observation quelque chose qu'elle ne dit pas.
 */
function intervallePoisson(k, alpha = 0.05) {
  if (!Number.isInteger(k) || k < 0) return [NaN, NaN];
  const q = alpha / 2;
  const LMAX = 1e6;
  /* Bissection. `croissant` dit dans quel sens le predicat bascule: les deux bornes n'ont PAS la meme
   * monotonie, et un bissecteur unique melangerait les deux en silence. */
  const bissect = (predicat, croissant) => {
    let bas = 0, haut = LMAX;
    for (let i = 0; i < 300; i++) {
      const mid = (bas + haut) / 2;
      if (predicat(mid) === croissant) haut = mid; else bas = mid;
    }
    return croissant ? haut : bas;
  };
  const basse = k === 0 ? 0 : bissect((l) => 1 - cdfPoisson(k - 1, l) >= q, true);
  const haute = bissect((l) => cdfPoisson(k, l) >= q, false);
  return [basse, haute];
}

/**
 * Le meme intervalle ramene a un TAUX, en divisant par l'exposition (heures, tokens, appels...).
 * ⛔ Rend `null` si l'exposition n'est pas un nombre strictement positif. Une exposition absente ou
 * nulle ne donne pas « un taux de zero »: elle ne donne AUCUN taux, et la distinction est celle que ce
 * depot a du reparer sept fois (`n ? x/n : null` ecrase deux etats en un).
 */
function tauxAvecBornes(k, exposition, alpha = 0.05) {
  if (!(exposition > 0) || !Number.isInteger(k) || k < 0) {
    return { taux: null, basse: null, haute: null, k, exposition,
      raison: 'exposition absente, nulle ou negative — aucun taux ne se calcule' };
  }
  const [lo, hi] = intervallePoisson(k, alpha);
  return { taux: k / exposition, basse: lo / exposition, haute: hi / exposition, k, exposition, raison: null };
}

module.exports = { cdfPoisson, intervallePoisson, tauxAvecBornes };
