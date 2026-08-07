'use strict';
/**
 * binomial.js — l'intervalle de confiance exact d'une PROPORTION, et le compte qui la rend honnete.
 *
 * `lib/poisson.js` borne un TAUX PAR EXPOSITION (k evenements en h heures). Ce depot publie surtout
 * autre chose: des PROPORTIONS (k rugs sur n tokens, k appels justes sur n resolus), et pour celles-la
 * Poisson est le mauvais modele — il n'a pas de borne superieure a 100 %, et il diverge des que k/n
 * s'approche de 1, ce qui est exactement le regime ou vivent les chiffres de ce depot (94 %, 89 %, 97 %).
 * Aucun intervalle de proportion n'existait ici: tous les pourcentages annonces sont des POINTS NUS.
 *
 * L'intervalle rendu est celui de Clopper-Pearson, exact et conservateur (couverture >= 1 - alpha):
 *   borne basse = le plus PETIT p tel que P(X >= k | n, p) >= alpha/2
 *   borne haute = le plus GRAND p tel que P(X <= k | n, p) >= alpha/2
 *
 * ⛔ CE QU'IL NE PEUT PAS FAIRE, ET C'EST LE PLUS IMPORTANT ICI: il suppose n tirages INDEPENDANTS.
 * Trente-sept tokens derriere deux financeurs ne sont pas trente-sept tirages. Mesure du 2026-08-07 sur
 * le radar: le profil « histoire courte » rugge a 3,2 % par TOKEN (1/31) et a 50 % par FINANCEUR (1/2) —
 * quatre-vingt-onze points d'ecart produits par le seul regroupement. Le depot le sait depuis le
 * 2026-08-04 (`lib/prequential.js`: 25 financeurs portent 800 des 981 tokens) et n'en tirait pas de
 * consequence sur ses taux publies.
 * C'est pourquoi `proportionAvecBornes` exige qu'on lui passe la TAILLE EFFECTIVE quand elle differe du
 * compte brut, et le dit dans sa sortie. Un intervalle etroit calcule sur des tirages correles est plus
 * dangereux qu'aucun intervalle: il donne a une coincidence l'apparence d'une mesure.
 */

/* Table de log-factorielles, etendue a la demande. Exacte pour des entiers, et elle evite d'avoir a
 * implementer une lgamma approchee. ⚠️ Sa taille suit le plus grand n rencontre — sans consequence aux
 * echelles de ce depot (quelques milliers), a revoir si un appelant y passe des millions. */
const LOG_FACT = [0];
function logFact(m) {
  for (let i = LOG_FACT.length; i <= m; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[m];
}

/**
 * P(X <= k | n, p).
 *
 * ⚠️ CALCULEE EN LOG, ET CE N'EST PAS DU LUXE. La version naive part de `(1-p)^n` et multiplie de proche
 * en proche. A n = 1000 et p = 0,53 ce premier terme vaut 10^-328: il DEPASSE PAR LE BAS et devient zero,
 * donc toute la somme devient zero — et la CDF rend 0 la ou la vraie valeur est 0,49. Le defaut a ete
 * attrape par la propriete definissante du test (P(X<=k|haute) rendait 0,116 au lieu de 0,025), pas par
 * une relecture: aucun cas a petit n ne le montre.
 * Le remede est le decalage par le terme maximal: on somme des exponentielles centrees sur le mode, ou
 * plus aucun terme n'est minuscule par accident.
 */
function cdfBinomial(k, n, p) {
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(k) || !(p >= 0) || !(p <= 1)) return NaN;
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p === 0) return 1;
  if (p === 1) return 0;                       // k < n, donc P(X <= k) = 0 quand p vaut exactement 1
  const lp = Math.log(p), lq = Math.log1p(-p), ln = logFact(n);
  const terme = (i) => ln - logFact(i) - logFact(n - i) + i * lp + (n - i) * lq;
  /* Le mode de la loi est en floor((n+1)p); borne a k, c'est le plus grand terme de la somme. */
  const mode = Math.min(k, Math.max(0, Math.floor((n + 1) * p)));
  const max = terme(mode);
  let somme = 0;
  for (let i = 0; i <= k; i++) somme += Math.exp(terme(i) - max);
  return Math.min(Math.exp(max) * somme, 1);
}

/**
 * Intervalle de Clopper-Pearson sur la proportion, pour k succes sur n tirages.
 * Les bornes degenerees sont EXACTES et voulues: k = 0 rend une borne basse de 0, k = n une borne haute
 * de 1. Zero succes n'exclut aucune proportion faible, et n succes sur n n'exclut pas la certitude.
 */
function intervalleProportion(k, n, alpha = 0.05) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) return [NaN, NaN];
  const q = alpha / 2;
  const bissect = (predicat, croissant) => {
    let bas = 0, haut = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (bas + haut) / 2;
      if (predicat(mid) === croissant) haut = mid; else bas = mid;
    }
    return croissant ? haut : bas;
  };
  /* P(X >= k | p) croit avec p: le predicat devient vrai a partir d'un seuil. */
  const basse = k === 0 ? 0 : bissect((p) => 1 - cdfBinomial(k - 1, n, p) >= q, true);
  /* P(X <= k | p) decroit avec p: le predicat est vrai jusqu'a un seuil. */
  const haute = k === n ? 1 : bissect((p) => cdfBinomial(k, n, p) >= q, false);
  return [basse, haute];
}

/**
 * La proportion et ses bornes, avec le contrôle d'independance rendu OBLIGATOIRE quand il s'applique.
 *
 * @param k            succes observes
 * @param n            observations
 * @param opts.effectif taille EFFECTIVE de l'echantillon (nombre de tirages reellement independants —
 *                      des financeurs, des operateurs, des jours). Si elle est fournie et inferieure a
 *                      `n`, l'intervalle est calcule dessus et non sur `n`.
 * @param opts.plancher en dessous de ce nombre de tirages effectifs, le TAUX est retenu et seul le
 *                      COMPTE est publie. Reprend la regle de MIN_RESOLUS.
 */
function proportionAvecBornes(k, n, opts = {}) {
  const { effectif = null, plancher = 0, alpha = 0.05 } = opts;
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) {
    return { taux: null, basse: null, haute: null, k, n, effectif, retenu: false,
      raison: 'entrees invalides — aucune proportion ne se calcule' };
  }
  /* ⛔ La taille effective, quand elle existe, REMPLACE n. Calculer l'intervalle sur n en signalant
   * l'effectif a cote serait pire que ne rien signaler: le lecteur retient l'intervalle etroit. */
  const nUtile = (Number.isInteger(effectif) && effectif > 0 && effectif < n) ? effectif : n;
  const kUtile = nUtile === n ? k : Math.min(Math.round(k * nUtile / n), nUtile);
  const groupe = nUtile < n;
  if (nUtile < plancher) {
    return { taux: null, basse: null, haute: null, k, n, effectif: nUtile, retenu: true,
      raison: nUtile + ' tirage(s) independant(s), sous les ' + plancher + ' requis — le compte reste '
        + 'lisible, le taux ne se publie pas' };
  }
  const [lo, hi] = intervalleProportion(kUtile, nUtile, alpha);
  return { taux: kUtile / nUtile, basse: lo, haute: hi, k, n, effectif: nUtile, retenu: false,
    raison: groupe ? 'calcule sur ' + nUtile + ' tirage(s) independant(s), pas sur les ' + n
      + ' observation(s) — elles sont groupees' : null };
}

module.exports = { cdfBinomial, intervalleProportion, proportionAvecBornes };
