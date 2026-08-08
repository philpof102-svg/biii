#!/usr/bin/env node
// probe-frontiere-et-surajustement.js — la frontiere des combinaisons, et sa fragilite mesuree.
// ================================================================================================
// Quatre marqueurs candidats ont ete mesures separement cette nuit. La suite evidente est de les
// combiner et de garder la meilleure combinaison. C'est exactement ce que ce depot s'interdit:
// `token-radar.js:711` — « Sweeping thresholds and keeping the best is how two rules died here ».
//
// Cette sonde fait donc DEUX choses, et la seconde est la seule qui compte:
//   1. elle publie la frontiere ENTIERE, sans en designer aucune;
//   2. elle la RECALCULE sur une moitie de la population tenue a l'ecart, et montre combien de
//      combinaisons y restent. Un avertissement sur le surajustement se recite; une frontiere qui se
//      reordonne quand on change d'echantillon se MESURE.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: pour chaque combinaison, rappel, part de survivants accuses, et rugs a
// plus d'un million laisses passer — sur deux moities disjointes de la population.
// ⛔ CE QU'ELLE NE PEUT PAS: designer une regle. Une frontiere calculee sur des donnees observees est
// ajustee a ces donnees par construction. La seule lecture honnete est: en choisir UNE, l'annoncer avec
// sa date, et la noter VERS L'AVANT — ce que `gradeAnnounced` existe pour faire.
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
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');

/* Les six lectures. Les deux premieres sont les regles VIVANTES; les quatre autres sont les candidats
 * mesures cette nuit et consommes par personne. */
const MARQUEURS = [
  ['fnd20', (t) => typeof t.siblingCount === 'number' && t.siblingCount >= SEUIL],
  ['jetbl', (t) => t.freshDeployer === true],
  ['relnc', (t) => t.relaunchOfRugged !== undefined],
  ['thin_', (t) => t.symbolVerdict === 'thin'],
  ['nocre', (t) => t.funderTrace === 'no_creator'],
  ['usurp', (t) => t.symbolVerdict === 'impersonation'],
];
const ACTUELLE = 0b000011;   // fnd20 + jetbl

function evalue(masque, pop) {
  const marque = (t) => MARQUEURS.some(([, f], i) => (masque >> i) & 1 && f(t));
  const rugs = pop.filter((t) => issue(t) === 'rugged');
  const surv = pop.filter((t) => issue(t) === 'survived');
  if (!rugs.length || !surv.length) return null;
  const vp = rugs.filter(marque).length;
  const fp = surv.filter(marque).length;
  const gros = rugs.filter((t) => !marque(t) && Number.isFinite(t.peakLiq) && t.peakLiq > 1e6).length;
  return { masque, rappel: vp / rugs.length, accuses: fp / surv.length, gros,
    rappelIC: proportionAvecBornes(vp, rugs.length), accusesIC: proportionAvecBornes(fp, surv.length) };
}
const nom = (m) => MARQUEURS.filter((_, i) => (m >> i) & 1).map(([n]) => n).join('+') || '(aucun)';

/* Frontiere de Pareto sur DEUX objectifs qu'on ne mélange pas: accuser peu, et laisser passer peu de
 * gros rugs. Le rappel global est publie a cote mais n'entre pas dans la domination — il melangerait
 * les petits et les gros, alors que c'est justement la distinction qui interesse. */
function frontiere(pop) {
  const tous = [];
  for (let m = 1; m < (1 << MARQUEURS.length); m++) { const e = evalue(m, pop); if (e) tous.push(e); }
  return tous.filter((a) => !tous.some((b) => b !== a
    && b.accuses <= a.accuses && b.gros <= a.gros
    && (b.accuses < a.accuses || b.gros < a.gros)));
}

const resolus = rows.filter((t) => issue(t) !== null);
console.log('\n  ── LA FRONTIERE, SUR TOUTE LA POPULATION ──');
console.log('     ' + resolus.length + ' token(s) resolu(s)  ·  deux objectifs: accuser PEU, laisser passer peu de GROS');
const act = evalue(ACTUELLE, rows);
const f = frontiere(rows).sort((a, b) => a.accuses - b.accuses);
console.log('\n    combinaison                    accuses                gros rates   rappel');
console.log('    ' + '-'.repeat(96));
for (const e of f) {
  console.log('    ' + nom(e.masque).padEnd(30) + pct(e.accuses) + ' [' + pct(e.accusesIC.basse).trim() + '–'
    + pct(e.accusesIC.haute).trim() + ']'.padEnd(3) + String(e.gros).padStart(8) + '     ' + pct(e.rappel)
    + (e.masque === ACTUELLE ? '   <- REGLE ACTUELLE' : ''));
}
if (!f.some((e) => e.masque === ACTUELLE) && act) {
  console.log('    ' + ('(actuelle) ' + nom(ACTUELLE)).padEnd(30) + pct(act.accuses) + ' [' + pct(act.accusesIC.basse).trim()
    + '–' + pct(act.accusesIC.haute).trim() + ']'.padEnd(3) + String(act.gros).padStart(8) + '     ' + pct(act.rappel)
    + '   ⛔ DOMINEE — hors frontiere');
}

/* ── LE TEST QUI COMPTE: LA FRONTIERE TIENT-ELLE SUR UN AUTRE ECHANTILLON ? ──────────────────────── */
const tries = resolus.filter((t) => Number.isFinite(Date.parse(t.firstSeen)))
  .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
const coupe = Math.floor(tries.length / 2);
const tot = new Set(tries.slice(0, coupe).map((t) => t.addr));
const A = rows.filter((t) => tot.has(t.addr));
const B = rows.filter((t) => !tot.has(t.addr) && issue(t) !== null);
console.log('\n  ── LE MEME CALCUL SUR DEUX MOITIES DISJOINTES (par date de premiere vue) ──\n');
console.log('    moitie ANCIENNE ' + A.filter((t) => issue(t) !== null).length + ' resolus  ·  moitie RECENTE '
  + B.length + ' resolus');
/* ⛔ AVANT DE LIRE LA STABILITE, VERIFIER QUE LES DEUX MOITIES PEUVENT DISCRIMINER. Une moitie sans
 * gros rug rendrait `gros` constant a zero, toute combinaison y serait « sur la frontiere », et le
 * desaccord entre les deux se lirait comme de l instabilite alors qu il ne serait qu une absence. */
const grosDe = (g) => g.filter((t) => issue(t) === 'rugged' && Number.isFinite(t.peakLiq) && t.peakLiq > 1e6).length;
const survDe = (g) => g.filter((t) => issue(t) === 'survived').length;
const gA = grosDe(A), gB = grosDe(B);
console.log('    gros rugs (>1M$) : ancienne ' + gA + '  ·  recente ' + gB
  + '     survivants: ' + survDe(A) + '  ·  ' + survDe(B));
if (!gA || !gB) {
  console.log('  ⛔ UNE MOITIE N A AUCUN GROS RUG: l objectif « gros rates » y est constant, la frontiere');
  console.log('     y perd son sens et la comparaison ne se publie pas. Ce n est pas de l instabilite.');
  process.exit(0);
}
const fA = frontiere(A), fB = frontiere(B);
const setA = new Set(fA.map((e) => e.masque)), setB = new Set(fB.map((e) => e.masque));
const communes = [...setA].filter((m) => setB.has(m));
console.log('    combinaisons sur la frontiere ANCIENNE : ' + setA.size);
console.log('    combinaisons sur la frontiere RECENTE  : ' + setB.size);
console.log('    presentes sur LES DEUX                 : ' + communes.length
  + '   (' + (communes.length ? communes.map(nom).join(', ') : 'aucune') + ')');

const stabilite = setA.size ? communes.length / Math.max(setA.size, setB.size) : 0;
console.log('\n  ' + (stabilite >= 0.5
  ? '💎 La frontiere est STABLE a ' + (100 * stabilite).toFixed(0) + ' % entre les deux moities: les memes'
    + '\n     combinaisons y reviennent, ce qui est le minimum avant d en annoncer une.'
  : '⛔ LA FRONTIERE SE REORDONNE: seulement ' + (100 * stabilite).toFixed(0) + ' % des combinaisons survivent'
    + '\n     d une moitie a l autre. Choisir « la meilleure » sur la table complete reviendrait a ajuster'
    + '\n     sur du bruit — c est le mecanisme exact qui a tue deux regles de ce depot.'));

console.log('\n  ⛔ ET MEME STABLE, CETTE TABLE NE DESIGNE RIEN. Elle est calculee sur des issues DEJA');
console.log('     connues: toute combinaison y parait bonne parce qu on l a choisie en les regardant.');
console.log('     La seule lecture honnete est d en prendre UNE, de l annoncer avec sa date, et de la');
console.log('     noter VERS L AVANT — ce que `gradeAnnounced` fait pour les six paris existants.');
console.log('  ⛔ LES DEUX OBJECTIFS NE SE SOMMENT PAS: accuser un survivant coute a qui vend, laisser');
console.log('     passer un rug coute a qui achete. La frontiere montre l arbitrage, elle ne le tranche pas.');
console.log('  ⚠️ Le rappel global est publie A COTE et n entre PAS dans la domination: il melange les');
console.log('     petits rugs et les gros, alors que la distinction est precisement ce qui interesse ici.\n');
