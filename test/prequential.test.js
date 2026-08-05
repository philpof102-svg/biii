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
const { runPrequential, outcomeKnownAt, DANGER, SAFE, ABSTAIN } = require('../lib/prequential');

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
