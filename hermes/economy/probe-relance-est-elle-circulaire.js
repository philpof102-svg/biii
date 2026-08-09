#!/usr/bin/env node
// probe-relance-est-elle-circulaire.js — « récidive », ou simplement « symbole déjà vu » ?
// ================================================================================================
// `probe-relance-de-rugge.js` a mesure que `relaunchOfRugged` est le signal le plus fort de la session
// et lui a oppose trois controles: cohorte, liquidite, etat de trace. Il en manquait un, et c'est celui
// qui decide.
//
// LE CHAMP, LU DANS LE CODE (token-radar.js): `priorBySym[c.sym]` filtre les tokens de MEME SYMBOLE vus
// AVANT, puis garde ceux dont `outcome === 'rugged'`. Le champ dit donc: « un token portant ce symbole
// a deja rugge ». Or cette population rugge a 82 %. Dans un monde ou quatre tokens sur cinq finissent
// mal, « symbole deja vu » implique presque toujours « symbole deja vu qui a rugge » — et le champ
// mesurerait la REPETITION, pas la RECIDIVE.
//
// LE CONTROLE QUI TRANCHE, et qu'aucune sonde n'avait fait: comparer a un symbole deja vu dont le
// predecesseur n'a PAS rugge.
//   A — symbole deja vu, au moins un predecesseur RUGGE      (= `relaunchOfRugged`)
//   B — symbole deja vu, AUCUN predecesseur rugge            (le temoin manquant)
//   C — symbole jamais vu
// Si A ~ B, la qualification « rugge » n'ajoute rien et le signal est la repetition.
//
// ⛔ ET LA RECONSTRUCTION NE DOIT RIEN SAVOIR DU FUTUR. Le predecesseur est juge avec `outcomeKnownAt`
// A L'INSTANT ou le token courant apparait, pas avec son issue d'aujourd'hui. Les deux versions sont
// calculees et comparees: si elles different, la seconde fuit de l'information et ne vaut rien.
//
// ⚠️ CE QU'IL PEUT PROUVER: les taux des trois groupes, leurs bornes, leurs financeurs distincts.
// ⛔ CE QU'IL NE PEUT PAS: dire qu'un symbole partage designe un meme operateur. Deux equipes peuvent
// lancer « PEPE » sans se connaitre. STRUCTURE, jamais intention.
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
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU (' + p.effectif + ')' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* ── RECONSTRUCTION DES PREDECESSEURS, comme le fait le radar: meme symbole, vu AVANT ────────────── */
const parSym = new Map();
for (const t of rows) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) continue;
  if (!parSym.has(s)) parSym.set(s, []);
  parSym.get(s).push({ ...t, _d: d });
}
for (const v of parSym.values()) v.sort((a, b) => a._d - b._d);

/** @param futur si true, juge le predecesseur avec son issue d AUJOURD HUI (fuite d information). */
function groupe(t, futur) {
  const s = t.sym, d = Date.parse(t.firstSeen);
  if (!s || !Number.isFinite(d)) return null;
  const prec = (parSym.get(s) || []).filter((p) => p._d < d && p.addr !== t.addr);
  if (!prec.length) return 'C';
  const rugge = prec.some((p) => (futur ? issue(p) === 'rugged' : outcomeKnownAt(p, d, maturityH) === 'rugged'));
  return rugge ? 'A' : 'B';
}

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { n: g.length, res: res.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}

/* ── D'ABORD: MA RECONSTRUCTION CORRESPOND-ELLE AU CHAMP PERSISTE ? ──────────────────────────────── */
const persiste = (t) => t.relaunchOfRugged !== undefined;
const reconstruitA = rows.filter((t) => groupe(t, true) === 'A');
const accord = reconstruitA.filter(persiste).length;
console.log('\n  ── LA RECONSTRUCTION SE VERIFIE CONTRE LE CHAMP PERSISTE ──\n');
console.log('    tokens portant `relaunchOfRugged`        ' + rows.filter(persiste).length);
console.log('    tokens reconstruits en groupe A          ' + reconstruitA.length);
console.log('    accord                                   ' + accord);
if (!reconstruitA.length || accord / reconstruitA.length < 0.8) {
  console.log('\n  ⛔ MA RECONSTRUCTION NE REPRODUIT PAS LE CHAMP. Rien ne se publie: comparer des groupes');
  console.log('     que je definis autrement que le radar mesurerait ma propre definition, pas la sienne.');
  process.exit(0);
}
console.log('  ⚠️ L accord n est pas parfait par construction: le radar n a ecrit le champ qu a partir du');
console.log('     jour ou il existait, et il juge le predecesseur avec l issue qu il connaissait ALORS.');

/* ── LE CONTROLE QUI MANQUAIT ────────────────────────────────────────────────────────────────────── */
for (const futur of [false, true]) {
  const A = mesure(rows.filter((t) => groupe(t, futur) === 'A'));
  const B = mesure(rows.filter((t) => groupe(t, futur) === 'B'));
  const C = mesure(rows.filter((t) => groupe(t, futur) === 'C'));
  console.log('\n  ── ' + (futur ? 'VERSION QUI FUIT (predecesseur juge avec son issue D AUJOURD HUI)'
    : 'VERSION HONNETE (predecesseur juge a l instant du token courant)') + ' ──\n');
  console.log('    groupe                                   res    rug   taux par token           fin.  par tirage');
  console.log('    ' + '-'.repeat(106));
  for (const [nom, m] of [['A  symbole vu, predecesseur RUGGE', A],
    ['B  symbole vu, AUCUN predecesseur rugge', B], ['C  symbole jamais vu', C]]) {
    console.log('    ' + nom.padEnd(40) + String(m.res).padStart(5) + String(m.rug).padStart(7) + '   '
      + ic(m.brut).padEnd(24) + String(m.fN).padStart(5) + '  ' + ic(m.tirage));
  }
  if (A.brut.taux !== null && B.brut.taux !== null) {
    const d = 100 * (A.brut.taux - B.brut.taux);
    console.log('\n    A contre B (LE test): ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
      + (disjoints(A.brut, B.brut) ? '💎 DISJOINTS — la qualification « rugge » porte quelque chose'
        : '⛔ CHEVAUCHANTS — « rugge » n ajoute rien a « deja vu »'));
  }
  if (B.brut.taux !== null && C.brut.taux !== null) {
    const d = 100 * (B.brut.taux - C.brut.taux);
    console.log('    B contre C (la repetition seule): ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
      + (disjoints(B.brut, C.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants'));
  }
}

/* ── ET LA CLE ELLE-MEME: des symboles generiques peuvent lier des tokens sans rapport ───────────── */
console.log('\n  ── LA CLE EST UN SYMBOLE, ET UN SYMBOLE PEUT SE CROISER ──\n');
const courts = rows.filter((t) => t.sym && String(t.sym).length <= 3);
const longs = rows.filter((t) => t.sym && String(t.sym).length > 3);
for (const [nom, pop] of [['symboles <= 3 caracteres', courts], ['symboles > 3 caracteres', longs]]) {
  const A = mesure(pop.filter((t) => groupe(t, false) === 'A'));
  const B = mesure(pop.filter((t) => groupe(t, false) === 'B'));
  if (!A.res || !B.res) { console.log('    ' + nom.padEnd(26) + '⛔ un groupe vide'); continue; }
  const d = 100 * (A.brut.taux - B.brut.taux);
  console.log('    ' + nom.padEnd(26) + 'A ' + (A.rug + '/' + A.res).padStart(9) + ' ' + ic(A.brut).padEnd(24)
    + ' B ' + (B.rug + '/' + B.res).padStart(8) + ' ' + ic(B.brut).padEnd(24)
    + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts ' + (disjoints(A.brut, B.brut) ? '💎' : '⚠️'));
}
console.log('  ⚠️ Un symbole court se croise plus facilement entre equipes sans rapport. Si l ecart ne');
console.log('     tient que sur les symboles courts, la cle lie du hasard plutot que des relancements.');

/* ── LA SYNTHESE, AVEC CE QUI EST ETABLI ET CE QUI NE L EST PAS ──────────────────────────────────── */
{
  const A = mesure(rows.filter((t) => groupe(t, false) === 'A'));
  const B = mesure(rows.filter((t) => groupe(t, false) === 'B'));
  const C = mesure(rows.filter((t) => groupe(t, false) === 'C'));
  console.log('\n  ── CE QUI EST ETABLI, ET A QUELLE UNITE ──\n');
  console.log('    A contre B, par TOKEN     ' + (disjoints(A.brut, B.brut) ? 'ETABLI' : 'non etabli')
    + '   — la qualification « rugge » n est pas un synonyme de « deja vu »');
  console.log('    A contre B, par TIRAGE    ' + (B.tirage.taux === null
    ? 'IMPOSSIBLE — B ne porte que ' + B.fN + ' financeur(s), sous le plancher de ' + MIN_RESOLUS
    : (disjoints(A.tirage, B.tirage) ? 'ETABLI' : 'non etabli')));
  console.log('    A contre C, par TIRAGE    ' + (disjoints(A.tirage, C.tirage) ? 'ETABLI' : 'non etabli')
    + '   ' + ic(A.tirage) + ' contre ' + ic(C.tirage));
  console.log('\n  ⚠️ ET LE GROUPEMENT DE A EST EXTREME: ' + A.res + ' tokens resolus derriere seulement '
    + A.fN + ' financeurs');
  console.log('     (' + (A.res / A.fN).toFixed(1) + ' par financeur). Son intervalle par tirage est large pour cette raison,');
  console.log('     et c est lui qui compte — pas l intervalle par token, flatteusement etroit.');
}

console.log('\n  ⛔ STRUCTURE, JAMAIS INTENTION. Un symbole partage ne designe pas un operateur: deux equipes');
console.log('     peuvent lancer « PEPE » sans se connaitre. Ce qui est mesure ici est la reapparition');
console.log('     d une chaine de caracteres, rien d autre.');
console.log('  ⛔ ET LE CONTROLE B EST LE SEUL QUI TRANCHE. Comparer A a « pas de predecesseur » (C) ne dit');
console.log('     rien: les deux different aussi par la repetition. Seul B isole la qualification.\n');
