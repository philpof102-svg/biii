#!/usr/bin/env node
// probe-qui-merite-une-annonce.js — les trois candidats restants meritent-ils un pari, ou faut-il dire
// qu'ils n'en meritent pas ?
// ================================================================================================
// `thin` a ete annonce le 2026-08-09 apres avoir passe quatre epreuves. Les trois autres champs ecrits
// par le radar et jamais notes — `funderTrace`, `freshDeployer`, `relaunchOfRugged` — n'ont jamais subi
// la meme batterie d'un bout a l'autre. Les annoncer sans ca serait promouvoir sur une impression; ne
// rien dire les laisserait en dette perpetuelle. « Aucun ne merite une annonce » est un RESULTAT.
//
// LA BATTERIE, la meme pour tous, dans cet ordre:
//   T1  separe-t-il sur la POPULATION ENTIERE ? (informatif seulement: ce terrain est sature a 83 %)
//   T2  separe-t-il DANS la branche « sur » ? (le seul terrain ou il reste de la marge)
//   T3  survit-il au retrait des TROIS plus gros financeurs ? (ils portent 41 % du terrain)
//   T4  les DEUX cotes depassent-ils le plancher de vingt tirages ?
// Un pari se justifie si T2 ET T3 ET T4. T1 est publie mais ne decide rien — un plafond ne prouve pas.
//
// ⛔ ET `thin` EST INCLUS COMME TEMOIN. Il est deja annonce, donc il DOIT passer. S'il echoue ici, c'est
// la batterie qui est cassee, pas lui — et on l'apprend avant de recaler les trois autres avec.
//
// ⛔ `relance` N'EST PAS LU DANS LE CHAMP PERSISTE. `relaunchOfRugged` est un COMPTE reecrit a chaque
// scan: un token dont les predecesseurs ruggent APRES son lancement verrait son compte grandir, et la
// lecture regarderait le futur. La reconstruction ci-dessous est copiee telle quelle de
// `probe-tous-candidats-par-operateur.js:46-60`, ou elle a ete ecrite pour ne juger qu'avec le savoir
// disponible a la date du token.
//
// ⛔ ELLE NE PROMEUT NI NE RETIRE RIEN: annoncer un pari est une decision produit. Aucune adresse.
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

/* Copie conforme de probe-tous-candidats-par-operateur.js:46-60 — l'index sur TOUTE la population. */
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
  ['thin (TEMOIN, deja annonce)', (t) => (typeof t.symbolVerdict !== 'string'
    || t.symbolVerdict === 'not_a_candidate' || t.symbolVerdict === 'unknown' ? null : t.symbolVerdict === 'thin')],
  ['no_creator', (t) => (typeof t.funderTrace !== 'string' ? null : t.funderTrace === 'no_creator')],
  ['jetable', (t) => (typeof t.freshDeployer !== 'boolean' ? null : t.freshDeployer === true)],
  ['relance', relanceEtat],
];

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  return { res: res.length, rug, fN: new Set(res.map(fnd).filter(Boolean)).size,
    brut: proportionAvecBornes(rug, res.length) };
}
/* La garde de saturation, reprise des sondes precedentes: un ecart se lit contre la marge qui restait. */
function compare(M, C) {
  if (!M.res || !C.res) return null;
  const d = 100 * (M.brut.taux - C.brut.taux);
  const ref = M.brut.taux < C.brut.taux ? M.brut : C.brut;
  const marge = 100 * (1 - ref.taux);
  const largeur = Math.max(100 * (M.brut.haute - M.brut.basse), 100 * (C.brut.haute - C.brut.basse));
  return { d, marge, sature: marge < largeur, disj: disjoints(M.brut, C.brut), M, C };
}
const rendu = (r) => (r === null ? '(un cote vide)'.padEnd(30)
  : (((r.d >= 0 ? '+' : '') + r.d.toFixed(1) + '/' + r.marge.toFixed(0) + ' '
    + (r.sature ? 'SAT' : r.disj ? 'DISJ' : 'chev')).padEnd(30)));

const sur = toutes.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL);
const parF = new Map();
for (const t of sur.filter((x) => issue(x) !== null)) { const f = fnd(t); if (f) parF.set(f, (parF.get(f) || 0) + 1); }
const gros = new Set([...parF.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]));

console.log('\n  ── LA BATTERIE, LA MEME POUR TOUS ──\n');
console.log('    T1 population entiere · T2 branche « sur » · T3 sans les 3 plus gros · T4 plancher de '
  + MIN_RESOLUS + ' tirages');
console.log('    ecart/marge et etiquette: DISJ = etabli · chev = non etabli · SAT = rien ne POUVAIT apparaitre\n');
console.log('    lecture                        T1                  T2                  T3                  conserve');
console.log('    ' + '-'.repeat(118));

const bilan = [];
for (const [nom, lit] of LECTURES) {
  const surGroupe = (g) => compare(mesure(g.filter((t) => lit(t) === true)), mesure(g.filter((t) => lit(t) === false)));
  const t1 = surGroupe(toutes);
  const t2 = surGroupe(sur);
  const t3 = surGroupe(sur.filter((t) => !gros.has(fnd(t))));
  /* ⛔ LA FRACTION CONSERVEE EST CE QUI TRANCHE T3, PAS L'ETIQUETTE. Retirer des lignes ELARGIT les
   * intervalles: une comparaison peut basculer en « SAT » sans que l'ecart bouge. Sans cette colonne,
   * « l'effet s'est effondre » et « il ne reste plus assez de lignes » se lisent pareil — et ce depot a
   * deja failli publier l'un pour l'autre aujourd'hui meme. */
  const garde = (t2 && t3 && t2.d) ? (100 * t3.d / t2.d) : null;
  const col = garde === null ? '   —' : garde.toFixed(0).padStart(4) + ' %'
    + (garde >= 50 ? '  effet TIENT' : '  effet TOMBE');
  console.log('    ' + nom.padEnd(30) + rendu(t1).slice(0, 20) + rendu(t2).slice(0, 20) + rendu(t3).slice(0, 20) + col);
  bilan.push([nom, t1, t2, t3, garde]);
}

console.log('\n  ── T4: LES DEUX COTES DEPASSENT-ILS LE PLANCHER, DANS LA BRANCHE « SUR » ? ──\n');
console.log('    lecture                        marques   compl.   financeurs (marq/compl)   T4');
console.log('    ' + '-'.repeat(100));
const t4s = new Map();
for (const [nom, lit] of LECTURES) {
  const M = mesure(sur.filter((t) => lit(t) === true)), C = mesure(sur.filter((t) => lit(t) === false));
  const ok = M.fN >= MIN_RESOLUS && C.fN >= MIN_RESOLUS;
  t4s.set(nom, ok);
  console.log('    ' + nom.padEnd(30) + String(M.res).padStart(7) + String(C.res).padStart(9)
    + '        ' + (M.fN + ' / ' + C.fN).padEnd(18) + (ok ? '✅ oui' : '⛔ non'));
}

console.log('\n  ── LE VERDICT: QUI MERITE UN PARI ? ──\n');
let temoinOk = null;
for (const [nom, t1, t2, t3, garde] of bilan) {
  const passeT2 = !!(t2 && t2.disj && !t2.sature);
  const passeT3 = !!(t3 && t3.disj && !t3.sature);
  const passeT4 = t4s.get(nom);
  const merite = passeT2 && passeT3 && passeT4;
  if (/TEMOIN/.test(nom)) temoinOk = merite;
  const detail = 'T2 ' + (passeT2 ? '✅' : '⛔') + ' · T3 ' + (passeT3 ? '✅' : '⛔') + ' · T4 ' + (passeT4 ? '✅' : '⛔');
  console.log('    ' + nom.padEnd(30) + detail.padEnd(28) + (merite ? '💎 MERITE une annonce' : '⛔ n en merite PAS'));
  if (t2 === null) console.log('      ⚠️ un cote VIDE dans la branche « sur »: cette lecture ne peut pas y agir du tout — un resultat, pas un oubli');
}

console.log('');
if (temoinOk === false) {
  console.log('  ⛔⛔ LE TEMOIN ECHOUE. `thin` est deja annonce et devrait passer: c est la BATTERIE qui est');
  console.log('       cassee, pas les candidats. Aucun verdict ci-dessus ne compte tant que ce n est pas regle.');
} else if (temoinOk === true) {
  console.log('  ✅ Le temoin passe: la batterie sait dire oui, donc ses « non » ne sont pas un refus systematique.');
}
console.log('  ⚠️ T3 merite sa nuance: retirer des lignes ELARGIT les intervalles, donc un echec en T3 peut');
console.log('     etre un manque de puissance plutot qu un effet disparu. La colonne T3 imprime l ecart a');
console.log('     cote de la fraction CONSERVEE: sous 50 %, l effet est bien tombe; au-dessus, ce sont les lignes.');
console.log('  ⛔ ET RIEN N EST PROMU. « Merite une annonce » veut dire « passe la batterie », pas « doit etre');
console.log('     annonce » — ecrire un pari engage ce depot vers l avant et reste une decision produit.');
console.log('  ⛔ Aucune adresse imprimee.\n');
