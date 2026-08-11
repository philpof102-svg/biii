#!/usr/bin/env node
'use strict';
/**
 * probe-first-verdict-tient-il.js
 * ================================================================================================
 * LE VERDICT QUE LE SERVICE REND A LA PREMIERE VUE SEPARE-T-IL LES ISSUES ?
 *
 * `firstVerdict` est ce que le produit SERT. C'est la premiere variable de cette session dont la
 * DISTRIBUTION est saine — 36 / 35 / 27 / 2 pct, aucune valeur dominante, contrairement a
 * `siblingCount` (41 pct sur une seule valeur) ou `dropPct` (66 pct sur exactement 1).
 *
 * ═══ TROIS RESULTATS, ET LES CONTROLES LES SEPARENT ═══
 * Mesure du 2026-08-11, base 82,4 pct sur 2150 resolus, plafond danger 17,6 pts.
 *
 * 1. ⛔ `unknown` N'EST PAS UN VERDICT SUR LE TOKEN — c'est le marqueur d'un TRACAGE QUI N'A PAS EU
 *    LIEU. 71,6 pct de ces lignes n'ont ni `freshDeployer`, ni `siblingCount`, ni `funder` (contre
 *    37,5 pct ailleurs): les TROIS memes champs, au MEME taux, parce qu'ils viennent tous du meme
 *    tracage. Et cette population rugge a 90,1 pct, soit +7,7 pts au-dessus de la base.
 *    💎 Notre collecte echoue donc la ou c'est le PLUS dangereux — ou les tokens dangereux sont plus
 *    durs a tracer. ⛔ On ne tranche pas le sens causal: structure, jamais intention.
 *    ⚠️ Consequence produit: un appelant lit « on ne sait pas » et devrait lire « 90 pct de rugs dans
 *    cette population ». L'incompletude se presente comme rassurante alors qu'elle alarme.
 *
 * 2. ⛔ `high_risk` NE SURVIT PAS AU CONTROLE D'INDEPENDANCE. 96,4 pct par token (+14,0 pts, 80 pct du
 *    plafond) — mais 752 tokens pour seulement 15 FINANCEURS, donc sous le plancher de 20 et le taux
 *    par operateur est RETENU. Le plus gros financeur porte 22,5 pct du groupe.
 *
 * 3. ✅ `caution` SURVIT. 31 financeurs (> plancher), 60,2 pct par financeur, ecart -22,2 pts, et
 *    AUCUN operateur ne domine (le plus gros: 8,8 pct du groupe).
 *    ⚠️ Il reste heterogene: la strate sans drapeau de censure (606 des 773) ne donne que -4,0 pts,
 *    tandis que les 167 tokens TRACES donnent -77,0 et -70,3. Meme SENS partout, donc pas d'inversion,
 *    mais le -19,2 global vient surtout des tokens traces.
 *
 * ⚠️ BORNES: population d'observation de CE noeud. `ruggedAt` est une DETECTION. Issues resolues par le
 * helper CANONIQUE `outcomeKnownAt`. ⛔ Aucune adresse imprimee, aucun pari annonce.
 */
const fs = require('node:fs');
const path = require('node:path');
const { outcomeKnownAt, maturityWindow, MIN_RESOLUS } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.log('base ILLISIBLE (' + ((e && e.message) || e) + ')'); process.exitCode = 1; return; }

const lignes = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const f = maturityWindow(lignes);
const T = Date.now();
const res = [];
for (const t of lignes) { const k = outcomeKnownAt(t, T, f.maturityH); if (k) res.push({ t, rug: k === 'rugged' }); }
const base = 100 * res.filter((r) => r.rug).length / res.length;
const tx = (a) => (a.length ? 100 * a.filter((x) => x.rug).length / a.length : null);
const ec = (p) => (p === null ? '' : '   ecart ' + (p - base >= 0 ? '+' : '') + (p - base).toFixed(1) + ' pts');

console.log('== `firstVerdict` — le verdict SERVI a la premiere vue ==');
console.log('   base ' + base.toFixed(1) + ' pct sur ' + res.length + ' resolus   plafond danger '
  + (100 - base).toFixed(1) + ' pts');

/* ── 1. LA DISTRIBUTION D'ABORD — c'est elle qui a parle a chaque fois ─────────────────────────────── */
console.log('');
console.log('-- distribution et taux par valeur --');
const par = new Map();
for (const r of res) {
  const v = r.t.firstVerdict === undefined ? 'ABSENT' : String(r.t.firstVerdict);
  if (!par.has(v)) par.set(v, []);
  par.get(v).push(r);
}
const rangs = [...par.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [v, g] of rangs) {
  console.log('   ' + v.padEnd(12) + String(g.length).padStart(5) + '  ('
    + (100 * g.length / res.length).toFixed(1) + ' pct)   ' + tx(g).toFixed(1) + ' pct' + ec(tx(g)));
}
/* ⛔ UNE VALEUR DOMINANTE ferait de la mesure un portrait de cette valeur, pas d'un verdict. */
const domine = rangs[0][1].length / res.length;
console.log('   => valeur la plus frequente: ' + (100 * domine).toFixed(1) + ' pct '
  + (domine > 0.6 ? '⛔ DOMINANTE — la mesure porterait sur elle, pas sur le verdict' : '✅ pas de domination'));

/* ── 2. CE QUE `unknown` CACHE ────────────────────────────────────────────────────────────────────── */
console.log('');
console.log('-- ⛔ que cache `unknown` ? co-occurrence avec les champs manquants --');
const unk = res.filter((r) => r.t.firstVerdict === 'unknown');
const autres = res.filter((r) => r.t.firstVerdict !== 'unknown');
if (unk.length && autres.length) {
  console.log('   champ                dans `unknown`   ailleurs');
  for (const c of ['freshDeployer', 'siblingCount', 'funder', 'basisAtFirstSight', 'symbolVerdict']) {
    const a = 100 * unk.filter((r) => r.t[c] === undefined).length / unk.length;
    const b = 100 * autres.filter((r) => r.t[c] === undefined).length / autres.length;
    console.log('   ' + c.padEnd(20) + a.toFixed(1).padStart(7) + ' pct' + b.toFixed(1).padStart(10) + ' pct'
      + (a - b > 30 ? '   <- FORTEMENT lie' : ''));
  }
  console.log('   ⚠️ trois champs au MEME taux = une seule cause: le tracage de financeur n a pas tourne.');
  console.log('   ⛔ Donc `unknown` mesure NOTRE collecte, pas le token — et cette population rugge a '
    + tx(unk).toFixed(1) + ' pct.');
}

/* ── 3. LES CONTROLES, VALEUR PAR VALEUR ──────────────────────────────────────────────────────────── */
console.log('');
console.log('-- les controles: censure, puis unite d INDEPENDANCE --');
for (const [v, g] of rangs) {
  if (g.length < 50) continue;                       // sous 50 tokens, decouper n apprend rien
  console.log('   === ' + v + ' ===');
  const signes = [];
  for (const cv of [true, false, undefined]) {
    const s = g.filter((r) => r.t.siblingCountCensored === cv);
    if (!s.length) continue;
    console.log('     cens=' + String(cv).padEnd(9) + String(s.length).padStart(5) + '   '
      + tx(s).toFixed(1) + ' pct' + ec(tx(s)) + (s.length < MIN_RESOLUS ? '   ⚠️ n < ' + MIN_RESOLUS : ''));
    if (cv !== undefined && s.length >= MIN_RESOLUS) signes.push(Math.sign(tx(s) - base));
  }
  if (signes.length > 1) {
    console.log('     inversion de signe entre strates ? '
      + (new Set(signes).size > 1 ? '⛔ OUI — melange' : '✅ NON'));
  }
  /* ⛔ L'UNITE D'INDEPENDANCE EST LE FINANCEUR. Un taux par token porte par quelques operateurs decrit
   * ces operateurs, pas une regle — c'est ce qui a tue la poche `freshDeployer` mesuree le meme jour. */
  const parF = new Map();
  for (const r of g) {
    const k = r.t.funder && String(r.t.funder).toLowerCase();
    if (!k) continue;
    if (!parF.has(k)) parF.set(k, { n: 0, r: 0 });
    const e = parF.get(k); e.n++; if (r.rug) e.r++;
  }
  const pf = parF.size ? 100 * [...parF.values()].reduce((s, e) => s + e.r / e.n, 0) / parF.size : null;
  const tailles = [...parF.values()].map((e) => e.n).sort((a, b) => b - a);
  const avecF = g.filter((r) => r.t.funder).length;
  console.log('     financeurs ' + String(parF.size).padStart(4) + '   '
    + (parF.size >= MIN_RESOLUS
      ? pf.toFixed(1) + ' pct par financeur' + ec(pf)
      : '⛔ RETENU (' + parF.size + ' < ' + MIN_RESOLUS + ') — le taux par token ne se publie pas seul'));
  console.log('     couverture du controle: ' + avecF + ' des ' + g.length
    + ' tokens ont un financeur (' + (100 * avecF / g.length).toFixed(1) + ' pct)');
  if (tailles.length) {
    /* ⛔ « AUCUN OPERATEUR NE DOMINE » EST AMBIGU, ET C'EST UN PIEGE NEUF (2026-08-11). Une domination
     * faible signifie « bien distribue » OU « que des singletons » — et les deux se lisent PAREIL.
     * Sur `unknown`, le plus gros financeur pesait 0,7 pct, ce qui m'a d'abord rassure; il s'agissait en
     * fait de 155 SINGLETONS sur 158 financeurs (98,1 pct). Or sur un financeur a UN token, la « moyenne
     * par financeur » EST l'issue de ce token: le controle d'independance ne controle alors RIEN.
     * La part de singletons est donc imprimee A COTE de la domination — sans elle, la seconde ment. */
    const singles = tailles.filter((x) => x === 1).length;
    const partSingle = parF.size ? 100 * singles / parF.size : 0;
    console.log('     le plus gros financeur pese ' + (100 * tailles[0] / g.length).toFixed(1) + ' pct du groupe'
      + (tailles[0] / g.length > 0.5 ? '   ⛔ un seul operateur PORTE ce groupe' : ''));
    console.log('     mediane tokens/financeur ' + tailles[Math.floor(tailles.length / 2)]
      + '   max ' + tailles[0] + '   SINGLETONS ' + singles + ' (' + partSingle.toFixed(1) + ' pct)');
    if (partSingle > 80) {
      console.log('     ⛔ GROUPE DE SINGLETONS: la moyenne par financeur EST l issue du token.');
      console.log('        Le controle d independance ne controle RIEN ici — le taux par financeur');
      console.log('        ci-dessus ne vaut pas mieux que le taux par token, il le REPETE.');
    } else if (partSingle > 50) {
      console.log('     ⚠️ plus de la moitie de singletons: le controle est PARTIEL, pas nul.');
    }
  }
}

console.log('');
console.log('⛔ Aucun pari annonce ici. Ce qui se decide — que faire de `unknown`, qui se presente comme');
console.log('   une ignorance neutre alors qu il porte +7,7 pts — est une SEMANTIQUE PRODUIT.');
