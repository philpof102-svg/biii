#!/usr/bin/env node
'use strict';
/**
 * Un pari ne vaut que s'il ne peut pas etre reecrit apres coup.
 *
 * `lib/announced-rules.js` fige une regle, la date a partir de laquelle elle compte, et le taux
 * qu'elle PREDIT. `gradeAnnounced` ne note ensuite que les tokens apparus APRES cette date. Tout le
 * dispositif repose sur une seule propriete: la frontiere ne doit pas pouvoir etre placee dans le
 * passe — sinon « note vers l'avant » redevient de l'in-sample sous un autre nom, et le bulletin
 * afficherait des resultats immediats qui ne prouveraient rien.
 *
 * Le cas qui compte le plus ici est donc le premier: la date d'annonce est-elle posterieure a la
 * derniere observation connue au moment de l'ecriture ? C'est verifiable, et un fichier de paris qui
 * ne se verifie pas est un fichier de souhaits.
 */
const assert = require('node:assert');
const { ANNOUNCED, OBSERVATION_LA_PLUS_RECENTE_A_L_ANNONCE } = require('../lib/announced-rules');
const { gradeAnnounced, RULES, DANGER, SAFE, ABSTAIN } = require('../lib/prequential');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const H = 3600000;
const T0 = Date.parse('2026-08-05T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

console.log('announced-rules: un pari ne se reecrit pas apres coup');

t('★ AUCUNE annonce n est antidatee — sinon la note vers l avant est de l in-sample deguise', () => {
  const derniere = Date.parse(OBSERVATION_LA_PLUS_RECENTE_A_L_ANNONCE);
  assert.ok(Number.isFinite(derniere), 'la derniere observation doit etre une date lisible');
  assert.ok(ANNOUNCED.length >= 1, 'succes VIDE: aucune annonce a verifier');
  for (const a of ANNOUNCED) {
    const d = Date.parse(a.announcedAt);
    assert.ok(Number.isFinite(d), a.key + ': date d annonce illisible');
    assert.ok(d > derniere,
      a.key + ': annoncee le ' + a.announcedAt + ', soit AVANT ou PENDANT les observations qui ont '
      + 'servi a fabriquer le chiffre (' + OBSERVATION_LA_PLUS_RECENTE_A_L_ANNONCE + ')');
  }
});

t('★ chaque annonce porte un pari CHIFFRE et une base — pas seulement un nom', () => {
  for (const a of ANNOUNCED) {
    assert.ok(a.predicted && typeof a.predicted === 'object', a.key + ': aucun taux predit');
    const taux = Object.values(a.predicted).filter((v) => typeof v === 'number');
    assert.ok(taux.length >= 1, a.key + ': `predicted` ne contient aucun nombre');
    for (const v of taux) assert.ok(v >= 0 && v <= 1, a.key + ': un taux hors [0,1] — ' + v);
    assert.ok(a.basis && typeof a.basis.baseRate === 'number',
      a.key + ': le taux de BASE doit voyager avec le pari, un pourcentage seul ne vaut rien');
    assert.ok(typeof a.note === 'string' && a.note.length > 40, a.key + ': la note doit dire ce qui est parie');
  }
});

t('chaque annonce correspond a une regle VIVANTE', () => {
  const cles = new Set(RULES.map((r) => r.key));
  for (const a of ANNOUNCED) assert.ok(cles.has(a.key), a.key + ': aucune regle vivante ne porte cette cle');
});

t('les annonces sont GELEES — une reecriture silencieuse est impossible', () => {
  assert.ok(Object.isFrozen(ANNOUNCED), 'le tableau doit etre gele');
  for (const a of ANNOUNCED) {
    assert.ok(Object.isFrozen(a), a.key + ': entree non gelee');
    assert.throws(() => { 'use strict'; a.predicted.safeRate = 0.01; }, TypeError, a.key + ': le pari est modifiable');
  }
});

// ── le grader ──────────────────────────────────────────────────────────────────────────────────
/** Regle jouet: DANGER si le symbole commence par X. Aucun reseau, aucune dependance. */
const jouet = { key: 'jouet', label: 'jouet', predict: (t2) => (String(t2.sym || '').startsWith('X') ? DANGER : SAFE) };
const annonce = [{ key: 'jouet', label: 'jouet', announcedAt: iso(T0), predicted: { dangerRate: 0.9, safeRate: 0.1 }, basis: {}, note: 'x' }];
/** n tokens, moitie avant la frontiere et moitie apres, avec l'issue demandee. */
const faire = (n, decalageH, sym, outcome) => Array.from({ length: n }, (_, i) => ({
  addr: '0x' + String(i) + sym + decalageH, sym, firstSeen: iso(T0 + decalageH * H + i * 1000),
  outcome, ruggedAt: outcome === 'rugged' ? iso(T0 + decalageH * H + i * 1000 + H) : undefined,
}));

t('★ les tokens ANTERIEURS a l annonce ne sont jamais notes', () => {
  const rows = faire(40, -50, 'XAV', 'rugged');           // 40 rugs, tous AVANT la frontiere
  const c = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce });
  assert.strictEqual(c.cards[0].eligible, 0, 'aucun token posterieur: rien ne doit etre eligible');
  assert.strictEqual(c.cards[0].verdict, 'pas-encore-notable');
});

t('★ zero eligible n est PAS un taux de zero', () => {
  const c = gradeAnnounced([], iso(T0 + 500 * H), { rules: [jouet], announced: annonce });
  const r = c.cards[0];
  assert.strictEqual(r.verdict, 'pas-encore-notable');
  assert.strictEqual(r.observed, undefined, 'aucun taux ne doit etre publie sans donnees');
  assert.match(r.note, /ni confirme ni infirme/);
});

t('sous 20 appels resolus, on dit « trop peu » plutot que de conclure', () => {
  const rows = [...faire(5, 10, 'XAP', 'rugged'), ...faire(5, 10, 'ZAP', 'live')];
  const c = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce });
  assert.strictEqual(c.cards[0].verdict, 'trop-peu');
  assert.match(c.cards[0].note, /le bruit domine/);
});

t('★ au-dela du seuil, le pari est note et l ECART se lit', () => {
  // 30 tokens en X qui ruggent tous -> danger observe 100 %, pari 90 % -> ecart +10 pts.
  const rows = [...faire(30, 10, 'XAP', 'rugged'), ...faire(30, 10, 'ZAP', 'live')];
  const c = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce });
  const r = c.cards[0];
  assert.strictEqual(r.verdict, 'note');
  assert.strictEqual(r.observed.dangerRate, 1);
  assert.ok(r.deltaPts.danger > 0, 'un cote danger meilleur que prevu doit sortir un ecart POSITIF');
  assert.strictEqual(r.observed.safeRate, 0, 'aucun ZAP n a rugge');
});

t('★ une annonce sans regle vivante est NOMMEE, jamais sautee en silence', () => {
  const c = gradeAnnounced([], iso(T0 + 500 * H),
    { rules: [jouet], announced: [{ key: 'disparue', label: 'disparue', announcedAt: iso(T0), predicted: {}, basis: {}, note: 'x' }] });
  assert.strictEqual(c.cards[0].verdict, 'regle-introuvable');
  assert.match(c.cards[0].note, /pas un zero/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
