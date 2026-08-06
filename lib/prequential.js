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
 * MIN_RESOLUS — le plancher d'appels resolus sous lequel aucun TAUX ne se publie.
 *
 * Ce n'est pas un seuil nouveau: le depot le pose deja trois fois. `maturityWindow` refuse de deriver
 * un quantile sous 20 valeurs (deux fois), et `gradeAnnounced` refuse de conclure sous 20 appels. Ce
 * qui manquait, c'est de l'appliquer AU DENOMINATEUR DE CHAQUE TAUX plutot qu'a une somme.
 *
 * ⛔ CE QUE LE BUG VALAIT, MESURE LE 2026-08-06 AVANT CORRECTION:
 *   · bulletin annonce — `gradeAnnounced` teste `dangerResolved + safeResolved < 20`. Une carte a
 *     19 appels danger et 2 appels sur passe la porte avec 21, puis publie un taux SUR calcule sur
 *     DEUX tokens, accompagne d'un ecart de +51,6 pts, presente comme les autres. Trois taux etaient
 *     dans ce cas: n=2, n=4, n=6. Les cartes retenues en `trop-peu` publiaient leurs taux malgre tout,
 *     dont le pari phare `simulation-et-financeur-lu` a « 0,0 % » sur UN SEUL token.
 *   · marche complete — `runPrequential` n'a AUCUN plancher. `funder-derived-uncensored` publiait
 *     « 100 % des appels SUR ont rugge » sur n=1, et `suffixe-01` un taux sur n=19.
 *
 * ⚠️ LA PREUVE BRUTE N'EST JAMAIS RETIREE. `dangerRugged`, `safeRugged`, `dangerResolved`,
 * `safeResolved` restent tous publies: qui veut le ratio peut le calculer. Ce qui est refuse, c'est de
 * le presenter comme une MESURE. Retirer le taux et garder les comptes n'est pas une perte
 * d'information, c'est refuser de blanchir un n=1 en pourcentage.
 */
const MIN_RESOLUS = 20;

/**
 * instrumentTemoin — quel LECTEUR a produit le `siblingCount` de cette ligne ?
 *
 * ⛔ POURQUOI CE TEMOIN EXISTE. `siblingCount` a porte deux instruments sous un seul nom de champ:
 *   · jusqu'au 2026-08-04 — les destinataires DISTINCTS d'une page (~50 transactions). Une DENSITE,
 *     saturee a 50, qui separe une rafale d'usine d'un portefeuille chaud vivant depuis longtemps.
 *   · depuis — le meme compte sur six pages (~300 transactions). Un TOTAL A VIE, qui confond les deux.
 *
 * Mesure du 2026-08-06 sur les tokens dont le vrai compte franchit 20: franchi des la premiere page,
 * 97,1 % de rugs sur 106 tokens; franchi seulement en profondeur, 3,7 % sur 27. Quatre-vingt-treize
 * points d'ecart entre deux groupes que le compte pagine declare identiques. Lire plus profond ne
 * repare donc pas cette variable, cela la detruit.
 *
 * ⚠️ ET LE PARI GELE EST DEJA NOTE SUR LE MELANGE. Toujours le 2026-08-06: sur les 30 tokens comptes
 * apparus depuis l'annonce de `simulation-et-financeur-lu`, 20 (66,7 %) viennent du lecteur pagine,
 * dont 12 du cote SUR. La regle n'a pas bouge d'une lettre — c'est la variable qui a change de sens
 * sous elle, ce qu'un pari note vers l'avant ne peut pas absorber en silence.
 *
 * Le radar persiste `siblingPagesRead` PRECISEMENT comme ce temoin (voir son commentaire dans
 * token-radar.js). Il n'etait lu par personne au moment de noter.
 *
 * ⛔ CE QUE CE TEMOIN NE FAIT PAS: il ne corrige rien et n'exclut personne. Decider qu'un token mesure
 * autrement ne doit PAS entrer au bareme est un arbitrage produit; on le DIT, on ne le tranche pas ici.
 */
function instrumentTemoin(t) {
  if (!t || typeof t.siblingCount !== 'number') return null;      // la variable n'a pas servi ici
  return t.siblingPagesRead === undefined ? 'sibling:une-page' : 'sibling:pagine';
}

/**
 * tauxPublie — un taux, son denominateur, et le droit de le lire. TROIS etats, jamais deux.
 *
 * ⛔ `n ? x / n : null` n'en distingue que deux, et fait tomber « mesure trop mince » dans le meme sac
 * que « rien a mesurer ». Or les deux se lisent differemment: un `null` sur zero appel dit qu'on n'a
 * pas encore regarde; un taux sur un appel dit qu'on a regarde et conclu. C'est le second qui ment.
 *
 * @returns {{rate: number|null, n: number, withheld: boolean, reason: string|null}}
 */
function tauxPublie(numerateur, n) {
  if (!n) return { rate: null, n: 0, withheld: false, reason: 'aucun appel resolu — rien a mesurer' };
  if (n < MIN_RESOLUS) {
    return { rate: null, n, withheld: true,
      reason: n + ' appel(s) resolu(s), sous les ' + MIN_RESOLUS + ' requis — le compte reste lisible, '
        + 'le taux ne se publie pas' };
  }
  return { rate: +(numerateur / n).toFixed(4), n, withheld: false, reason: null };
}

/**
 * Coupe une serie en quartiles, et DIT quand la coupe ne separe rien.
 * ---------------------------------------------------------------------------------------------
 * ⛔ POURQUOI CE HELPER EXISTE. `replay-basis-fields.js` gardait sa coupe par `q1 === q3`, en egalite
 * EXACTE. Sur `lpLockedPct` il a lu q1=0 et q3=3.1622e-14 — deux nombres differents, le meme zero en
 * substance — donc il n'a rien dit, et un ecart entre seaux extremes a ete publie sur un decoupage
 * qui assignait ZERO token a son deuxieme seau.
 *
 * ⚠️ ET LE REMPLACANT EVIDENT EST FAUX AUSSI, mesure avant d'etre ecrit. Un critere sur l'ecart
 * RELATIF (q3-q1 rapporte a l'etendue) donne 3,2e-14 pour `lpLockedPct` mais 1,1e-6 pour `holders`,
 * dont la coupe est pourtant saine (169/160/184/141). Le seuil devrait se poser dans un trou de huit
 * decades, et il serait choisi a la main — exactement le defaut qu'on repare. Un critere sur le
 * nombre de valeurs DISTINCTES echoue pareil: `unreadable` n'en a que 8 pour 1638 lignes et coupe
 * proprement.
 *
 * Le discriminant n'est donc aucune forme des bornes, c'est le RESULTAT de la coupe: un seau VIDE.
 * Il apparait exactement quand deux bornes coincident, et il se compte au lieu de s'estimer. Sur les
 * quatre champs du jeu, `lpLockedPct` est le seul a en avoir un — et c'est le seul qu'il fallait
 * attraper.
 *
 * Ce que ce helper peut prouver: que le decoupage publie a bien reparti la population.
 * Ce qu'il ne peut PAS prouver: que les seaux non vides separent quoi que ce soit d'interessant.
 *
 * @returns {{n:number, q1:*, q2:*, q3:*, seaux:number[]|null, degeneree:string|null}}
 *   `degeneree` est une RAISON lisible, ou null. Jamais un booleen: un appelant qui ne sait pas
 *   pourquoi la coupe est refusee finit par la publier quand meme.
 */
function coupeQuartiles(valeurs) {
  const v = (Array.isArray(valeurs) ? valeurs : [])
    .filter((x) => typeof x === 'number' && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length < 4) {
    return { n: v.length, q1: null, q2: null, q3: null, seaux: null,
      degeneree: `${v.length} valeur(s) lue(s) — il en faut au moins 4 pour esperer quatre seaux` };
  }
  const q1 = quantile(v, 0.25), q2 = quantile(v, 0.5), q3 = quantile(v, 0.75);
  const tests = [(x) => x <= q1, (x) => x > q1 && x <= q2, (x) => x > q2 && x <= q3, (x) => x > q3];
  const seaux = tests.map((t) => v.filter(t).length);
  const vides = seaux.map((n, i) => (n === 0 ? i + 1 : 0)).filter(Boolean);
  const degeneree = vides.length
    ? `seau(x) ${vides.join(', ')} sur 4 VIDE(S) — deux bornes coincident (q1=${q1} · median=${q2} · q3=${q3}), `
      + 'la distribution est ecrasee et ce decoupage ne peut rien separer'
    : null;
  return { n: v.length, q1, q2, q3, seaux, degeneree };
}

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
    /* ⛔ IL NE SUFFIT PAS QUE LE TOKEN AIT VIEILLI: IL FAUT L'AVOIR VU VIVANT A CET AGE.
     * Cette ligne testait `t - seen >= maturityH` — l'age depuis la PREMIERE vue — et rien d'autre.
     * Un token apercu il y a huit jours devenait donc « survivant » meme si plus personne ne l'avait
     * regarde depuis sept. Or token-radar.js:295 fait `if (liq == null) continue;` sans jamais
     * regrader: un pool entierement retire — le rug le plus complet qui soit — gele sa ligne et
     * `lastSeen` cesse d'avancer. Mesure du 2026-08-05: 416 des 452 tokens 'live' n'avaient pas ete
     * lus depuis 24 h, 229 depuis une semaine, et les 416 comptaient comme survivants.
     *
     * C'est la clause 3 de ce fichier appliquee a moitie: elle ecarte le token trop JEUNE pour avoir
     * repondu, jamais celui qu'on a CESSE D'ECOUTER. Les deux sont pourtant la meme chose — une issue
     * non tranchee, qui n'est une preuve dans aucun sens.
     *
     * ⚠️ ET LA BORNE EST `min(lastSeen, t)`, PAS `lastSeen`. Prendre `lastSeen` seul lirait le futur:
     * une observation posterieure a `t` n'etait pas connue a `t`, et la marche chronologique perdrait
     * exactement la propriete que la clause 4 impose de tester. Avec le minimum, l'assertion devient:
     * « une observation a eu lieu a un age >= maturite, ET au plus tard a `t` ». */
    const vu = Date.parse(token.lastSeen);
    if (!Number.isFinite(vu)) return null;                       // jamais reobserve: rien a affirmer
    const observeJusqua = Math.min(vu, t);
    return observeJusqua - seen >= maturityH * HOURS ? 'survived' : null;
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
     * ⚠️ 2026-08-04 — ET LIRE PLUS PROFOND NE SUFFIT PAS. `lib/feeder.js` suit desormais la pagination
     * jusqu'a six pages au lieu d'une, ce qui etait la reparation evidente. Les 206 financeurs de la base
     * ont ete re-parcourus avec le nouvel instrument pour verifier plutot que supposer:
     *
     *     p75 sur TOUS les comptes            50  ->  300     TOUJOURS UNE CONSTANTE, toujours la borne
     *     p75 sur les comptes LUS EN ENTIER    1  ->    3     (p90: 2 -> 18)
     *
     * Le plafond a ete DEPLACE, pas retire. La cause n'est pas la profondeur de lecture mais la
     * concentration: 25 financeurs portent 800 des 981 tokens, et ce sont exactement ceux qui n'ont
     * pas de fin — des portefeuilles chauds dont le compte de destinataires croit lineairement avec ce
     * qu'on lit (27 -> 307 en douze pages). Un quantile sur cette variable mesure notre budget de lecture,
     * pas le marche, et aucune borne finie ne change cela.
     *
     * Conclusion a garder: le seuil de 20 reste NON DERIVABLE de cette variable. `funder-20` ci-dessous
     * garde donc son etiquette « choisi a la main ». Ce qui a ete repare est la COLLECTE — 144 tokens
     * portaient un compte censure sous 20, c'est-a-dire des appels « SAFE » emis sur un plancher — pas
     * la possibilite de deriver un seuil.
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
  /* ═══ L'ETAT DU PROPRIETAIRE — le separateur le plus fort trouve dans ce jeu ═══
   *
   * Mesure du 2026-08-05 sur les 1859 tokens, tous resolus (fenetre de maturite 4 h, jeu de 10 jours):
   *
   *     renounced    54 ·   8 rug ·  46 surv ·  14,8 %   −60,4 pts
   *     unknown     999 · 908 rug ·  91 surv ·  90,9 %   +15,6 pts
   *
   * Soixante-seize points d'ecart — devant le financeur industriel (46) et devant `caution` sans les
   * natifs B20 (37). Et le mecanisme tient tout seul: un proprietaire qui a renonce ne peut plus tirer
   * les pouvoirs de propriete, c'est la these fondatrice de ce depot mesuree pour la premiere fois.
   *
   * ⚠️ `unknown` est l'etat le PLUS predictif, et c'est inconfortable: c'est celui ou l'on n'a RIEN lu.
   * La doctrine interdit d'accuser sur sa propre incompletude, et elle reste juste — on peut publier
   * « les tokens dont on ne lit pas le proprietaire ruggent a 90,9 % » sans jamais dire « CE token va
   * rugger ». Le premier est une statistique de population, le second une affirmation sur un actif. */
  {
    key: 'owner-renounced',
    label: 'proprietaire RENONCE (le cote sur)',
    derived: false,
    static: true,
    predict(t) {
      const b = t.basisAtFirstSight;
      if (!b || typeof b !== 'object' || b.ownerState == null) return ABSTAIN;   // jamais lu ≠ pas renonce
      return b.ownerState === 'renounced' ? SAFE : DANGER;
    },
  },
  {
    key: 'owner-unknown',
    label: 'proprietaire NON LU (le cote danger)',
    derived: false,
    static: true,
    predict(t) {
      const b = t.basisAtFirstSight;
      if (!b || typeof b !== 'object' || b.ownerState == null) return ABSTAIN;
      return b.ownerState === 'unknown' ? DANGER : SAFE;
    },
  },
  /* ═══ DEUX LECTURES POSITIVES — le seul signal de la nuit qui n'est pas une absence ═══
   *
   * ⛔ CORRECTION DU 2026-08-06 — CE QUI SUIT ETAIT FAUX ET EST GARDE POUR QU'ON SACHE QUOI RELIRE.
   * Ce commentaire affirmait que « `unreadable === 3` est la SIGNATURE exacte du chemin simulation ».
   * Ce n'en est pas une signature: c'est une LONGUEUR. `token-radar.js:495` stocke
   * `v.unknowns.length` et jette la liste, alors que `rugsignals.js` en connaissait les noms.
   *
   * Le chemin simulation declare bien `unknowns: ['owner', 'LP lock status', 'holder distribution']`,
   * donc 3. Mais le chemin INDEX pousse dans `unknowns` sur SIX conditions independantes — statut
   * honeypot, taxe de vente, owner, verrou LP, distribution, compte de detenteurs — et n'importe
   * lesquelles trois d'entre elles donnent aussi 3. Le seau est donc une UNION.
   *
   * Mesure sur les 319 tokens a `unreadable === 3`, discrimines par `ownerState` (absent = chemin
   * simulation, present = chemin index):
   *
   *     chemin SIMULATION (ownerState absent)   214 tok ·  67/173 · 38,7 %
   *     chemin INDEX · owner 'unknown'           65 tok ·  54/63  · 85,7 %
   *     chemin INDEX · owner 'live'              24 tok ·  14/21  · 66,7 %
   *     chemin INDEX · owner 'renounced'         16 tok ·   0/11  ·  0,0 %
   *
   * Un tiers du seau (105 sur 319) n'est pas le chemin revendique, et l'ecart entre les deux plus gros
   * sous-groupes atteint 47 points. `test/unreadable-count-is-not-a-signature.test.js` montre par le
   * PRODUCTEUR que ce melange est structurel et non accidentel.
   *
   * ⚠️ LA REGLE N'EST PAS TOUCHEE — elle est gelee et notee vers l'avant, et `ownerState` est deja
   * stocke, donc separer les deux chemins serait une regle NOUVELLE a annoncer, pas une reecriture de
   * celle-ci. Ce qui est corrige ici est l'AFFIRMATION, pas le pari.
   *
   * Ce que trois inconnus voulait dire, et qui reste vrai du seul chemin simulation: la simulation de
   * vente a REPONDU, avec un verdict honeypot — une vente passe, demontre. Quatre signifie qu'elle a rendu des taxes SANS
   * verdict, et ce quatrieme seau est domine par le financeur industriel (287/405), dont il n'est que
   * le nom deguise: net de l'usine il ne vaut plus que +3,2 pts. Tue.
   *
   * Combine a un financeur LU et sous le seuil industriel, mesure du 2026-08-05 sur 1859 tokens tous
   * resolus:
   *
   *     unreadable=3 · financeur LU et < 20     103 ·   1 rug · 102 surv ·  1,0 %   −74,3 pts
   *     unreadable=3 · financeur NON LU          95 ·  32 rug ·  63 surv · 33,7 %   −41,6
   *     unreadable=3 · financeur LU et >= 20    106 ·  99 rug ·   7 surv · 93,4 %   +18,1
   *
   * ⛔ LA SEPARATION LU/NON-LU EST LE RESULTAT, PAS UN DETAIL. Les confondre — l'erreur exacte qui a
   * tue `cleanBand` — donne 16,7 %, dix-sept fois pire, en melangeant un groupe prouve propre avec un
   * groupe jamais mesure. Un compte de freres ABSENT n'est pas un petit compte.
   *
   * ⚠️ CONTROLE DE SURVIVANCE, parce que « survecu » est borne par notre fenetre d'observation: sur le
   * sous-groupe encore observe dans les 24 h precedant l'arret du radar, 0 rug sur 40. Et perdre un
   * token de vue n'est pas un rug cache — sur toute la base, les perdus de vue ruggent PLUS (78,0 %)
   * que les bien suivis (55,7 %), donc la detection de chute les attrape.
   *
   * Ce qui distingue cette regle de tout le reste: ses deux conditions sont des lectures POSITIVES.
   * Pas « on n'a rien vu de mauvais » mais « on a regarde deux fois, et les deux ont repondu ». */
  {
    key: 'simulation-et-financeur-lu',
    label: 'simulation REPONDUE + financeur LU sous le seuil industriel',
    derived: false,
    static: true,
    predict(t) {
      const b = t.basisAtFirstSight;
      // Les deux lectures doivent avoir EU LIEU. Sans elles la regle ne parle pas — elle s'abstient,
      // elle ne rassure pas.
      if (!b || typeof b !== 'object' || typeof b.unreadable !== 'number') return ABSTAIN;
      if (typeof t.siblingCount !== 'number') return ABSTAIN;
      return b.unreadable === 3 && t.siblingCount < 20 ? SAFE : DANGER;
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
      /* ⛔ UN SEUIL DERIVE QUI NE BOUGE JAMAIS EST, ARITHMETIQUEMENT, UN SEUIL CHOISI A LA MAIN.
       * La clause 2 du protocole, en haut de ce fichier, exige qu'un seuil pose a la main soit ETIQUETE
       * comme tel « plutot que discretement melange aux derives ». Le badge `derived` affirme le
       * contraire, et rien ne verifiait qu'il soit merite.
       *
       * Mesure du 2026-08-06: les DEUX regles derivees du jeu ont un seuil constant sur toute la marche.
       *   · funder-derived              min = median = max = 50
       *   · funder-derived-uncensored   min = median = max =  1
       * Et les deux constantes sont des artefacts de l'instrument, pas des traits du monde: 50 est la
       * taille d'une page d'explorateur (la distribution y est saturee), et 1 vient de ce qu'une lecture
       * ne se termine que si le financeur est assez petit pour tenir dans le balayage — 144 des 161
       * lectures completes valent exactement 1.
       *
       * ⚠️ `coupeQuartiles` savait deja dire tout cela: il detecte une distribution ecrasee et il est
       * teste sur une constante pure. Il n'etait appele que par un script de replay ponctuel, jamais par
       * la marche qui decerne le badge. Le detecteur correct existait a deux champs de distance.
       *
       * ⛔ On ne calcule PAS ceci pour une regle a seuil pose a la main: elle ne revendique rien, donc
       * il n'y a rien a dementir. Et un seuil ne se juge pas sur moins de quatre lectures. */
      const coupe = (c.derived && th.length >= 4) ? coupeQuartiles(th) : null;
      const p = tauxPublie(c.dangerRugged, dangerResolved);
      const s = tauxPublie(c.safeRugged, safeResolved);
      const rc = tauxPublie(c.dangerRugged, resolvedRugged);
      const ms = tauxPublie(dangerResolved, resolvedTotal);
      return {
        ...c,
        thresholds: undefined,        // la trajectoire complete ne sert a rien; ses bornes, si
        /* Le badge et son dementi voyagent ENSEMBLE. `derived: true` reste tel quel — il decrit le
         * mecanisme de la regle — mais `thresholdFige` dit si ce mecanisme a produit quoi que ce soit. */
        thresholdFige: coupe ? coupe.degeneree : null,
        thresholdMin: th.length ? th[0] : null,
        thresholdMedian: th.length ? th[Math.floor(th.length / 2)] : null,
        thresholdMax: th.length ? th[th.length - 1] : null,
        dangerResolved, safeResolved,
        /* Chaque taux passe par le MEME plancher, applique a SON PROPRE denominateur. Avant le
         * 2026-08-06 il n'y en avait aucun ici, et `funder-derived-uncensored` publiait « 100 % des
         * appels SUR ont rugge » sur un seul token. */
        precision: p.rate, safeRugRate: s.rate, recall: rc.rate, markedShare: ms.rate,
        /* La BORNE voyage avec le chiffre: un taux retenu se lit avec la raison de son retrait, pas
         * comme un `n/a` muet qu'on prendrait pour « pas encore calcule ». */
        tropMince: [
          p.withheld ? 'precision: ' + p.reason : null,
          s.withheld ? 'safeRugRate: ' + s.reason : null,
          rc.withheld ? 'recall: ' + rc.reason : null,
          ms.withheld ? 'markedShare: ' + ms.reason : null,
        ].filter(Boolean),
      };
    }),
    note: 'precision = share of DANGER calls that rugged, over resolved calls only. safeRugRate = share of '
      + 'SAFE calls that rugged, published because a rule informative in one direction only is half a rule. '
      + 'recall against markedShare is the pair that says whether a rule has reach: a recall barely above the '
      + 'marked share is a precise rule with no coverage. Abstentions are excluded from every rate and '
      + 'counted, because a feature that could not be read is not a safe verdict. Rules flagged isStatic have '
      + 'a feature that never changes, so their prequential figure is arithmetically the in-sample one — the '
      + 'walk removes no bias for them and they are NOT validated by appearing here. The same warning now '
      + 'covers a DERIVED rule whose threshold never moved: `thresholdFige` names it. Clause 2 asks that a '
      + 'hand-set threshold be labelled rather than quietly mixed in with the derived ones, and a constant '
      + 'derived threshold is a hand-set one wearing the wrong badge — worse, because nobody chose it and '
      + 'so nobody can defend it. Both derived rules were in that state on 2026-08-06, at 50 and at 1, and '
      + 'both constants are artefacts of the reader rather than traits of the world.',
  };
}

/**
 * gradeAnnounced — noter les regles PARIEES, sur les seuls tokens apparus APRES leur annonce.
 *
 * C'est la seule fonction de ce fichier qui puisse produire une preuve plutot qu'une description. Le
 * reste mesure le passe; celle-ci mesure ce qui est arrive depuis qu'on a dit ce qu'on attendait.
 *
 * ⚠️ SON PREMIER BULLETIN DIRA « 0 TOKEN NOTE », ET C'EST NORMAL. Une frontiere posee apres la
 * derniere observation ne peut rien noter le jour meme. Un zero ici n'est ni un succes ni un echec —
 * c'est l'absence de donnees, et `verdict: 'pas-encore-notable'` le dit au lieu de laisser des taux
 * `null` se lire comme des zeros.
 */
function gradeAnnounced(all, now, opts = {}) {
  const rows = (Array.isArray(all) ? all : Object.values(all || {}))
    .filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
  const { maturityH } = maturityWindow(rows);
  const rules = new Map((opts.rules || RULES).map((r) => [r.key, r]));
  const annonces = opts.announced || require('./announced-rules').ANNOUNCED;
  const T = Date.parse(now);

  const cartes = annonces.map((a) => {
    const regle = rules.get(a.key);
    /* Une annonce qui ne correspond a AUCUNE regle vivante est une panne du dispositif, pas un
     * resultat vide: on la nomme au lieu de la sauter en silence. */
    if (!regle) {
      return { key: a.key, label: a.label, announcedAt: a.announcedAt, verdict: 'regle-introuvable',
        note: 'aucune regle vivante ne porte cette cle — l annonce ne peut pas etre notee, et ce n est pas un zero' };
    }

    const debut = Date.parse(a.announcedAt);
    const eligibles = rows.filter((t) => Date.parse(t.firstSeen) > debut);

    let dangerRugged = 0, dangerSurvived = 0, dangerOpen = 0;
    let safeRugged = 0, safeSurvived = 0, safeOpen = 0, abstained = 0;
    const instruments = {};   // temoin -> nombre d'appels NOTES produits par ce lecteur
    for (const t of eligibles) {
      // L'historique reste restreint aux tokens ANTERIEURS a celui qu'on juge, comme dans la marche.
      const hist = rows.filter((h) => Date.parse(h.firstSeen) < Date.parse(t.firstSeen)
        && outcomeKnownAt(h, Date.parse(t.firstSeen), maturityH));
      const p = regle.predict(t, hist);
      if (p === ABSTAIN) { abstained++; continue; }
      const mine = outcomeKnownAt(t, T, maturityH);
      if (!mine) { p === DANGER ? dangerOpen++ : safeOpen++; continue; }
      /* On ne compte le temoin que sur les appels REELLEMENT NOTES. Une abstention et un appel ouvert
       * n'entrent dans aucun taux, donc leur instrument ne salit aucun chiffre publie. */
      const temoin = instrumentTemoin(t);
      if (temoin) instruments[temoin] = (instruments[temoin] || 0) + 1;
      if (p === DANGER) mine === 'rugged' ? dangerRugged++ : dangerSurvived++;
      else mine === 'rugged' ? safeRugged++ : safeSurvived++;
    }

    const dangerResolved = dangerRugged + dangerSurvived;
    const safeResolved = safeRugged + safeSurvived;
    const total = dangerResolved + safeResolved;
    /* ⚠️ UN PARI GELE NE VAUT QUE SI SA VARIABLE GARDE SON SENS. Le texte de la regle ne peut pas etre
     * reecrit — c'est verifie par test — mais rien n'empechait le LECTEUR de changer sous elle, et
     * c'est arrive: deux instruments de `siblingCount` cohabitent depuis le 2026-08-04. Quand une carte
     * est notee sur plusieurs, on le dit A COTE du chiffre au lieu de laisser lire une serie homogene. */
    const lecteurs = Object.keys(instruments);
    const base = { key: a.key, label: a.label, announcedAt: a.announcedAt, predicted: a.predicted,
      eligible: eligibles.length, dangerResolved, safeResolved, dangerOpen, safeOpen, abstained,
      instruments, instrumentsMelanges: lecteurs.length > 1 };
    const melange = lecteurs.length > 1
      ? ' ⛔ NOTE SUR PLUSIEURS INSTRUMENTS — ' + lecteurs.map((k) => k + ': ' + instruments[k]).join(', ')
        + '. La regle est intacte, c est la variable qui a change de lecteur sous elle; comparer ces '
        + 'appels revient a melanger deux mesures sous un seul nom.'
      : '';

    /* Trois verdicts, et les deux premiers ne sont PAS des echecs. Un seuil de 20 appels resolus est
     * pose ici parce qu'en dessous le bruit domine: dire « la regle tient » sur cinq cas serait
     * refaire, vers l'avant, exactement l'erreur qu'on essaie de corriger. */
    if (!eligibles.length) {
      return { ...base, verdict: 'pas-encore-notable',
        note: 'aucun token apparu depuis l annonce — ni confirme ni infirme, simplement pas encore mesurable' };
    }
    /* ⛔ LE PLANCHER S'APPLIQUE A CHAQUE COTE, PAS A LEUR SOMME — et il s'applique dans les DEUX
     * branches, parce que la branche `trop-peu` publiait ses taux malgre son propre verdict.
     *
     * Le test `total < 20` ci-dessous juge la CARTE; il reste tel quel. Ce qu'il ne pouvait pas juger,
     * c'est un cote: 19 appels danger et 2 appels sur font 21, la carte passait, et le taux SUR sortait
     * sur DEUX tokens avec un ecart en points a cote. Mesure du 2026-08-06 avant correction: trois
     * ecarts publies sur n=2, n=4 et n=6, et le pari phare a « 0,0 % » sur n=1. */
    const d = tauxPublie(dangerRugged, dangerResolved);
    const sf = tauxPublie(safeRugged, safeResolved);
    const observed = { dangerRate: d.rate, safeRate: sf.rate };

    /* ⛔ L'ECART CONTRE LE PARI N'EST PAS UN ECART CONTRE LE HASARD, et la carte ne publiait que le
     * premier. `announced-rules.test.js` exige deja que `basis.baseRate` voyage avec chaque pari —
     * « un pourcentage seul ne vaut rien ». Le pari porte donc la base du jour ou il a ete fait. Ce
     * qu'aucune carte ne disait, c'est la base de la population qu'elle vient DE JUGER.
     *
     * Mesure du 2026-08-06: base de la base entiere 83,3 %, base de la population eligible 97,2 % —
     * 13,9 points d'ecart. Les paris ont ete faits sur un monde a 83 % et sont notes sur un monde a
     * 97 %. Consequence lue sur le bulletin du jour:
     *   · `verdict-caution-sans-natifs` affichait « danger 96,3 %, ecart +10,9 pts » — soit, contre la
     *     population reellement jugee, −0,9 pt. La regle ne battait pas le hasard.
     *   · `natif-b20` affichait « sur 96,5 %, ecart +22,1 pts CONTRE le pari ». Contre la base: −0,7.
     *     Il n'etait pas infirme, il etait AU hasard; l'ecart n'etait qu'un glissement de population.
     *
     * Le denominateur choisi est celui des appels REELLEMENT NOTES (`total`), pas celui de tous les
     * tokens eligibles: comparer un taux de regle a une base calculee sur une autre population est
     * exactement la facon dont une regle a l'air bonne gratuitement. Les abstentions sortent donc des
     * deux cotes. */
    const baseTx = tauxPublie(dangerRugged + safeRugged, total);
    const contreBase = (obs) => (obs == null || baseTx.rate == null ? null : +((obs - baseTx.rate) * 100).toFixed(1));
    const tropMince = [d.withheld ? 'danger: ' + d.reason : null, sf.withheld ? 'sur: ' + sf.reason : null]
      .filter(Boolean);

    if (total < 20) {
      return { ...base, verdict: 'trop-peu', observed, tropMince,
        baseRateJuge: baseTx.rate, baseRateJugeN: baseTx.n,
        note: total + ' appel(s) resolu(s) depuis l annonce — sous les ' + MIN_RESOLUS + ' requis, le bruit '
          + 'domine et aucune conclusion ne se tire dans un sens ni dans l autre' + melange };
    }

    /* Un ecart ne se calcule QUE sur un taux publie. Le derive d'un taux retenu serait retenu aussi,
     * mais le dire explicitement evite qu'une refonte future rebranche l'ecart sur le ratio brut. */
    const ecart = (obs, pred) => (obs == null || pred == null ? null : +((obs - pred) * 100).toFixed(1));
    return { ...base, verdict: 'note', observed, tropMince,
      baseRateJuge: baseTx.rate, baseRateJugeN: baseTx.n,
      deltaPts: { danger: ecart(d.rate, a.predicted.dangerRate), safe: ecart(sf.rate, a.predicted.safeRate) },
      /* Les DEUX ecarts, cote a cote, parce qu'ils repondent a deux questions differentes: « la
       * prediction etait-elle juste » et « la regle bat-elle le hasard sur cette population ». Le
       * second manquait, et sans lui un monde devenu plus dangereux se lit comme une regle confirmee. */
      deltaVsBase: { danger: contreBase(d.rate), safe: contreBase(sf.rate) },
      note: 'note sur les seuls tokens apparus apres l annonce. Un ecart NEGATIF du cote sur, ou POSITIF '
        + 'du cote danger, va dans le sens du pari; l inverse le contredit. ⚠️ `deltaPts` compare au '
        + 'PARI, `deltaVsBase` compare au taux de base des appels REELLEMENT notes — seul le second dit '
        + 'si la regle bat le hasard ici, et les deux peuvent pointer en sens opposes quand la '
        + 'population a change depuis l annonce.'
        + (tropMince.length ? ' ⚠️ Un cote au moins est trop mince pour etre publie — voir `tropMince`; '
          + 'son compte reste lisible dans `dangerResolved`/`safeResolved`.' : '') + melange };
  });

  return { updatedAt: now, maturityWindowHours: maturityH, tokensAvailable: rows.length, cards: cartes,
    note: 'Seuls les tokens apparus APRES la date d annonce sont notes. Les autres sont ceux qui ont servi '
      + 'a fabriquer le chiffre, donc les compter serait reconduire l in-sample sous un autre nom.' };
}

module.exports = { runPrequential, gradeAnnounced, outcomeKnownAt, maturityWindow, quantile, coupeQuartiles,
  tauxPublie, MIN_RESOLUS, instrumentTemoin, RULES, DANGER, SAFE, ABSTAIN };
