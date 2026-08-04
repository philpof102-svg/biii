'use strict';
/**
 * prequential.js — grading a candidate rule the only way that proves anything: forward.
 * ====================================================================================
 * Every rule measured in this repository so far has been scored by replaying it over outcomes that were
 * already known. That answers "does this rule describe the past" — never "would this rule have called it".
 * Three rules died here for the difference, and the survivors have not been asked the harder question.
 *
 * The protocol, and each clause exists because skipping it produced a wrong answer once:
 *
 *   1. CHRONOLOGICAL WALK. A token is judged using only what was knowable strictly before it appeared.
 *   2. NO HAND-SET PARAMETER. A threshold chosen by looking at the outcomes it will be graded against has
 *      proven nothing. Thresholds are derived from prior data as quantiles, or the rule is labelled as
 *      hand-set and reported as such rather than quietly mixed in with the derived ones.
 *   3. UNRESOLVED OUTCOMES ARE EXCLUDED FROM RATES AND COUNTED SEPARATELY. A token that has not had time to
 *      answer is not evidence, in either direction.
 *   4. THE ORDER PROPERTY IS TESTED DIRECTLY. This is the clause that is easiest to believe you satisfied.
 *      A replay that peeks at the future produces exactly the same SHAPE of output, only better — so its
 *      correctness is invisible in the result and has to be asserted against the mechanism.
 *
 * ═══ WHAT "KNOWABLE" MEANS HERE, AND WHY IT IS STRICTER THAN IT LOOKS ═══
 *
 * It is not enough that a prior token EXISTS. Its outcome must have been settled at the moment of judging.
 * A token seen at 10:00 that rugs at 11:00 tells us nothing at 10:30. And a token that has not rugged is
 * only evidence of survival once it has outlived the maturity window — before that it is simply young.
 * So the knowledge set at time T holds:
 *
 *   · rugs whose `ruggedAt` is at or before T, and
 *   · live tokens first seen at least `maturityWindowHours` before T.
 *
 * Everything else is excluded. The window comes from lib/scorecard.js rather than being recomputed, because
 * two copies of that reasoning would drift and both would still print a number.
 *
 * ═══ WHAT THIS CANNOT REPAIR, STATED BEFORE ANY RESULT ═══
 *
 * A prequential walk removes look-ahead in the FEATURES. It cannot remove look-ahead in the CHOICE OF RULE.
 * Tonight's candidates were noticed because they separated on outcomes already seen; replaying them
 * chronologically leaves that selection untouched. For a feature that never changes — a contract's own code,
 * an address suffix — the prequential result is arithmetically identical to the in-sample one, and reporting
 * it as a validation would be a dressed-up restatement. Only announcing a rule and grading tokens that
 * arrive AFTERWARDS settles it, which is what `announce()` below is for.
 *
 * Pure: takes rows and a clock, returns a card. No disk, no network, no `Date.now()`.
 */

const { maturityWindow } = require('./scorecard');

const HOURS = 3600000;

/** A prediction is one of three things, and the third one is not a failure of nerve. */
const DANGER = 'danger';
const SAFE = 'safe';
const ABSTAIN = 'abstain';   // the feature could not be read — never silently folded into `safe`

const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);

/**
 * Was this token's outcome settled at instant `t`?
 * @returns 'rugged' | 'survived' | null  — null meaning "not yet answered", which is a state, not a no.
 */
function outcomeKnownAt(token, t, maturityH) {
  const seen = Date.parse(token.firstSeen);
  if (!Number.isFinite(seen) || seen >= t) return null;          // not yet visible at all
  if (token.outcome === 'rugged') {
    const died = Date.parse(token.ruggedAt);
    return Number.isFinite(died) && died <= t ? 'rugged' : null;
  }
  if (token.outcome === 'live') {
    if (maturityH == null) return null;                          // nothing can be called a survivor yet
    return t - seen >= maturityH * HOURS ? 'survived' : null;
  }
  return null;
}

/**
 * The candidate rules. Each declares whether its threshold is DERIVED from prior data or HAND-SET, because
 * the two do not carry the same weight and averaging them together would hide which is which.
 *
 * `predict(token, history)` sees only the knowledge set. It must never read `token.outcome`.
 */
const RULES = [
  {
    key: 'funder-derived',
    label: 'financeur >= quantile p75 du passe',
    derived: true,
    /* Le seuil est EXPOSE, pas seulement applique. Sans ca, une regle « derivee » dont le quantile
     * converge vers la valeur choisie a la main serait indiscernable d'une regle independante — et on
     * publierait comme non-biaisee une reformulation du seuil qu'on cherchait a controler. Le harnais
     * enregistre la trajectoire et l'imprime a cote du resultat. */
    threshold(hist) {
      const passes = hist.map((h) => h.siblingCount).filter((n) => typeof n === 'number').sort((a, b) => a - b);
      return passes.length < 20 ? null : quantile(passes, 0.75);   // trop peu d'histoire pour deriver
    },
    predict(t, hist) {
      // Trois etats, et celui du milieu compte: un compte jamais lu n'est pas un petit compte.
      if (typeof t.siblingCount !== 'number') return ABSTAIN;
      const seuil = this.threshold(hist);
      if (seuil == null) return ABSTAIN;
      return t.siblingCount >= seuil ? DANGER : SAFE;
    },
  },
  {
    /* ⛔ POURQUOI CETTE REGLE EXISTE : `funder-derived` a rendu un seuil CONSTANT — min 50, mediane 50,
     * max 50 sur 1859 tokens. 50 n'est pas une valeur du marche, c'est le PLAFOND DE PAGINATION de
     * l'explorateur, la borne exacte ou `siblingCountCensored` s'allume. Le quantile p75 etait sature
     * dessus, donc la regle « derivee » etait en fait « l'historique du financeur ne tenait pas sur une
     * page » : le drapeau de censure porte par un autre nom, presente comme un parametre libre.
     *
     * Une valeur censuree est un PLANCHER, pas une mesure. Deriver un quantile depuis des planchers,
     * c'est estimer une distribution depuis ses troncatures. On ne derive donc que sur les comptes dont
     * la lecture est explicitement COMPLETE.
     *
     * ⚠️ Et trois etats, encore: `siblingCountCensored` absent n'est pas `false`. 868 lignes portent le
     * drapeau pour 981 comptes — les 113 autres precedent la fonctionnalite et ne disent rien. Elles
     * sont exclues de la DERIVATION (on ignore leur qualite) sans etre exclues du JUGEMENT (leur compte
     * reste utilisable contre un seuil derive par d'autres). */
    key: 'funder-derived-uncensored',
    label: 'financeur >= p75 des comptes LUS EN ENTIER',
    derived: true,
    threshold(hist) {
      const complets = hist
        .filter((h) => typeof h.siblingCount === 'number' && h.siblingCountCensored === false)
        .map((h) => h.siblingCount)
        .sort((a, b) => a - b);
      return complets.length < 20 ? null : quantile(complets, 0.75);
    },
    predict(t, hist) {
      if (typeof t.siblingCount !== 'number') return ABSTAIN;
      const seuil = this.threshold(hist);
      if (seuil == null) return ABSTAIN;
      return t.siblingCount >= seuil ? DANGER : SAFE;
    },
  },
  {
    key: 'funder-20',
    label: 'financeur >= 20 freres (seuil CHOISI A LA MAIN)',
    derived: false,
    predict(t) {
      if (typeof t.siblingCount !== 'number') return ABSTAIN;
      return t.siblingCount >= 20 ? DANGER : SAFE;
    },
  },
  /* ═══ LES VERDICTS LIVRES, notes avec la MEME discipline que les candidats ═══
   *
   * `firstVerdict` est pose au premier regard, donc il ne regarde deja pas le futur — le rejeu
   * n'ajoute rien sur ce point et il faut le dire plutot que de laisser croire a une validation. Ce
   * qu'il ajoute, lui, est ce qui manquait a `replay-verdicts.js`: le taux de base calcule sur la
   * MEME population resolue (76,1 %, pas les 75,3 % globaux qui incluent les appels ouverts), les
   * non-resolus exclus des taux et comptes a part, et le taux du cote SUR publie a cote du cote
   * DANGER — une regle qui n'informe que dans un sens est une demi-regle. */
  {
    key: 'verdict-high-risk',
    label: 'verdict livre: high_risk',
    derived: false,
    static: true,
    predict: (t) => (t.firstVerdict === 'high_risk' ? DANGER : SAFE),
  },
  {
    key: 'verdict-caution',
    label: 'verdict livre: caution (tel quel)',
    derived: false,
    static: true,
    // `caution` se vend comme une bande PRUDENTE: le cote interessant est donc SAFE, pas DANGER.
    predict: (t) => (t.firstVerdict === 'caution' ? SAFE : DANGER),
  },
  {
    key: 'verdict-caution-sans-natifs',
    label: 'verdict livre: caution SANS les natifs B20',
    derived: false,
    static: true,
    /* La mesure du 04/08 a montre que `caution` empile deux regimes: 517 non-natifs a 48,4 % et 148
     * natifs B20 a 87,2 %. Cette variante retire les natifs du cote SUR au lieu de les y laisser
     * diluer la bande. Les natifs ne deviennent pas DANGER pour autant — ils sortent en ABSTENTION,
     * parce que les verser dans l'autre camp inventerait un verdict que le radar n'a jamais rendu. */
    predict(t) {
      const a = String(t.addr || '').toLowerCase();
      const natif = a.startsWith('0xb200') && a !== '0xb200fb5839afa4d7761981143617c5799f063b7f';
      if (t.firstVerdict === 'caution') return natif ? ABSTAIN : SAFE;
      return DANGER;
    },
  },
  {
    key: 'natif-b20',
    label: 'token natif B20 (trait STATIQUE)',
    derived: false,
    static: true,
    predict(t) {
      const a = String(t.addr || '').toLowerCase();
      if (!a) return ABSTAIN;
      // Le natif se lit par le code on-chain; faute de l'avoir en base pour l'historique, on rejoue par
      // l'adresse, correspondance verifiee 1:1 sur les 156 par probe-b200-code.js.
      if (!a.startsWith('0xb200')) return SAFE;
      return a === '0xb200fb5839afa4d7761981143617c5799f063b7f' ? SAFE : DANGER;
    },
  },
  {
    key: 'suffixe-01',
    label: 'natif B20 dont l adresse finit par 01 (trait STATIQUE)',
    derived: false,
    static: true,
    predict(t) {
      const a = String(t.addr || '').toLowerCase();
      if (!a.startsWith('0xb200')) return ABSTAIN;   // la regle ne parle que des natifs
      return a.endsWith('01') ? SAFE : DANGER;
    },
  },
];

/**
 * @param all      token records
 * @param now      ISO string, injected
 * @param opts.rules  override the rule list (tests use this)
 */
function runPrequential(all, now, opts = {}) {
  const rows = (Array.isArray(all) ? all : Object.values(all || {}))
    .filter((t) => Number.isFinite(Date.parse(t.firstSeen)))
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));

  const { maturityH } = maturityWindow(rows);
  const rules = opts.rules || RULES;
  const T = Date.parse(now);

  const cards = new Map(rules.map((r) => [r.key, {
    key: r.key, label: r.label, derived: !!r.derived, isStatic: !!r.static,
    dangerRugged: 0, dangerSurvived: 0, dangerOpen: 0,
    safeRugged: 0, safeSurvived: 0, safeOpen: 0,
    abstained: 0, tooEarly: 0,
  }]));

  /* THE ORDER PROPERTY, RECORDED AS IT RUNS rather than asserted afterwards.
   * `maxKnownSeenAt` is the latest firstSeen that ever entered a knowledge set, alongside the firstSeen of
   * the token being judged at that moment. If the walk ever leaks the future, this pair inverts. */
  let breaches = 0;
  let firstOfFunderWithPriorSiblings = 0;
  const funderSeen = new Set();

  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const at = Date.parse(t.firstSeen);

    // Knowledge set: strictly earlier rows whose outcome had already settled by `at`.
    const hist = [];
    for (let j = 0; j < i; j++) {
      const known = outcomeKnownAt(rows[j], at, maturityH);
      if (!known) continue;
      if (Date.parse(rows[j].firstSeen) >= at) breaches++;     // must be impossible; counted, not assumed
      /* Une projection etroite, pas une copie complete: la marche est en O(n^2) et etaler 1859 objets
       * 1,7 million de fois coute plus cher que tout le reste du calcul. Elle porte aussi le nom du
       * champ d'issue en `knownOutcome` — jamais `outcome` — pour qu'une regle qui tenterait de lire
       * l'issue brute d'un voisin trouve `undefined` au lieu de la verite. */
      hist.push({ siblingCount: rows[j].siblingCount, funder: rows[j].funder,
        siblingCountCensored: rows[j].siblingCountCensored,
        addr: rows[j].addr, firstLiq: rows[j].firstLiq, knownOutcome: known });
    }

    // Clause 4, in its concrete form: the FIRST token of a funder must see no sibling of that funder.
    if (t.funder) {
      const dejaVu = funderSeen.has(t.funder);
      if (!dejaVu && hist.some((h) => h.funder === t.funder)) firstOfFunderWithPriorSiblings++;
      funderSeen.add(t.funder);
    }

    const mine = outcomeKnownAt(t, T, maturityH);   // is MY outcome settled as of `now`?
    for (const r of rules) {
      const c = cards.get(r.key);
      if (typeof r.threshold === 'function') {
        const s = r.threshold(hist);
        if (s != null) (c.thresholds || (c.thresholds = [])).push(s);
      }
      const p = r.predict(t, hist);
      if (p === ABSTAIN) { c.abstained++; continue; }
      if (!mine) { p === DANGER ? c.dangerOpen++ : c.safeOpen++; continue; }
      if (p === DANGER) mine === 'rugged' ? c.dangerRugged++ : c.dangerSurvived++;
      else mine === 'rugged' ? c.safeRugged++ : c.safeSurvived++;
    }
  }

  // Base rate over the SAME resolved population the rules are graded on — comparing a rule's hit rate to a
  // base rate computed over a different denominator is how a rule looks good for free.
  let resolvedRugged = 0, resolvedTotal = 0, unresolved = 0;
  for (const t of rows) {
    const k = outcomeKnownAt(t, T, maturityH);
    if (!k) { unresolved++; continue; }
    resolvedTotal++; if (k === 'rugged') resolvedRugged++;
  }

  return {
    updatedAt: now,
    maturityWindowHours: maturityH,
    tokensWalked: rows.length,
    resolvedTotal, resolvedRugged, unresolved,
    baseRate: resolvedTotal ? +(resolvedRugged / resolvedTotal).toFixed(4) : null,
    orderBreaches: breaches,
    firstOfFunderWithPriorSiblings,
    cards: [...cards.values()].map((c) => {
      const dangerResolved = c.dangerRugged + c.dangerSurvived;
      const safeResolved = c.safeRugged + c.safeSurvived;
      const th = (c.thresholds || []).slice().sort((a, b) => a - b);
      return {
        ...c,
        thresholds: undefined,        // la trajectoire complete ne sert a rien; ses bornes, si
        thresholdMin: th.length ? th[0] : null,
        thresholdMedian: th.length ? th[Math.floor(th.length / 2)] : null,
        thresholdMax: th.length ? th[th.length - 1] : null,
        dangerResolved, safeResolved,
        precision: dangerResolved ? +(c.dangerRugged / dangerResolved).toFixed(4) : null,
        safeRugRate: safeResolved ? +(c.safeRugged / safeResolved).toFixed(4) : null,
        recall: resolvedRugged ? +(c.dangerRugged / resolvedRugged).toFixed(4) : null,
        markedShare: resolvedTotal ? +(dangerResolved / resolvedTotal).toFixed(4) : null,
      };
    }),
    note: 'precision = share of DANGER calls that rugged, over resolved calls only. safeRugRate = share of '
      + 'SAFE calls that rugged, published because a rule informative in one direction only is half a rule. '
      + 'recall against markedShare is the pair that says whether a rule has reach: a recall barely above the '
      + 'marked share is a precise rule with no coverage. Abstentions are excluded from every rate and '
      + 'counted, because a feature that could not be read is not a safe verdict. Rules flagged isStatic have '
      + 'a feature that never changes, so their prequential figure is arithmetically the in-sample one — the '
      + 'walk removes no bias for them and they are NOT validated by appearing here.',
  };
}

module.exports = { runPrequential, outcomeKnownAt, RULES, DANGER, SAFE, ABSTAIN };
