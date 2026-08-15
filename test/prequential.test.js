#!/usr/bin/env node
'use strict';
/**
 * Le harnais prequentiel — et surtout la propriete qu'aucun resultat ne peut trahir.
 *
 * Un rejeu qui consulte le futur rend EXACTEMENT la meme forme de sortie, en mieux. Sa correction est donc
 * invisible dans le chiffre publie et doit etre attaquee sur le mecanisme: on fait passer une regle SONDE
 * qui note tout ce qu'on lui montre, et on verifie qu'elle n'a jamais vu un token posterieur a celui
 * qu'elle jugeait. C'est la clause 4 du protocole, celle qu'on croit le plus facilement satisfaite.
 *
 * Les autres cas gardent les trois etats qui se confondent partout ailleurs dans ce depot: une issue non
 * resolue n'est ni une reussite ni un echec, et une abstention n'est pas un verdict « sur ».
 */
const assert = require('node:assert');
const { runPrequential, gradeAnnounced, outcomeKnownAt, tauxPublie, MIN_RESOLUS,
  DANGER, SAFE, ABSTAIN } = require('../lib/prequential');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-07-25T00:00:00.000Z');

/** Un jeu minimal ou les dates sont choisies pour que chaque etat soit atteint. */
function jeu() {
  return [
    // rug rapide: mort avant l'apparition des suivants, donc connaissable par eux
    { addr: '0xa1', sym: 'A', firstSeen: iso(T0), outcome: 'rugged', ruggedAt: iso(T0 + 1 * H), siblingCount: 30, siblingCountCensored: false },
    { addr: '0xa2', sym: 'B', firstSeen: iso(T0 + 2 * H), outcome: 'rugged', ruggedAt: iso(T0 + 3 * H), siblingCount: 25, siblingCountCensored: false },
    // survivant: ne compte comme survivant qu'apres la fenetre de maturite
    { addr: '0xa3', sym: 'C', firstSeen: iso(T0 + 4 * H), outcome: 'live', siblingCount: 2, siblingCountCensored: false },
    // compte jamais lu -> abstention, jamais « sur »
    { addr: '0xa4', sym: 'D', firstSeen: iso(T0 + 6 * H), outcome: 'rugged', ruggedAt: iso(T0 + 7 * H) },
  ];
}

console.log('prequential: la marche ne peut pas regarder en avant');

// ── clause 4, attaquee sur le mecanisme ────────────────────────────────────────────────────────
t('★ aucune regle ne voit un token posterieur a celui qu elle juge', () => {
  const vus = [];
  const sonde = {
    key: 'sonde', label: 'sonde', predict(tok, hist) {
      for (const h of hist) vus.push({ juge: Date.parse(tok.firstSeen), vu: Date.parse(h.firstSeen ?? tok.firstSeen) });
      return ABSTAIN;
    },
  };
  // La sonde lit `h.firstSeen`, que la projection de l'historique ne porte PAS — donc on verifie
  // plutot par le compteur interne, qui est calcule sur les lignes brutes avant projection.
  const c = runPrequential(jeu(), iso(T0 + 100 * H), { rules: [sonde] });
  assert.strictEqual(c.orderBreaches, 0, 'la marche a montre un token du futur');
  assert.strictEqual(c.firstOfFunderWithPriorSiblings, 0, 'un premier token de financeur a vu des freres');
});

t('★ le compteur de fuite mord vraiment — verifie sur des dates inversees', () => {
  /* Un compteur a zero sur des donnees saines ne prouve rien: il faut le voir passer a un. On
   * fabrique une ligne dont `firstSeen` est posterieur a son rang dans la marche en cassant le tri —
   * impossible via l'API, donc on attaque la fonction d'etat directement, qui est la brique dont
   * depend tout le comptage. */
  const futur = { addr: '0xz', firstSeen: iso(T0 + 50 * H), outcome: 'rugged', ruggedAt: iso(T0 + 51 * H) };
  assert.strictEqual(outcomeKnownAt(futur, T0, 4), null, 'un token pas encore apparu ne peut rien apprendre');
  assert.strictEqual(outcomeKnownAt(futur, T0 + 50.5 * H, 4), null, 'apparu mais pas encore mort: non resolu');
  assert.strictEqual(outcomeKnownAt(futur, T0 + 52 * H, 4), 'rugged', 'mort avant l instant: resolu');
});

t('un survivant n en est un qu APRES la fenetre de maturite', () => {
  /* ⚠️ `lastSeen` EST DESORMAIS OBLIGATOIRE POUR AFFIRMER UNE SURVIE, et cette ligne le prouve: la
   * version precedente de ce cas n'en portait pas et passait quand meme, parce que la fonction ne
   * regardait que l'age depuis `firstSeen`. Un token vieilli mais jamais reobserve etait declare
   * survivant. */
  const vivant = { addr: '0xv', firstSeen: iso(T0), lastSeen: iso(T0 + 6 * H), outcome: 'live' };
  assert.strictEqual(outcomeKnownAt(vivant, T0 + 2 * H, 4), null, 'trop jeune: pas encore une preuve de survie');
  assert.strictEqual(outcomeKnownAt(vivant, T0 + 5 * H, 4), 'survived', 'au-dela de la fenetre: survivant');
  assert.strictEqual(outcomeKnownAt(vivant, T0 + 5 * H, null), null, 'sans fenetre observee, rien n est resolu');
});

// ── la survie se PROUVE par une observation, elle ne se deduit pas de l age ────────────────────
t('un token qu on a CESSE d observer n est pas un survivant', () => {
  /* Le cas mesure le 2026-08-05: 416 des 452 tokens 'live' n'avaient pas ete lus depuis 24 h — dont
   * 229 depuis une semaine — et le harnais les comptait TOUS survivants. token-radar.js:295 fait
   * `if (liq == null) continue;` sans jamais regrader, donc un pool retire gele la ligne et
   * `lastSeen` cesse d'avancer. Vieillir n'est pas survivre. */
  const gele = { addr: '0xg', firstSeen: iso(T0), lastSeen: iso(T0 + 1 * H), outcome: 'live' };
  assert.strictEqual(outcomeKnownAt(gele, T0 + 200 * H, 4), null,
    'observe une seule heure puis plus jamais: l issue n est pas tranchee, meme 200 h plus tard');

  const jamaisRevu = { addr: '0xj', firstSeen: iso(T0), lastSeen: iso(T0), outcome: 'live' };
  assert.strictEqual(outcomeKnownAt(jamaisRevu, T0 + 50 * H, 4), null,
    'vu une fois et jamais reobserve: aucune preuve de survie');

  const sansLastSeen = { addr: '0xs', firstSeen: iso(T0), outcome: 'live' };
  assert.strictEqual(outcomeKnownAt(sansLastSeen, T0 + 50 * H, 4), null,
    'sans lastSeen lisible on ne peut rien affirmer — trois etats, pas deux');

  /* ⛔ ET LA BORNE EST `min(lastSeen, t)`: une observation POSTERIEURE a l instant juge ne peut pas
   * servir a le trancher, sinon la marche chronologique lit le futur — la clause 4 du protocole. */
  const observeApres = { addr: '0xa', firstSeen: iso(T0), lastSeen: iso(T0 + 100 * H), outcome: 'live' };
  assert.strictEqual(outcomeKnownAt(observeApres, T0 + 2 * H, 4), null,
    'lastSeen tres tardif ne rend pas le token resolu a un instant ou il etait encore jeune');
  assert.strictEqual(outcomeKnownAt(observeApres, T0 + 5 * H, 4), 'survived',
    'a un instant ou il avait passe la fenetre ET etait encore observe: resolu');

  /* Un rug reste date par `ruggedAt` et ne depend donc PAS de la fraicheur — le cote DANGER ne bouge
   * pas. Sans ce cas, un correctif qui casserait aussi les rugs passerait inapercu. */
  const mort = { addr: '0xm', firstSeen: iso(T0), lastSeen: iso(T0 + 1 * H), outcome: 'rugged', ruggedAt: iso(T0 + 3 * H) };
  assert.strictEqual(outcomeKnownAt(mort, T0 + 4 * H, 4), 'rugged',
    'un rug est DATE: sa resolution ne depend pas de la derniere lecture');
});

// ── les trois etats, dans le comptage ──────────────────────────────────────────────────────────
t('une abstention n entre dans AUCUN taux', () => {
  const abst = { key: 'a', label: 'a', predict: () => ABSTAIN };
  const c = runPrequential(jeu(), iso(T0 + 100 * H), { rules: [abst] });
  const card = c.cards[0];
  assert.strictEqual(card.abstained, 4, 'les quatre tokens doivent etre comptes comme abstentions');
  assert.strictEqual(card.dangerResolved, 0);
  assert.strictEqual(card.safeResolved, 0);
  assert.strictEqual(card.precision, null, 'une precision sans appel est nulle, pas 0 ni 1');
});

t('un appel dont l issue n est pas tranchee est OUVERT, jamais une erreur', () => {
  const tout = { key: 'd', label: 'd', predict: () => DANGER };
  // A `T0 + 4h30`, le token C (vu a +4h) n'a ni rugge ni depasse la fenetre: son appel est ouvert.
  const c = runPrequential(jeu(), iso(T0 + 4.5 * H), { rules: [tout] });
  const card = c.cards[0];
  assert.ok(card.dangerOpen >= 1, 'au moins un appel doit etre ouvert a cette date');
  assert.strictEqual(card.dangerRugged + card.dangerSurvived, card.dangerResolved);
  assert.ok(!Number.isNaN(card.precision ?? 0));
});

t('★ le cas OPPOSE: la meme regle notee plus tard resout ce qui etait ouvert', () => {
  /* Sans ce cas, le test precedent passerait aussi sur un harnais qui declare TOUT ouvert pour
   * toujours — la sortie constante qui ressemble a une mesure. */
  const tout = { key: 'd', label: 'd', predict: () => DANGER };
  const tot = runPrequential(jeu(), iso(T0 + 4.5 * H), { rules: [tout] }).cards[0];
  const tard = runPrequential(jeu(), iso(T0 + 100 * H), { rules: [tout] }).cards[0];
  assert.ok(tard.dangerResolved > tot.dangerResolved, 'le temps doit resoudre des appels');
  assert.ok(tard.dangerOpen < tot.dangerOpen, 'et donc en fermer');
});

// ── le garde ne du seuil constant a 50 ─────────────────────────────────────────────────────────
t('★ un seuil derive publie ses bornes, sinon un seuil CONSTANT passe pour un parametre libre', () => {
  /* Mesure du 2026-08-04: la regle « p75 du passe » a rendu min 50, mediane 50, max 50 sur 1859
   * tokens. 50 est le plafond de pagination de l'explorateur, pas une valeur du marche — la regle
   * « derivee » etait le drapeau de censure sous un autre nom. Elle etait indiscernable d'une
   * derivation honnete tant que le seuil n'etait pas publie. */
  const regle = {
    key: 'seuil', label: 'seuil', derived: true,
    threshold: (hist) => (hist.length ? 7 : null),
    predict(tok, hist) { const s = this.threshold(hist); return s == null ? ABSTAIN : (tok.siblingCount >= s ? DANGER : SAFE); },
  };
  const card = runPrequential(jeu(), iso(T0 + 100 * H), { rules: [regle] }).cards[0];
  assert.strictEqual(card.thresholdMin, 7, 'les bornes du seuil doivent remonter dans la carte');
  assert.strictEqual(card.thresholdMax, 7);
  assert.strictEqual(card.thresholdMedian, 7);
});

t('le taux de base est calcule sur la MEME population que les regles', () => {
  const c = runPrequential(jeu(), iso(T0 + 100 * H), { rules: [{ key: 'x', label: 'x', predict: () => SAFE }] });
  assert.strictEqual(c.resolvedTotal + c.unresolved, c.tokensWalked, 'tout token est resolu ou non resolu, jamais les deux');
  assert.ok(c.baseRate > 0 && c.baseRate <= 1);
});

t('une ligne sans firstSeen lisible est ecartee de la marche, pas jugee au hasard', () => {
  const rows = jeu().concat([{ addr: '0xbad', firstSeen: 'pas une date', outcome: 'rugged' }]);
  const c = runPrequential(rows, iso(T0 + 100 * H), { rules: [{ key: 'x', label: 'x', predict: () => DANGER }] });
  assert.strictEqual(c.tokensWalked, 4, 'la ligne illisible ne doit pas entrer dans la marche');
});

/* ── le plancher par COTE ────────────────────────────────────────────────────────────────────────
 * Mesure du 2026-08-06: `runPrequential` publiait « 100 % des appels SUR ont rugge » sur UN token, et
 * l'afficheur montrait a cote le denominateur de l'AUTRE cote (687). Le taux etait faux au sens ou il
 * n'etait pas une mesure, et rien dans la sortie ne permettait de s'en apercevoir.
 *
 * ⚠️ CES CAS DOIVENT ETRE OPPOSES. Un test qui ne verifie que le cote retenu passerait aussi sur un
 * garde qui retient TOUT — une sortie constante n'est pas une mesure. La borne 19/20 voyage donc avec
 * le chiffre: 19 doit etre refuse ET 20 doit etre publie, dans le meme test. */
console.log('\nplancher par cote: un taux ne se publie pas sur un denominateur trop mince');

t('★ tauxPublie distingue TROIS etats — rien a mesurer, trop mince, publiable', () => {
  const vide = tauxPublie(0, 0);
  assert.strictEqual(vide.rate, null);
  assert.strictEqual(vide.withheld, false, 'zero appel n est pas un retrait: il n y a rien a retenir');
  assert.match(vide.reason, /rien a mesurer/);

  const mince = tauxPublie(1, MIN_RESOLUS - 1);
  assert.strictEqual(mince.rate, null, 'un taux sur 19 appels ne doit pas sortir');
  assert.strictEqual(mince.withheld, true);
  assert.strictEqual(mince.n, MIN_RESOLUS - 1, 'le compte reste lisible meme quand le taux est retenu');

  const publie = tauxPublie(10, MIN_RESOLUS);
  assert.strictEqual(publie.rate, 0.5, 'a 20 appels le taux sort — sinon le garde retient tout');
  assert.strictEqual(publie.withheld, false);
  assert.strictEqual(publie.reason, null);
});

/** n tokens resolus, moitie d'un cote: `sym` decide la prediction, `outcome` decide l'issue.
 *  Un survivant porte un `lastSeen` tres posterieur — depuis le durcissement d'`outcomeKnownAt`,
 *  vieillir ne suffit plus, il faut avoir ete VU vivant a un age >= maturite. */
const lot = (n, sym, outcome, decalage) => Array.from({ length: n }, (_, i) => {
  const vu = T0 + decalage * H + i * 1000;
  return { addr: '0x' + sym + decalage + '_' + i, sym, firstSeen: iso(vu),
    lastSeen: iso(outcome === 'rugged' ? vu + H : vu + 4000 * H),
    outcome, ruggedAt: outcome === 'rugged' ? iso(vu + H) : undefined };
});
const parSymbole = { key: 'k', label: 'k', predict: (x) => (x.sym === 'D' ? DANGER : SAFE) };

t('★ le cote MINCE est retenu pendant que le cote FOURNI est publie — dans la meme carte', () => {
  // 30 appels danger (tous rugges) et 19 appels sur: un seul cote franchit le plancher.
  const rows = [...lot(30, 'D', 'rugged', 1), ...lot(19, 'S', 'live', 2)];
  const c = runPrequential(rows, iso(T0 + 5000 * H), { rules: [parSymbole] });
  const carte = c.cards[0];
  assert.strictEqual(carte.dangerResolved, 30);
  assert.strictEqual(carte.safeResolved, 19, 'la fixture doit poser 19 appels sur, sinon le test ne dit rien');
  assert.strictEqual(carte.precision, 1, 'le cote fourni DOIT sortir — un garde qui retient tout ne mesure rien');
  assert.strictEqual(carte.safeRugRate, null, 'un taux sur 19 appels ne doit pas sortir');
  assert.strictEqual(carte.tropMince.length, 1, 'un seul cote est retenu, et il doit se nommer');
  assert.match(carte.tropMince[0], /^safeRugRate: 19 appel/);
});

t('★ a 20 appels le meme cote se publie — la borne voyage avec le chiffre', () => {
  const rows = [...lot(30, 'D', 'rugged', 1), ...lot(20, 'S', 'live', 2)];
  const carte = runPrequential(rows, iso(T0 + 5000 * H), { rules: [parSymbole] }).cards[0];
  assert.strictEqual(carte.safeResolved, 20);
  assert.strictEqual(carte.safeRugRate, 0, 'aucun appel sur n a rugge, et 20 suffit pour le dire');
  assert.deepStrictEqual(carte.tropMince, [], 'plus rien ne doit etre retenu');
});

t('la PREUVE BRUTE survit au retrait — retenir le taux n est pas effacer les comptes', () => {
  const rows = [...lot(30, 'D', 'rugged', 1), ...lot(3, 'S', 'rugged', 2)];
  const carte = runPrequential(rows, iso(T0 + 5000 * H), { rules: [parSymbole] }).cards[0];
  assert.strictEqual(carte.safeRugRate, null, 'le taux est retenu');
  assert.strictEqual(carte.safeRugged, 3, 'le numerateur reste lisible');
  assert.strictEqual(carte.safeResolved, 3, 'le denominateur reste lisible');
});

/* ── le badge `derived` doit etre MERITE ────────────────────────────────────────────────────────
 * Clause 2 du protocole: un seuil pose a la main ne prouve rien et doit etre etiquete plutot que
 * melange aux derives. Un seuil derive qui ne bouge jamais est arithmetiquement un seuil pose a la
 * main — en pire, puisque personne ne l'a choisi et que personne ne peut donc le defendre. Les DEUX
 * regles derivees du jeu etaient dans cet etat le 2026-08-06, figees a 50 et a 1. */
console.log('\nle badge derive se merite: un seuil qui ne bouge jamais se dit');

/** n tokens espaces d'une heure, chacun RUGGE presque aussitot.
 *
 * ⚠️ Ils sont rugges DELIBEREMENT, et la premiere version de cette fixture ne l'etait pas. Un token
 * 'live' n'entre dans l'historique connu qu'une fois la fenetre de maturite passee, si bien que `hist`
 * restait vide et qu'un seuil derive de `hist.length` valait zero partout — la fixture fabriquait le
 * seuil constant qu'elle devait servir de contre-exemple. Un rug porte `ruggedAt`: il est tranche des
 * l'instant de sa mort, donc l'historique grandit reellement d'un token a l'autre. */
const jeuLong = (n) => Array.from({ length: n }, (_, i) => ({
  addr: '0x' + i, firstSeen: iso(T0 + i * H), lastSeen: iso(T0 + i * H + H / 10),
  outcome: 'rugged', ruggedAt: iso(T0 + i * H + H / 10), k: i,
}));

t('★ un seuil derive CONSTANT est denonce, badge et dementi cote a cote', () => {
  const fige = { key: 'f', label: 'f', derived: true,
    threshold: () => 7, predict: () => DANGER };
  const carte = runPrequential(jeuLong(30), iso(T0 + 5000 * H), { rules: [fige] }).cards[0];
  assert.strictEqual(carte.derived, true, 'la regle continue de decrire son mecanisme');
  assert.strictEqual(carte.thresholdMin, 7);
  assert.strictEqual(carte.thresholdMax, 7);
  assert.ok(carte.thresholdFige, 'un seuil qui ne bouge jamais doit etre nomme');
  assert.match(carte.thresholdFige, /ecrasee/);
});

t('★ le cas OPPOSE: un seuil qui VARIE ne declenche aucun dementi', () => {
  // Le seuil suit la taille de l'historique, donc il bouge a chaque token.
  const vivant = { key: 'v', label: 'v', derived: true,
    threshold: (hist) => hist.length, predict: () => DANGER };
  const carte = runPrequential(jeuLong(30), iso(T0 + 5000 * H), { rules: [vivant] }).cards[0];
  assert.ok(carte.thresholdMax > carte.thresholdMin, 'la fixture doit produire un seuil qui bouge');
  assert.strictEqual(carte.thresholdFige, null, 'un seuil derive qui bouge ne doit rien declencher');
});

t('une regle a seuil POSE A LA MAIN n est pas accusee — elle ne revendique rien', () => {
  const main = { key: 'm', label: 'm', threshold: () => 7, predict: () => DANGER };   // pas de `derived`
  const carte = runPrequential(jeuLong(30), iso(T0 + 5000 * H), { rules: [main] }).cards[0];
  assert.strictEqual(carte.derived, false);
  assert.strictEqual(carte.thresholdFige, null, 'sans revendication, il n y a rien a dementir');
});

t('sous quatre lectures, on ne juge pas le seuil — trop peu pour dire qu il est fige', () => {
  const fige = { key: 'f', label: 'f', derived: true, threshold: () => 7, predict: () => DANGER };
  const carte = runPrequential(jeuLong(3), iso(T0 + 5000 * H), { rules: [fige] }).cards[0];
  assert.ok(carte.thresholdMin != null, 'la fixture doit bien produire quelques lectures');
  assert.strictEqual(carte.thresholdFige, null, 'trois lectures ne suffisent pas a conclure');
});

/* ── la base contre laquelle une regle se compare ────────────────────────────────────────────────
 * `baseRate` porte sur TOUS les tokens resolus de la marche, y compris ceux sur lesquels la regle
 * s'est abstenue. Une regle qui s'abstient sur les cas faciles se compare donc a une population
 * qu'elle n'a pas jugee, et y gagne des points gratuitement — le piege que la note du fichier denonce
 * tout en y tombant. Mesure du 2026-08-06: cinq regles sur onze concernees, jusqu'a 7,1 points. */
console.log('\nune regle se compare a la population qu ELLE a jugee, pas a une autre');

t('★ l abstention gonfle l ecart contre la base GLOBALE, jamais contre la base JUGEE', () => {
  // 30 rugs juges DANGER, 30 survivants juges SUR, 30 survivants sur lesquels la regle s abstient.
  const rows = [...lot(30, 'D', 'rugged', 1), ...lot(30, 'S', 'live', 2), ...lot(30, 'A', 'live', 3)];
  const regle = { key: 'k', label: 'k',
    predict: (x) => (x.sym === 'A' ? ABSTAIN : x.sym === 'D' ? DANGER : SAFE) };
  const c = runPrequential(rows, iso(T0 + 5000 * H), { rules: [regle] });
  const carte = c.cards[0];
  assert.strictEqual(carte.abstained, 30, 'la fixture doit produire des abstentions, sinon rien n est teste');
  assert.strictEqual(carte.precision, 1, 'les 30 appels DANGER ont tous rugge');

  // base globale = 30 rugs / 90 resolus ; base jugee = 30 rugs / 60 appels notes.
  assert.strictEqual(c.baseRate, 0.3333, 'base globale sur les 90 tokens resolus');
  assert.strictEqual(carte.baseRateJuge, 0.5, 'base sur les 60 tokens REELLEMENT juges');
  assert.strictEqual(carte.baseRateJugeN, 60);

  const contreGlobale = +((carte.precision - c.baseRate) * 100).toFixed(1);
  assert.strictEqual(contreGlobale, 66.7, 'contre la base globale, la regle parait valoir 66,7 points');
  assert.strictEqual(carte.liftVsBaseJuge, 50, 'contre la population jugee, elle en vaut 50');
  assert.ok(carte.liftVsBaseJuge < contreGlobale, 'les 30 survivants ecartes gonflaient l ecart');
});

t('★ le cas OPPOSE: sans abstention, les deux bases sont IDENTIQUES', () => {
  const rows = [...lot(30, 'D', 'rugged', 1), ...lot(30, 'S', 'live', 2)];
  const c = runPrequential(rows, iso(T0 + 5000 * H), { rules: [parSymbole] });
  const carte = c.cards[0];
  assert.strictEqual(carte.abstained, 0, 'aucune abstention dans ce cas');
  assert.strictEqual(carte.baseRateJuge, c.baseRate, 'sans abstention, la distinction disparait');
  assert.strictEqual(carte.liftVsBaseJuge, +((carte.precision - c.baseRate) * 100).toFixed(1));
});

t('une base jugee sous le plancher est retenue, comme tout autre taux', () => {
  const rows = [...lot(5, 'D', 'rugged', 1), ...lot(5, 'S', 'live', 2)];
  const carte = runPrequential(rows, iso(T0 + 5000 * H), { rules: [parSymbole] }).cards[0];
  assert.strictEqual(carte.baseRateJuge, null, 'une base sur 10 appels ne se publie pas');
  assert.strictEqual(carte.baseRateJugeN, 10, 'son compte reste lisible');
  assert.strictEqual(carte.liftVsBaseJuge, null, 'et aucun ecart ne se derive d un taux retenu');
});

/* ── la fenetre de maturite publie sa propre marge d'erreur ──────────────────────────────────────
 * Chaque verdict « survecu » de ce fichier repose sur `maturityH`. `lib/scorecard.js` calcule
 * `beyondWindow` — les rugs plus lents que la fenetre — et les deux graders ne destructuraient que
 * `maturityH`. Mesure du 2026-08-06: 71 rugs sur 1454 (4,9 %) depassaient la fenetre de 4 h. */
console.log('\nla fenetre de maturite dit ce qu elle rate');

/** n rugs dont la duree de vie vaut `h` heures. */
const faireRugs = (n, h) => Array.from({ length: n }, (_, i) => ({
  addr: '0x' + h + '_' + i, firstSeen: iso(T0 + i * H), lastSeen: iso(T0 + i * H + h * H),
  outcome: 'rugged', ruggedAt: iso(T0 + i * H + h * H) }));

t('★ un rug PLUS LENT que la fenetre est compte et publie', () => {
  /* ⚠️ LA PROPORTION DE LENTS EST LOAD-BEARING, et la premiere version de ce cas l'avait ratee: avec
   * 5 lents sur 45 (11 %), le p95 tombe DANS les lents, la fenetre s'etire jusqu'a eux et plus rien ne
   * la depasse — la fixture fabriquait le zero qu'elle devait refuter. Il faut moins de 5 % de lents
   * pour que le p95 reste chez les rapides. L'assertion a attrape la fixture au lieu de passer a vide. */
  const c = runPrequential([...faireRugs(100, 1), ...faireRugs(2, 100)], iso(T0 + 5000 * H),
    { rules: [{ key: 'k', label: 'k', predict: () => DANGER }] });
  assert.strictEqual(c.fenetre.rugsDates, 102, 'les 102 rugs dates doivent etre comptes');
  assert.ok(c.fenetre.rugsAuDela >= 1, 'les rugs lents doivent etre comptes au-dela de la fenetre');
  assert.ok(c.fenetre.partAuDela > 0);
  assert.strictEqual(c.fenetre.slowestRugH, 100, 'le plus lent est rapporte, meme s il ne fixe pas la fenetre');
  assert.match(c.fenetre.note, /peut donc encore rugger/);
});

t('★ le cas OPPOSE: si TOUS les rugs tiennent dans la fenetre, rien n est signale', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    addr: '0xr' + i, firstSeen: iso(T0 + i * H), lastSeen: iso(T0 + i * H + H),
    outcome: 'rugged', ruggedAt: iso(T0 + i * H + H) }));
  const c = runPrequential(rows, iso(T0 + 5000 * H),
    { rules: [{ key: 'k', label: 'k', predict: () => DANGER }] });
  assert.strictEqual(c.fenetre.rugsAuDela, 0, 'aucun rug ne depasse une fenetre qui les couvre tous');
  assert.strictEqual(c.fenetre.partAuDela, 0);
});

t('sans aucun rug date, la fenetre le DIT au lieu de se taire', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    addr: '0xs' + i, firstSeen: iso(T0 + i * H), lastSeen: iso(T0 + i * H + 4000 * H), outcome: 'live' }));
  const c = runPrequential(rows, iso(T0 + 5000 * H),
    { rules: [{ key: 'k', label: 'k', predict: () => SAFE }] });
  assert.strictEqual(c.fenetre.rugsDates, 0);
  assert.match(c.fenetre.note, /aucun rug date/);
});

t('le bulletin des paris publie la MEME confession que la marche', () => {
  const rows = [...faireRugs(100, 1), ...faireRugs(2, 100)];
  const a = runPrequential(rows, iso(T0 + 5000 * H), { rules: [{ key: 'k', label: 'k', predict: () => DANGER }] });
  const b = gradeAnnounced(rows, iso(T0 + 5000 * H),
    { rules: [{ key: 'k', label: 'k', predict: () => DANGER }],
      announced: [{ key: 'k', label: 'k', announcedAt: iso(T0 - 1000 * H), predicted: {}, basis: {}, note: 'x' }] });
  assert.deepStrictEqual(b.fenetre, a.fenetre, 'les deux graders doivent avouer la meme chose');
});

/* ── UN PARI INERTE N'EST PAS UN PARI JEUNE ───────────────────────────────────────────────────────── */

t('★ une regle qui s abstient sur TOUS ses eligibles rend `inerte`, pas `trop-peu`', () => {
  /* ⛔ Les deux etats produisaient le meme mot et le meme affichage, alors que l un s ameliore avec le
   * temps et l autre JAMAIS. Mesure du 2026-08-10: `natif-b20`, pari ANNONCE, rendait 488 abstentions
   * sur 488 eligibles — sa `predict` lit `t.addr`, un champ absent de TOUTES les lignes (l adresse est
   * la CLE de l objet). Un pari mort deguise en pari jeune. */
  const rows = [...faireRugs(40, 1)];
  const muette = { key: 'm', label: 'm', predict: () => ABSTAIN };
  const c = gradeAnnounced(rows, iso(T0 + 5000 * H), { rules: [muette],
    announced: [{ key: 'm', label: 'm', announcedAt: iso(T0 - 1000 * H), predicted: {}, basis: {}, note: 'x' }] })
    .cards[0];
  assert.strictEqual(c.verdict, 'inerte', 'abstention totale => inerte');
  assert.ok(/ne peut rien dire/.test(c.note), 'et la note doit le DIRE en clair: ' + c.note);
  assert.strictEqual(c.abstained, c.eligible, 'temoin de coherence: toutes les abstentions comptees');
});

t('★ TEMOIN: une regle qui s abstient BEAUCOUP mais pas partout reste `trop-peu`', () => {
  /* Sans ce cas, rendre `inerte` des la moindre abstention passerait le test ci-dessus et effacerait
   * la distinction qu on vient d introduire. */
  const rows = [...faireRugs(40, 1)];
  let n = 0;
  const presque = { key: 'p', label: 'p', predict: () => (++n === 1 ? DANGER : ABSTAIN) };
  const c = gradeAnnounced(rows, iso(T0 + 5000 * H), { rules: [presque],
    announced: [{ key: 'p', label: 'p', announcedAt: iso(T0 - 1000 * H), predicted: {}, basis: {}, note: 'x' }] })
    .cards[0];
  assert.notStrictEqual(c.verdict, 'inerte', 'UN seul appel non-abstenu suffit a sortir de l inertie');
  assert.strictEqual(c.verdict, 'trop-peu', 'et sous le plancher il reste trop-peu: ' + c.verdict);
});

/* ── LA BORNE QUI NE VOYAGEAIT PAS: LES LIGNES SANS DATE LISIBLE ──────────────────────────────────────
 *
 * `runPrequential` et `gradeAnnounced` commencent tous deux par ecarter les lignes dont `firstSeen`
 * n'est pas parsable. Le retrait est CORRECT — une marche chronologique ne peut rien faire d'une ligne
 * sans date. Mais son COMPTE n'etait publie nulle part: les lignes ecartees disparaissaient du
 * denominateur, de l'historique de chaque prediction et de tout chiffre rendu, sans laisser de trace.
 * Ce module ecrit lui-meme « La BORNE voyage avec le chiffre »; c'etait la seule qui ne voyageait pas.
 *
 * ⚖️ MESURE DU 2026-08-15 SUR LA BASE REELLE: 2775 lignes, 2775 datables, 0 ecartee. Le defaut est
 * LATENT, pas vivant, et ce test le dit — mais un collecteur qui changerait de nom de champ demain
 * ferait fondre la population sans qu'aucun chiffre publie ne bouge, et c'est ca qu'on rend visible. */
const SANS_DATE = [
  { firstSeen: 'pas-une-date' }, { firstSeen: '' }, { firstSeen: null }, {},
];
const AVEC_DATE = [
  { firstSeen: iso(T0 + 1 * H), rug: false }, { firstSeen: iso(T0 + 2 * H), rug: false },
];

t('★ runPrequential COMPTE les lignes qu il ecarte, au lieu de les faire disparaitre', () => {
  const r = runPrequential([...AVEC_DATE, ...SANS_DATE], iso(T0 + 500 * H));
  assert.strictEqual(r.tokensWalked, AVEC_DATE.length, 'seules les datables sont marchees');
  assert.strictEqual(r.tokensUndated, SANS_DATE.length,
    'les 4 ecartees doivent etre COMPTEES: ' + r.tokensUndated);
});

t('★ gradeAnnounced — le JUMEAU publie la meme borne', () => {
  const annonce = [{ key: 'p', label: 'p', announcedAt: iso(T0), predicted: {}, basis: {}, note: 'x' }];
  const g = gradeAnnounced([...AVEC_DATE, ...SANS_DATE], iso(T0 + 500 * H), { announced: annonce });
  assert.strictEqual(g.tokensAvailable, AVEC_DATE.length);
  assert.strictEqual(g.tokensUndated, SANS_DATE.length,
    'corriger une moitie et pas l autre laisserait la publiante sans sa borne');
});

t('★ TEMOIN — une base entierement datable rend 0, pas `null` ni undefined', () => {
  const r = runPrequential(AVEC_DATE, iso(T0 + 500 * H));
  assert.strictEqual(r.tokensUndated, 0, 'zero est ici une MESURE, pas une absence');
  assert.strictEqual(typeof r.tokensUndated, 'number');
  /* ⛔ Sans ce temoin, un `tokensUndated` toujours egal a `toutes.length` passerait le cas precedent. */
  assert.strictEqual(r.tokensWalked, AVEC_DATE.length);
});

t('★ TEMOIN — la somme se referme: marchees + ecartees = ce qu on nous a donne', () => {
  const entree = [...AVEC_DATE, ...SANS_DATE];
  const r = runPrequential(entree, iso(T0 + 500 * H));
  assert.strictEqual(r.tokensWalked + r.tokensUndated, entree.length,
    'une ligne doit etre dans exactement une des deux colonnes');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
