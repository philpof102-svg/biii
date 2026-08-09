#!/usr/bin/env node
// probe-tous-candidats-par-operateur.js — la meme regle de comptage pour TOUS les candidats.
// ================================================================================================
// `probe-relance-combien-d-operateurs.js` a montre que l'ecart de `relance` tombe de +24,8 points par
// TOKEN a +7,3 points par OPERATEUR, parce que la ponderation par ligne gonfle un groupe et degonfle
// l'autre EN MEME TEMPS. Les trois autres candidats n'ont jamais subi ce test: leurs chiffres publies
// sont tous par token. La table de decision compare donc des unites melangees, et personne ne peut
// arbitrer la-dessus.
//
// Cette sonde applique le MEME traitement aux six lectures — les quatre candidats et les deux regles
// vivantes — pour qu'on compare enfin la meme chose:
//   · taux par TOKEN contre le COMPLEMENT (jamais contre une population qui contient le sous-groupe)
//   · moyenne NON PONDEREE par financeur, un operateur une voix
//   · nombre de financeurs distincts de chaque cote, et le plancher applique
//   · l'ecart apres retrait des plus gros porteurs
//
// ⛔ LE COMPLEMENT EXCLUT LES LIGNES OU LE CHAMP EST ABSENT. « absent » n'est pas « faux »: les inclure
// gonflerait le complement d'inconnus et fabriquerait un ecart.
// ⛔ LES DEUX MOYENNES NE MESURENT PAS LA MEME CHOSE et aucune n'est « la vraie »: le taux par token
// repond a « quelle part des lignes observees a rugge », la moyenne par operateur a « que fait le
// prochain operateur ». La seconde est celle qui interesse un acheteur; les deux sont publiees.
// ⛔ ELLE NE PROMEUT RIEN.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU(' + p.effectif + ')' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* Reconstruction du groupe `relance`, jugee SANS regarder le futur (cf. probe-relance-est-elle-circulaire). */
const parSym = new Map();
for (const t of rows) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) continue;
  if (!parSym.has(s)) parSym.set(s, []);
  parSym.get(s).push({ ...t, _d: d });
}
for (const v of parSym.values()) v.sort((a, b) => a._d - b._d);
const relanceEtat = (t) => {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) return null;                       // champ non calculable: hors comparaison
  const prec = (parSym.get(s) || []).filter((p) => p._d < d && p.addr !== t.addr);
  if (!prec.length) return false;
  return prec.some((p) => outcomeKnownAt(p, d, maturityH) === 'rugged');
};

/**
 * Chaque lecture rend TROIS etats: true (marque), false (lisible et non marque), null (champ absent —
 * hors comparaison). C'est la seule facon d'avoir un complement honnete.
 */
const LECTURES = [
  ['relance', relanceEtat],
  ['thin', (t) => (t.symbolVerdict === undefined ? null : t.symbolVerdict === 'thin')],
  ['no_creator', (t) => (t.funderTrace === undefined ? null : t.funderTrace === 'no_creator')],
  ['impersonation', (t) => (t.symbolVerdict === undefined ? null : t.symbolVerdict === 'impersonation')],
  ['fnd20 (vivante)', (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL)],
  ['jetable (vivante)', (t) => (t.freshDeployer === undefined ? null : t.freshDeployer === true)],
];

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const parF = new Map();
  for (const t of res) {
    const f = fnd(t); if (!f) continue;
    if (!parF.has(f)) parF.set(f, { n: 0, r: 0 });
    const e = parF.get(f); e.n++; if (issue(t) === 'rugged') e.r++;
  }
  const moyenne = parF.size ? [...parF.values()].reduce((s, e) => s + e.r / e.n, 0) / parF.size : null;
  return { res: res.length, rug, fN: parF.size, parF, moyenne,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: parF.size, plancher: MIN_RESOLUS }) };
}

console.log('\n  ── LES SIX LECTURES, LA MEME REGLE DE COMPTAGE POUR TOUTES ──');
console.log('     complement = champ LISIBLE et disant autre chose. Les lignes sans le champ sont HORS comparaison.\n');
console.log('    lecture              marques  compl.   par TOKEN                         par OPERATEUR (non pondere)');
console.log('    ' + '-'.repeat(112));
const bilan = [];
for (const [nom, lit] of LECTURES) {
  const M = mesure(rows.filter((t) => lit(t) === true));
  const C = mesure(rows.filter((t) => lit(t) === false));
  const absents = rows.filter((t) => lit(t) === null).length;
  if (!M.res || !C.res) { console.log('    ' + nom.padEnd(20) + '⛔ un cote vide — rien a comparer'); continue; }
  const dTok = 100 * (M.brut.taux - C.brut.taux);
  const dOp = (M.moyenne !== null && C.moyenne !== null) ? 100 * (M.moyenne - C.moyenne) : null;
  bilan.push({ nom, M, C, absents, dTok, dOp });
  console.log('    ' + nom.padEnd(20) + String(M.res).padStart(6) + String(C.res).padStart(8) + '   '
    + (pct(M.brut.taux) + ' vs ' + pct(C.brut.taux)).padEnd(20)
    + ((dTok >= 0 ? '+' : '') + dTok.toFixed(1) + ' pts ' + (disjoints(M.brut, C.brut) ? '💎' : '⚠️')).padEnd(14)
    + (dOp === null ? '   —'
      : (pct(M.moyenne) + ' vs ' + pct(C.moyenne)).padEnd(20) + (dOp >= 0 ? '+' : '') + dOp.toFixed(1) + ' pts'));
}

/* ── LE DEGONFLEMENT, LECTURE PAR LECTURE ────────────────────────────────────────────────────────── */
console.log('\n  ── DE COMBIEN CHAQUE ECART SE DEGONFLE QUAND ON COMPTE LES OPERATEURS ──\n');
console.log('    lecture              par token   par operateur   perdu    financeurs (marques / compl.)');
console.log('    ' + '-'.repeat(96));
for (const b of bilan) {
  if (b.dOp === null) continue;
  const perdu = b.dTok !== 0 ? (100 * (1 - b.dOp / b.dTok)) : null;
  console.log('    ' + b.nom.padEnd(20) + ((b.dTok >= 0 ? '+' : '') + b.dTok.toFixed(1)).padStart(8) + ' pts'
    + ((b.dOp >= 0 ? '+' : '') + b.dOp.toFixed(1)).padStart(12) + ' pts'
    + (perdu === null ? '      —' : (perdu >= 0 ? ' ' : '') + perdu.toFixed(0).padStart(6) + ' %')
    + '    ' + String(b.M.fN).padStart(4) + ' / ' + String(b.C.fN).padStart(4)
    + (b.M.fN < MIN_RESOLUS ? '   ⛔ marques sous le plancher' : ''));
}
console.log('\n  ⚠️ « perdu » = la part de l ecart par token qui disparait quand chaque operateur pese pareil.');
console.log('     Un pourcentage NEGATIF signifie que l ecart GRANDIT en comptant les operateurs.');

/* ── ET LE RETRAIT DES PLUS GROS PORTEURS, POUR CHAQUE LECTURE ───────────────────────────────────── */
console.log('\n  ── L ECART SURVIT-IL AU RETRAIT DES 3 PLUS GROS PORTEURS ? ──\n');
console.log('    lecture              avant                    apres retrait de 3       verdict');
console.log('    ' + '-'.repeat(96));
for (const [nom, lit] of LECTURES) {
  const marques = rows.filter((t) => lit(t) === true);
  const compl = rows.filter((t) => lit(t) === false);
  const M0 = mesure(marques), C0 = mesure(compl);
  if (!M0.res || !C0.res || !M0.parF.size) { console.log('    ' + nom.padEnd(20) + '⛔ pas de financeur trace'); continue; }
  const gros = [...M0.parF.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([f]) => f);
  const ex = new Set(gros);
  const M1 = mesure(marques.filter((t) => { const f = fnd(t); return !f || !ex.has(f); }));
  if (!M1.res) { console.log('    ' + nom.padEnd(20) + '⛔ plus rien apres retrait'); continue; }
  const d0 = 100 * (M0.brut.taux - C0.brut.taux), d1 = 100 * (M1.brut.taux - C0.brut.taux);
  console.log('    ' + nom.padEnd(20) + ((d0 >= 0 ? '+' : '') + d0.toFixed(1) + ' pts ' + (disjoints(M0.brut, C0.brut) ? '💎' : '⚠️')).padEnd(25)
    + ((d1 >= 0 ? '+' : '') + d1.toFixed(1) + ' pts ' + (disjoints(M1.brut, C0.brut) ? '💎' : '⚠️')).padEnd(25)
    + (disjoints(M1.brut, C0.brut) ? 'tient' : 'tombe'));
}

console.log('\n  ⛔ LES DEUX COLONNES NE MESURENT PAS LA MEME CHOSE, et aucune n est « la vraie ». Le taux par');
console.log('     TOKEN repond a « quelle part des lignes observees a rugge ». La moyenne par OPERATEUR');
console.log('     repond a « que fera le prochain operateur ». C est la seconde qu un acheteur lit, mais');
console.log('     c est la premiere qui gouverne un radar qui juge des lignes. Les deux sont publiees.');
console.log('  ⛔ UNE LECTURE SOUS LE PLANCHER DE ' + MIN_RESOLUS + ' FINANCEURS ne publie pas de taux par tirage. Sa');
console.log('     colonne « par operateur » reste lisible comme MOYENNE, mais sans intervalle: une moyenne');
console.log('     sur quatorze operateurs n a pas la meme autorite qu une moyenne sur cent soixante.');
console.log('  ⛔ ET RIEN N EST PROMU. Annoncer un pari est date et irreversible.\n');
