#!/usr/bin/env node
// probe-candidats-dans-la-branche-sure.js — les chiffres de la table de decision sont-ils mesures
// LA OU un filtre agirait ?
// ================================================================================================
// `probe-candidats-se-recouvrent.js` a etabli que la population entiere est SATUREE: 87 a 92 % des
// tokens resolus ruggent, donc la plupart des cellules n'ont pas assez de marge pour qu'un ecart soit
// seulement VISIBLE. Or les six lectures de la table de decision ont TOUTES leurs chiffres mesures sur
// cette population-la.
//
// LA QUESTION: chacune separe-t-elle encore dans la branche « sur » de la regle vivante — le seul
// endroit ou un filtre agit, puisque c'est la que la regle laisse passer, et le seul ou il reste de la
// marge ? Les deux colonnes sont imprimees COTE A COTE: l'ecart entre elles est le resultat.
//
// ⛔ LES DEFINITIONS NE SONT PAS REECRITES. Elles sont copiees telles quelles de
// `probe-tous-candidats-par-operateur.js` (lignes 54-73), parce que ce depot a paye sept fois le motif
// « le helper correct existe et l'appelant a fort enjeu ne l'appelle pas ». La seule divergence connue
// est signalee et MESUREE plus bas: la version canonique met `not_a_candidate` et `unknown` dans le
// COMPLEMENT de `thin`, ce qui traite « pas verifie » comme « pas thin ».
//
// ⛔ ET `relance` SE CALCULE SUR LA POPULATION ENTIERE, PUIS SE RESTREINT. L'etat depend des tokens
// PRECEDENTS portant le meme symbole; batir l'index sur la seule branche « sur » rendrait invisibles
// les predecesseurs qui n'y sont pas, et un token relance passerait pour un premier. L'index est donc
// construit sur `toutes`, le terrain n'est applique qu'a la mesure.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: pour chaque lecture et chaque terrain, l'ecart contre le COMPLEMENT avec
// bornes, et si la marge disponible permettait seulement de le voir.
// ⛔ CE QU'ELLE NE PEUT PAS: promouvoir une lecture. Une lecture qui separe dans la branche « sur »
// AUJOURD'HUI doit etre annoncee datee puis notee vers l'avant — ce depot a tue deux regles en
// balayant des seuils et gardant le meilleur.
// ⛔ Aucune adresse imprimee.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const toutes = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(toutes);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* ── COPIE CONFORME de probe-tous-candidats-par-operateur.js:46-73 ───────────────────────────────────
 * L'index est bati sur `toutes` — voir l'entete: le restreindre au terrain fabriquerait des « premiers »
 * a partir de tokens qui ont bel et bien un predecesseur. */
const parSym = new Map();
for (const t of toutes) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) continue;
  if (!parSym.has(s)) parSym.set(s, []);
  parSym.get(s).push({ ...t, _d: d });
}
for (const v of parSym.values()) v.sort((a, b) => a._d - b._d);
const relanceEtat = (t) => {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) return null;
  const prec = (parSym.get(s) || []).filter((p) => p._d < d && p.addr !== t.addr);
  if (!prec.length) return false;
  return prec.some((p) => outcomeKnownAt(p, d, maturityH) === 'rugged');
};

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
  const f = new Set(res.map(fnd).filter(Boolean));
  return { res: res.length, rug, fN: f.size, brut: proportionAvecBornes(rug, res.length) };
}

/* ── LA GARDE DE SATURATION, reprise de probe-candidats-se-recouvrent.js ─────────────────────────────
 * Un ecart doit etre lu contre la marge qui restait. Quand la marge est plus etroite que l'intervalle
 * le plus large, aucune separation ne POUVAIT apparaitre, et « chevauchants » n'y dit rien. */
function compare(M, C) {
  if (!M.res || !C.res) return null;
  const d = 100 * (M.brut.taux - C.brut.taux);
  const ref = M.brut.taux < C.brut.taux ? M.brut : C.brut;
  const marge = 100 * (1 - ref.taux);
  const largeur = Math.max(100 * (M.brut.haute - M.brut.basse), 100 * (C.brut.haute - C.brut.basse));
  return { d, marge, sature: marge < largeur, disj: disjoints(M.brut, C.brut) };
}

const TERRAINS = [
  ['population entiere', () => toutes],
  ['branche « sur »', () => toutes.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL)],
];

console.log('\n  ── LES SIX LECTURES, SUR LES DEUX TERRAINS ──');
console.log('     complement = champ LISIBLE disant autre chose. Les lignes sans le champ sont HORS comparaison.');
console.log('     « marge » = ce qu il restait a separer. Une cellule SATUREE ne compte ni pour ni contre.\n');

const bilan = new Map();
for (const [nomT, filtre] of TERRAINS) {
  const terrain = filtre();
  const resolus = terrain.filter((t) => issue(t) !== null).length;
  console.log('  ══ ' + nomT + '  —  ' + terrain.length + ' lignes, ' + resolus + ' resolues ══\n');
  console.log('    lecture              marq/res    taux marque      compl.   taux compl.      ecart / marge');
  console.log('    ' + '-'.repeat(104));
  for (const [nom, lit] of LECTURES) {
    const M = mesure(terrain.filter((t) => lit(t) === true));
    const C = mesure(terrain.filter((t) => lit(t) === false));
    const hors = terrain.filter((t) => lit(t) === null).length;
    if (!M.res || !C.res) {
      console.log('    ' + nom.padEnd(20) + '⛔ un cote VIDE sur ce terrain ('
        + M.res + ' marques, ' + C.res + ' complement, ' + hors + ' hors comparaison)');
      bilan.set(nom + '|' + nomT, null);
      continue;
    }
    const r = compare(M, C);
    console.log('    ' + nom.padEnd(20) + String(M.rug + '/' + M.res).padStart(9) + '  ' + pct(M.brut.taux)
      + '   ' + String(C.res).padStart(6) + '   ' + pct(C.brut.taux)
      + '   ' + ((r.d >= 0 ? '+' : '') + r.d.toFixed(1)).padStart(6) + ' / ' + r.marge.toFixed(1).padStart(5)
      + '  ' + (r.sature ? '⛔ SATUREE' : r.disj ? '💎 DISJOINTS' : '⚠️ chevauchants'));
    bilan.set(nom + '|' + nomT, r);
  }
  console.log('');
}

/* ── LE RESULTAT: CE QUE LE CHANGEMENT DE TERRAIN FAIT A CHAQUE LECTURE ──────────────────────────── */
console.log('  ── CE QUE LE TERRAIN CHANGE ──\n');
console.log('    lecture              population entiere        branche « sur »           lecture');
console.log('    ' + '-'.repeat(104));
for (const [nom] of LECTURES) {
  const a = bilan.get(nom + '|population entiere'), b = bilan.get(nom + '|branche « sur »');
  const rendu = (r) => (r === null ? 'un cote vide'.padEnd(24)
    : ((r.d >= 0 ? '+' : '') + r.d.toFixed(1) + ' pts/' + r.marge.toFixed(0)
      + (r.sature ? ' SAT' : r.disj ? ' DISJ' : ' chev')).padEnd(24));
  let lecture;
  if (b === null) lecture = '⛔ INEXISTANTE dans la branche « sur » — ne peut PAS y filtrer';
  else if (b.sature && (a === null || a.sature)) lecture = '⛔ satureee des deux cotes — non testable';
  else if (b.disj && a && a.sature) lecture = '💎 invisible sur la population, VISIBLE la ou ca compte';
  else if (b.disj && a && !a.disj) lecture = '💎 ne separait pas, separe dans la branche « sur »';
  else if (b.disj) lecture = '✅ separe sur les DEUX terrains';
  else if (a && a.disj && !b.disj) lecture = '⚠️ separait sur la population, PLUS dans la branche « sur »';
  else lecture = '⚠️ ne separe sur aucun des deux';
  console.log('    ' + nom.padEnd(20) + rendu(a) + rendu(b) + lecture);
}

/* ── LA CONCENTRATION, PARCE QU'ELLE A RETOURNE LE TITRE DE CETTE SONDE ──────────────────────────────
 * La branche « sur » porte 320 tokens resolus sur 183 financeurs, dont 174 n'en portent qu'UN. Trois
 * financeurs a eux seuls portent 131 lignes — 41 %. Un ecart par token calcule la-dessus decrit peut-etre
 * trois operateurs et non une regle, et ce depot a deja paye ce piege une fois aujourd'hui.
 * ⛔ Retirer les plus gros n'est PAS une correction: c'est une QUESTION posee au chiffre. Les deux
 * versions sont imprimees, et aucune n'est « la vraie ».
 * ⛔ Aucune adresse n'est imprimee — seulement des tailles. */
console.log('\n  ── ET SI ON RETIRE LES TROIS PLUS GROS FINANCEURS DE LA BRANCHE « SUR » ? ──\n');
{
  const sur = toutes.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL && issue(t) !== null);
  const par = new Map();
  for (const t of sur) { const f = fnd(t); if (f) par.set(f, (par.get(f) || 0) + 1); }
  const tri = [...par.entries()].sort((a, b) => b[1] - a[1]);
  const gros = new Set(tri.slice(0, 3).map((e) => e[0]));
  const lignesGros = tri.slice(0, 3).reduce((s, e) => s + e[1], 0);
  console.log('    ' + sur.length + ' tokens resolus · ' + par.size + ' financeurs · '
    + tri.filter((e) => e[1] === 1).length + ' n en portent qu UN ('
    + (100 * tri.filter((e) => e[1] === 1).length / par.size).toFixed(1) + ' %)');
  console.log('    les 3 plus gros portent ' + tri.slice(0, 3).map((e) => e[1]).join(' + ') + ' = '
    + lignesGros + ' lignes, soit ' + (100 * lignesGros / sur.length).toFixed(1) + ' % du terrain\n');
  console.log('    lecture       tous les financeurs                sans les 3 plus gros');
  console.log('    ' + '-'.repeat(96));
  for (const [nom, lit] of LECTURES) {
    const rendu = (g) => {
      const M = mesure(g.filter((t) => lit(t) === true)), C = mesure(g.filter((t) => lit(t) === false));
      const r = compare(M, C);
      if (!r) return 'un cote vide'.padEnd(34);
      return (((r.d >= 0 ? '+' : '') + r.d.toFixed(1) + ' pts/' + r.marge.toFixed(0) + '  '
        + (r.sature ? 'SATUREE' : r.disj ? 'DISJOINTS' : 'chevauchants')).padEnd(34));
    };
    const avant = rendu(sur), apres = rendu(sur.filter((t) => !gros.has(fnd(t))));
    console.log('    ' + nom.padEnd(18) + avant + apres);
  }
  console.log('\n  ⚠️ Une lecture qui tombe ici ne devient pas fausse: elle devient une observation sur');
  console.log('     TROIS operateurs, tres en dessous du plancher de ' + MIN_RESOLUS + ' tirages. Et ce depot ecrit');
  console.log('     qu un launchpad et une usine a rugs sont indiscernables sous cet angle: la structure');
  console.log('     est rapportee, jamais l intention.');
}

/* ── LA DIVERGENCE CONNUE, MESUREE PLUTOT QU IGNOREE ─────────────────────────────────────────────── */
console.log('\n  ── `not_a_candidate` ET `unknown` DANS LE COMPLEMENT DE `thin`: EST-CE QUE CA CHANGE ? ──\n');
console.log('    La definition canonique met ces lignes dans le complement, donc traite « pas verifie »');
console.log('    comme « pas thin ». Le depot ecrit ailleurs que « absent » n est pas « faux ». Mesure:\n');
for (const [nomT, filtre] of TERRAINS) {
  const terrain = filtre();
  const canon = (t) => (t.symbolVerdict === undefined ? null : t.symbolVerdict === 'thin');
  const strict = (t) => (typeof t.symbolVerdict !== 'string' || t.symbolVerdict === 'not_a_candidate'
    || t.symbolVerdict === 'unknown' ? null : t.symbolVerdict === 'thin');
  const rc = compare(mesure(terrain.filter((t) => canon(t) === true)), mesure(terrain.filter((t) => canon(t) === false)));
  const rs = compare(mesure(terrain.filter((t) => strict(t) === true)), mesure(terrain.filter((t) => strict(t) === false)));
  const ecartes = terrain.filter((t) => canon(t) === false && strict(t) === null).length;
  if (!rc || !rs) { console.log('    ' + nomT.padEnd(22) + '⛔ un cote vide'); continue; }
  console.log('    ' + nomT.padEnd(22) + 'canonique ' + ((rc.d >= 0 ? '+' : '') + rc.d.toFixed(1)).padStart(6)
    + ' pts   ·   strict ' + ((rs.d >= 0 ? '+' : '') + rs.d.toFixed(1)).padStart(6) + ' pts   ·   '
    + ecartes + ' ligne(s) deplacee(s)   ·   ' + (Math.abs(rc.d - rs.d) < 1 ? 'sans effet' : '⚠️ CHANGE LE CHIFFRE'));
}

console.log('\n  ⛔ RIEN N EST PROMU. Une lecture qui separe dans la branche « sur » aujourd hui doit etre');
console.log('     ANNONCEE avec sa date puis notee VERS L AVANT: ce depot a tue deux regles en balayant');
console.log('     des seuils et gardant le meilleur. Consolider la table est une decision produit.');
console.log('  ⚠️ Et une lecture « saturee » n est pas une lecture morte: elle dit que ce terrain-la ne');
console.log('     pouvait rien montrer, pas que la lecture ne porte rien. Aucune adresse imprimee.\n');
