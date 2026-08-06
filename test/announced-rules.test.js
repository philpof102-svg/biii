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
/** n tokens, moitie avant la frontiere et moitie apres, avec l'issue demandee.
 *
 * ⚠️ `lastSeen` EST OBLIGATOIRE POUR UN SURVIVANT, et cette fixture ne le portait pas. Elle fabriquait
 * donc des tokens declares 'live' que personne n'avait jamais reobserves, et le harnais les comptait
 * survivants sur leur seul age — le defaut mesure le 2026-08-05 (416 des 452 tokens 'live' de la base
 * n'avaient plus de lecture depuis 24 h). Depuis le durcissement d'`outcomeKnownAt`, vieillir ne suffit
 * plus: il faut avoir ete VU vivant a un age >= maturite. La fixture le fournit explicitement, ce qui
 * la rend realiste au lieu de la rendre indulgente.
 *
 * Un rug garde `ruggedAt` et reste date, donc il n'a pas besoin de fraicheur — on lui donne quand meme
 * un `lastSeen` a l'instant de sa mort, comme le radar le ferait. */
const faire = (n, decalageH, sym, outcome) => Array.from({ length: n }, (_, i) => {
  const vu = T0 + decalageH * H + i * 1000;
  return {
    addr: '0x' + String(i) + sym + decalageH, sym, firstSeen: iso(vu),
    lastSeen: iso(outcome === 'rugged' ? vu + H : vu + 400 * H),
    outcome, ruggedAt: outcome === 'rugged' ? iso(vu + H) : undefined,
  };
});

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

/* ⛔ LE DEFAUT MESURE LE 2026-08-06, REPRODUIT ICI. Le garde `total < 20` sommait les deux cotes. Une
 * carte a 19 appels danger et 2 appels sur totalisait 21, franchissait la porte, et publiait un taux
 * SUR calcule sur DEUX tokens — avec un ecart en points a cote, presente comme les autres. Sur le
 * bulletin reel: trois ecarts sur n=2, n=4 et n=6, plus le pari phare a « 0,0 % » sur n=1. */
t('★ 19 danger + 2 sur totalisent 21: la carte passe, et le cote a DEUX appels reste retenu', () => {
  const rows = [...faire(19, 10, 'XAP', 'rugged'), ...faire(2, 10, 'ZAP', 'live')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.verdict, 'note', 'la somme franchit bien 20 — c est precisement le piege');
  assert.strictEqual(r.dangerResolved, 19);
  assert.strictEqual(r.safeResolved, 2);
  assert.strictEqual(r.observed.safeRate, null, 'un taux sur DEUX tokens ne doit pas sortir');
  assert.strictEqual(r.observed.dangerRate, null, '19 non plus — le plancher vaut pour les deux cotes');
  assert.strictEqual(r.deltaPts.safe, null, 'aucun ecart ne se derive d un taux retenu');
  assert.strictEqual(r.deltaPts.danger, null);
  assert.strictEqual(r.tropMince.length, 2, 'les DEUX cotes retenus doivent se nommer');
});

t('★ le cas OPPOSE: a 20 appels de chaque cote, les deux taux et les deux ecarts sortent', () => {
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 10, 'ZAP', 'live')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.observed.dangerRate, 1, 'les 20 XAP ont tous rugge');
  assert.strictEqual(r.observed.safeRate, 0, 'aucun des 20 ZAP n a rugge');
  assert.ok(r.deltaPts.danger != null && r.deltaPts.safe != null, 'les ecarts doivent revenir');
  assert.deepStrictEqual(r.tropMince, [], 'plus rien n est retenu');
});

t('une carte `trop-peu` ne publie plus ses taux par la porte de derriere', () => {
  // 5+5 = 10 resolus: verdict `trop-peu`, mais l ancienne branche sortait quand meme les deux ratios.
  const rows = [...faire(5, 10, 'XAP', 'rugged'), ...faire(5, 10, 'ZAP', 'live')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.verdict, 'trop-peu');
  assert.strictEqual(r.observed.dangerRate, null, 'un verdict « aucune conclusion » ne publie pas un taux');
  assert.strictEqual(r.observed.safeRate, null);
  assert.strictEqual(r.dangerResolved, 5, 'le compte, lui, reste lisible');
});

/* ⛔ UN PARI GELE NE VAUT QUE SI SA VARIABLE GARDE SON SENS. Le texte de la regle est protege par un
 * test; le LECTEUR qui produit sa variable ne l'etait pas. Mesure du 2026-08-06: `siblingCount` porte
 * deux instruments depuis la pagination du 04/08, et 20 des 30 tokens comptes notes depuis l'annonce de
 * `simulation-et-financeur-lu` viennent du nouveau. La carte ne le disait nulle part. */
const compte = (t, n, pages) => Object.assign(t, pages === undefined
  ? { siblingCount: n } : { siblingCount: n, siblingPagesRead: pages });

t('★ deux lecteurs sous un seul nom de champ: la carte le DIT au lieu de lire une serie homogene', () => {
  const vieux = faire(20, 10, 'XAP', 'rugged').map((t) => compte(t, 30));            // lecteur une page
  const neufs = faire(20, 11, 'ZAP', 'live').map((t) => compte(t, 30, 6));           // lecteur pagine
  const r = gradeAnnounced([...vieux, ...neufs], iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.instrumentsMelanges, true, 'deux instruments doivent etre signales');
  assert.strictEqual(r.instruments['sibling:une-page'], 20);
  assert.strictEqual(r.instruments['sibling:pagine'], 20);
  assert.match(r.note, /PLUSIEURS INSTRUMENTS/);
});

t('★ le cas OPPOSE: un seul lecteur ne declenche AUCUN avertissement', () => {
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 11, 'ZAP', 'live')].map((t) => compte(t, 30));
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.instrumentsMelanges, false, 'un seul instrument ne doit rien signaler');
  assert.deepStrictEqual(Object.keys(r.instruments), ['sibling:une-page']);
  assert.ok(!/PLUSIEURS INSTRUMENTS/.test(r.note), 'aucun avertissement ne doit apparaitre');
});

t('une regle qui n utilise PAS la variable n est pas accusee — aucun temoin, aucun melange', () => {
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 11, 'ZAP', 'live')];   // sans siblingCount
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.deepStrictEqual(r.instruments, {}, 'sans la variable, il n y a pas d instrument a declarer');
  assert.strictEqual(r.instrumentsMelanges, false);
});

t('les appels OUVERTS et les ABSTENTIONS n entrent pas au temoignage', () => {
  // 20 notes au lecteur une page + 20 tokens JAMAIS reobserves (ouverts) au lecteur pagine.
  const notes = faire(20, 10, 'XAP', 'rugged').map((t) => compte(t, 30));
  const ouverts = faire(20, 11, 'ZAP', 'live').map((t) => compte(t, 30, 6));
  for (const t of ouverts) t.lastSeen = t.firstSeen;      // vu une fois, jamais revu -> non tranche
  const r = gradeAnnounced([...notes, ...ouverts], iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.safeOpen, 20, 'la fixture doit produire des appels OUVERTS, sinon le test ne dit rien');
  assert.strictEqual(r.instrumentsMelanges, false, 'un appel ouvert ne salit aucun taux publie');
  assert.strictEqual(r.instruments['sibling:pagine'], undefined);
});

/* ⛔ UN ECART CONTRE LE PARI N'EST PAS UN ECART CONTRE LE HASARD. Mesure du 2026-08-06: la base de la
 * population eligible valait 97,2 % quand celle de la base entiere valait 83,3 %. Les quatre cotes
 * publiables du bulletin affichaient des ecarts de +9 a +22 points « en faveur du pari » et etaient
 * tous a −0,7 / +0,0 point contre le hasard. Le monde etait devenu plus dangereux; aucune regle
 * n'avait rien prouve. */
t('★ quand TOUT rugge, l ecart contre le PARI est grand et l ecart contre la BASE est nul', () => {
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 11, 'ZAP', 'rugged')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.baseRateJuge, 1, 'les 40 appels notes ont tous rugge');
  assert.strictEqual(r.baseRateJugeN, 40);
  assert.ok(r.deltaPts.danger > 0, 'contre le pari a 90 %, un 100 % observe donne un ecart POSITIF');
  assert.strictEqual(r.deltaVsBase.danger, 0, 'contre le hasard, la regle n a rien separe');
  assert.strictEqual(r.deltaVsBase.safe, 0);
});

t('★ le cas OPPOSE: une regle qui separe VRAIMENT sort un ecart contre la base', () => {
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 11, 'ZAP', 'live')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.baseRateJuge, 0.5, '20 rugs sur 40 appels notes');
  assert.strictEqual(r.deltaVsBase.danger, 50, 'un cote danger a 100 % contre une base a 50 %');
  assert.strictEqual(r.deltaVsBase.safe, -50, 'et un cote sur a 0 %, dans le bon sens');
});

t('la base se calcule sur les appels NOTES — une abstention n entre pas dans le denominateur', () => {
  /* Une regle qui s abstient sur les 'QQQ'. Si la base les comptait, elle vaudrait autre chose que
   * le taux des appels reellement notes, et comparer un taux de regle a une base calculee sur une
   * AUTRE population est exactement la facon dont une regle a l air bonne gratuitement. */
  const abstenante = { key: 'jouet', label: 'jouet',
    predict: (t2) => (String(t2.sym).startsWith('Q') ? ABSTAIN : String(t2.sym).startsWith('X') ? DANGER : SAFE) };
  const rows = [...faire(20, 10, 'XAP', 'rugged'), ...faire(20, 11, 'ZAP', 'live'),
    ...faire(40, 12, 'QQQ', 'rugged')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [abstenante], announced: annonce }).cards[0];
  assert.strictEqual(r.abstained, 40, 'la fixture doit produire des abstentions, sinon le test ne dit rien');
  assert.strictEqual(r.baseRateJugeN, 40, 'seuls les 40 appels notes entrent au denominateur');
  assert.strictEqual(r.baseRateJuge, 0.5, 'les 40 rugs sur lesquels on s est abstenu ne gonflent pas la base');
});

t('sous le plancher, la base est retenue comme les autres taux', () => {
  const rows = [...faire(5, 10, 'XAP', 'rugged'), ...faire(5, 11, 'ZAP', 'live')];
  const r = gradeAnnounced(rows, iso(T0 + 500 * H), { rules: [jouet], announced: annonce }).cards[0];
  assert.strictEqual(r.verdict, 'trop-peu');
  assert.strictEqual(r.baseRateJuge, null, 'une base sur 10 appels ne se publie pas non plus');
  assert.strictEqual(r.baseRateJugeN, 10, 'mais son compte reste lisible');
});

t('★ une annonce sans regle vivante est NOMMEE, jamais sautee en silence', () => {
  const c = gradeAnnounced([], iso(T0 + 500 * H),
    { rules: [jouet], announced: [{ key: 'disparue', label: 'disparue', announcedAt: iso(T0), predicted: {}, basis: {}, note: 'x' }] });
  assert.strictEqual(c.cards[0].verdict, 'regle-introuvable');
  assert.match(c.cards[0].note, /pas un zero/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
