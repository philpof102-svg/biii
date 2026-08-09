#!/usr/bin/env node
// probe-relance-combien-d-operateurs.js — 775 tokens derriere 37 financeurs: qui porte le signal ?
// ================================================================================================
// `probe-relance-est-elle-circulaire.js` a montre que `relaunchOfRugged` survit au controle qui lui
// manquait: la qualification « rugge » n'est pas un synonyme de « symbole deja vu » (+19,4 points,
// intervalles disjoints). Il a aussi imprime le chiffre qui gene: le groupe A porte 775 tokens resolus
// derriere 37 financeurs distincts, soit 20,9 chacun.
//
// Un taux calcule sur 775 lignes qui remontent a 37 payeurs n'est pas un taux sur 775 tirages. Reste a
// savoir si ces 37 pesent pareil, ou si trois d'entre eux font le chiffre. Le test est direct: retirer
// les plus gros porteurs, un a un, et regarder si l'ecart contre le groupe temoin survit.
//
// ⚠️ CE QU'IL PEUT PROUVER: la concentration du groupe A, et ce que devient son taux quand on retire
// ses plus gros porteurs — avec bornes, et sans jamais publier un taux sous le plancher de tirages.
// ⛔ CE QU'IL NE PEUT PAS: dire qui sont ces operateurs, ni qu un financeur partage designe une
// personne. Un financeur commun prouve une infrastructure partagee — un launchpad et une usine a rugs
// se ressemblent exactement ici. STRUCTURE, jamais intention.
// ⛔ ET RETIRER LES PLUS GROS N EST PAS UNE CORRECTION: c est une question posee aux donnees. Un
// signal qui ne tient que sur ses plus gros porteurs reste vrai sur eux; il ne se generalise pas.
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
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU (' + p.effectif + ' tirages)' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* Meme reconstruction que la sonde precedente, et jugee SANS regarder le futur. */
const parSym = new Map();
for (const t of rows) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) continue;
  if (!parSym.has(s)) parSym.set(s, []);
  parSym.get(s).push({ ...t, _d: d });
}
for (const v of parSym.values()) v.sort((a, b) => a._d - b._d);
function groupe(t) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) return null;
  const prec = (parSym.get(s) || []).filter((p) => p._d < d && p.addr !== t.addr);
  if (!prec.length) return 'C';
  return prec.some((p) => outcomeKnownAt(p, d, maturityH) === 'rugged') ? 'A' : 'C_vu_sans_rug';
}

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { res: res.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}

const A = rows.filter((t) => groupe(t) === 'A' && issue(t) !== null);
const C = rows.filter((t) => groupe(t) === 'C' && issue(t) !== null);
const mA = mesure(A), mC = mesure(C);

/* ── LA CONCENTRATION ────────────────────────────────────────────────────────────────────────────── */
const parF = new Map();
for (const t of A) { const f = fnd(t); if (f) parF.set(f, (parF.get(f) || 0) + 1); }
const tailles = [...parF.entries()].sort((a, b) => b[1] - a[1]);
const sansF = A.filter((t) => !fnd(t)).length;
const totalTraces = A.length - sansF;

console.log('\n  ── LE GROUPE A, ET QUI LE PORTE ──\n');
console.log('    tokens resolus                    ' + mA.res + '   taux ' + ic(mA.brut));
console.log('    dont portant un financeur trace   ' + totalTraces + '   derriere ' + parF.size + ' financeur(s) distinct(s)');
console.log('    sans financeur trace              ' + sansF + '   (ils n entrent dans aucun compte de tirages)');
if (!parF.size) { console.log('\n  ⛔ aucun financeur trace dans A: la concentration ne se mesure pas.'); process.exit(0); }
const cumul = (n) => tailles.slice(0, n).reduce((s, x) => s + x[1], 0);
console.log('\n    le plus gros porteur              ' + tailles[0][1] + ' tokens  ('
  + (100 * tailles[0][1] / totalTraces).toFixed(1) + ' % du groupe trace)');
for (const n of [3, 5, 10]) {
  if (n > tailles.length) break;
  console.log('    les ' + String(n).padStart(2) + ' plus gros                    ' + String(cumul(n)).padStart(4)
    + ' tokens  (' + (100 * cumul(n) / totalTraces).toFixed(1) + ' %)');
}

/* ── LE TEST: RETIRER LES PLUS GROS, UN A UN ─────────────────────────────────────────────────────── */
console.log('\n  ── ET SI ON RETIRE LES PLUS GROS PORTEURS ? ──\n');
console.log('    retires   tokens restants   financeurs   taux par token           contre C');
console.log('    ' + '-'.repeat(96));
for (const k of [0, 1, 2, 3, 5, 10]) {
  if (k >= tailles.length) break;
  const exclus = new Set(tailles.slice(0, k).map(([f]) => f));
  const reste = A.filter((t) => { const f = fnd(t); return !f || !exclus.has(f); });
  const m = mesure(reste);
  if (!m.res) { console.log('    ' + String(k).padStart(4) + '      (plus rien)'); continue; }
  const d = (m.brut.taux !== null && mC.brut.taux !== null) ? 100 * (m.brut.taux - mC.brut.taux) : null;
  console.log('    ' + String(k).padStart(4) + String(m.res).padStart(16) + String(m.fN).padStart(13)
    + '   ' + ic(m.brut).padEnd(24)
    + (d === null ? '' : (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts '
      + (disjoints(m.brut, mC.brut) ? '💎 tient' : '⚠️ tombe')));
}
console.log('\n    groupe temoin C (symbole jamais vu)   ' + mC.res + ' resolus   ' + ic(mC.brut)
  + '   ' + mC.fN + ' financeurs');

/* ── UN OPERATEUR, UNE VOIX ──────────────────────────────────────────────────────────────────────── */
const parts = new Map();
for (const t of A) {
  const f = fnd(t); if (!f) continue;
  if (!parts.has(f)) parts.set(f, { n: 0, r: 0 });
  const e = parts.get(f); e.n++; if (issue(t) === 'rugged') e.r++;
}
const moyenne = parts.size ? [...parts.values()].reduce((s, e) => s + e.r / e.n, 0) / parts.size : null;
const partsC = new Map();
for (const t of C) {
  const f = fnd(t); if (!f) continue;
  if (!partsC.has(f)) partsC.set(f, { n: 0, r: 0 });
  const e = partsC.get(f); e.n++; if (issue(t) === 'rugged') e.r++;
}
const moyenneC = partsC.size ? [...partsC.values()].reduce((s, e) => s + e.r / e.n, 0) / partsC.size : null;
console.log('\n  ── UN OPERATEUR, UNE VOIX (moyenne NON PONDEREE des parts de rug) ──\n');
console.log('    A  ' + pct(moyenne) + '  sur ' + parts.size + ' financeur(s)        par token ' + pct(mA.brut.taux));
console.log('    C  ' + pct(moyenneC) + '  sur ' + partsC.size + ' financeur(s)       par token ' + pct(mC.brut.taux));
if (moyenne !== null && moyenneC !== null) {
  console.log('    ecart non pondere ' + (100 * (moyenne - moyenneC) >= 0 ? '+' : '')
    + (100 * (moyenne - moyenneC)).toFixed(1) + ' pts   contre '
    + (100 * (mA.brut.taux - mC.brut.taux)).toFixed(1) + ' pts par token');
}

console.log('\n  ⛔ RETIRER LES PLUS GROS N EST PAS UNE CORRECTION, c est une question. Un signal qui ne');
console.log('     tient que sur ses plus gros porteurs reste vrai SUR EUX; il ne se generalise pas au');
console.log('     prochain operateur, et c est le prochain operateur qui interesse un acheteur.');
console.log('  ⛔ STRUCTURE, JAMAIS INTENTION. Un financeur commun prouve une infrastructure partagee —');
console.log('     un launchpad et une usine a rugs sont indiscernables sous cet angle. Aucun nom, aucune');
console.log('     accusation, et les adresses ne sont pas imprimees.');
console.log('  ⚠️ Les tokens SANS financeur trace ne comptent dans aucun retrait: ils restent dans chaque');
console.log('     ligne du tableau. Le taux « apres retrait » est donc un MELANGE, et son ecart contre C');
console.log('     est attenue — jamais gonfle.\n');
