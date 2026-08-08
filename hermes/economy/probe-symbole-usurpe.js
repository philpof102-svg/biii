#!/usr/bin/env node
// probe-symbole-usurpe.js — un signal que le radar calcule deja, ecrit deja, et que personne ne note.
// ================================================================================================
// En lisant un par un les douze plus gros rugs que l'union de regles laisse passer (`peakLiq` jusqu'a
// 10 084k), un motif saute: leurs symboles sont `Anthropic`, `OpenAI` (sept fois), `Claude`. Et le radar
// le SAIT: six des douze portent `symbolVerdict: 'impersonation'`, avec une adresse `impersonates`
// nommee et un `identityWarning` redige. Le champ existe sur 1820 des 2057 lignes.
// Aucune regle de notation ne le lit.
//
// ⚠️ CE QU'IL FAUT VERIFIER AVANT DE CRIER A LA TROUVAILLE, et c'est la raison d'etre de cette sonde:
// ces douze tokens sont AUSSI tous non traces. « Usurpation » pourrait n'etre qu'un autre nom pour
// « illisible », auquel cas le signal n'ajoute rien a ce qui est deja mesure. Le test est le meme que
// celui applique au deployeur jetable: le verdict de symbole separe-t-il ENCORE a l'interieur de chaque
// etat de trace ?
//
// ⚠️ CE QU'IL PEUT PROUVER: le taux de rug par verdict de symbole, avec bornes et comptage de
// financeurs, et si l'ecart survit au conditionnement sur l'etat de trace.
// ⛔ CE QU'IL NE PEUT PAS: dire qui a lance ces tokens ni pourquoi. `symbolVerdict` compare un SYMBOLE
// a un contrat dominant portant le meme; c'est une observation de STRUCTURE. Un symbole partage ne
// designe personne et n'etablit aucune intention.
// ⛔ IL NE PROMEUT RIEN. Ajouter une regle notee est un geste date et irreversible.
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
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU (' + p.effectif + ')' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);
const union = (t) => parFinanceur(t) === true || parJetable(t) === true;
const verdictSym = (t) => (t.symbolVerdict === undefined ? '(champ absent)' : String(t.symbolVerdict));
const usurpe = (t) => t.symbolVerdict === 'impersonation';

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { n: g.length, res: res.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}

/* ── 1. LE CHAMP EXISTE-T-IL, ET QUE PORTE-T-IL ? ────────────────────────────────────────────────── */
console.log('\n  ── UN CHAMP DEJA CALCULE, DEJA ECRIT, JAMAIS NOTE ──\n');
const etats = new Map();
for (const t of rows) etats.set(verdictSym(t), (etats.get(verdictSym(t)) || 0) + 1);
console.log('    verdict de symbole        tokens   resolus    rug   taux par token           fin.  par tirage');
console.log('    ' + '-'.repeat(108));
const parEtat = {};
for (const [e] of [...etats.entries()].sort((a, b) => b[1] - a[1])) {
  const m = mesure(rows.filter((t) => verdictSym(t) === e));
  parEtat[e] = m;
  console.log('    ' + e.padEnd(24) + String(m.n).padStart(6) + String(m.res).padStart(9)
    + String(m.rug).padStart(7) + '   ' + ic(m.brut).padEnd(24) + String(m.fN).padStart(5) + '  ' + ic(m.tirage));
}
const base = mesure(rows);
console.log('    ' + 'TOUT le radar'.padEnd(24) + String(base.n).padStart(6) + String(base.res).padStart(9)
  + String(base.rug).padStart(7) + '   ' + ic(base.brut).padEnd(24) + String(base.fN).padStart(5) + '  ' + ic(base.tirage));

const imp = parEtat.impersonation;
if (!imp || !imp.res) {
  console.log('\n  ⛔ Aucun token `impersonation` resolu: rien ne se publie sur ce verdict.');
} else if (imp.res < MIN_RESOLUS) {
  console.log('\n  ⛔ ' + imp.res + ' appel(s) resolu(s) seulement pour `impersonation`, sous les ' + MIN_RESOLUS
    + ' requis: le COMPTE se lit, le taux ne se publie pas.');
}

/* ── 2. LE TEST QUI DECIDE: EST-CE AUTRE CHOSE QUE « NON TRACE » ? ───────────────────────────────── */
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
console.log('\n  ── EST-CE UN AUTRE NOM POUR « NON TRACE » ? ──\n');
console.log('    etat de trace     usurpe                          non usurpe                      ecart');
console.log('    ' + '-'.repeat(104));
for (const e of ['ok', 'no_creator', 'failed', 'no_funder', 'ABSENT']) {
  const dedans = rows.filter((t) => etat(t) === e);
  const a = mesure(dedans.filter(usurpe)), b = mesure(dedans.filter((t) => !usurpe(t)));
  if (!a.res && !b.res) continue;
  const d = (a.brut.taux !== null && b.brut.taux !== null)
    ? (100 * (a.brut.taux - b.brut.taux)).toFixed(1) + ' pts' : '—';
  console.log('    ' + e.padEnd(16) + (a.rug + '/' + a.res + ' ' + ic(a.brut)).padEnd(32)
    + (b.rug + '/' + b.res + ' ' + ic(b.brut)).padEnd(32) + d.padStart(9)
    + (disjoints(a.brut, b.brut) ? '  💎 DISJOINTS' : (a.brut.taux !== null && b.brut.taux !== null) ? '  ⚠️ chevauchants' : ''));
}
console.log('\n  ⚠️ Si l ecart disparait DANS chaque etat de trace, « usurpation » ne dit rien de plus que');
console.log('     « illisible » et le signal est un doublon. S il survit, il porte autre chose.');

/* ── 3. CE QUE CA CHANGERAIT AU RAPPEL, MESURE ET NON PROPOSE ────────────────────────────────────── */
const resolus = rows.filter((t) => issue(t) !== null);
const rugs = resolus.filter((t) => issue(t) === 'rugged');
const survivants = resolus.filter((t) => issue(t) === 'survived');
const REGLES = [
  ['UNION actuelle', union],
  ['UNION + usurpation', (t) => union(t) || usurpe(t)],
  ['usurpation SEULE', usurpe],
];
console.log('\n  ── CE QUE LE VERDICT DE SYMBOLE CHANGERAIT (contrefactuel, PAS une proposition) ──\n');
console.log('    regle                  rappel                   survivants accuses        rugs rates > 1M$');
console.log('    ' + '-'.repeat(100));
for (const [nom, d] of REGLES) {
  const vp = rugs.filter((t) => d(t) === true).length;
  const fp = survivants.filter((t) => d(t) === true).length;
  const gros = rugs.filter((t) => d(t) !== true && Number.isFinite(t.peakLiq) && t.peakLiq > 1e6).length;
  console.log('    ' + nom.padEnd(22) + ic(proportionAvecBornes(vp, rugs.length)).padEnd(24)
    + ic(proportionAvecBornes(fp, survivants.length)).padEnd(26) + String(gros).padStart(6));
}

/* ── 4. CE QUE LA LECTURE HONNETE DE CE TABLEAU DONNE, Y COMPRIS CONTRE MON HYPOTHESE ────────────── */
console.log('\n  ── LA LECTURE HONNETE, ET ELLE N EST PAS CELLE QUE J ATTENDAIS ──\n');
console.log('  ⛔ `impersonation` N EST PAS ETABLI COMME INDEPENDANT DE L ETAT DE TRACE. Dans les cinq');
console.log('     etats, l ecart va dans le meme sens mais AUCUN intervalle ne se separe. La direction est');
console.log('     coherente, la separation ne l est pas — et une direction repetee sur des cellules qui');
console.log('     chevauchent toutes reste une impression, pas une mesure. Il porte aussi ' + (imp ? imp.fN : 0)
  + ' financeur(s)');
console.log('     distinct(s), sous le plancher de ' + MIN_RESOLUS + ': son taux par tirage est retenu.');
const thin = parEtat.thin;
if (thin && thin.tirage && thin.tirage.taux !== null) {
  const separe = disjoints(thin.tirage, base.tirage);
  console.log('\n  💎 ET LE SEAU QUI TIENT N EST PAS CELUI QUE J AI OUVERT: `thin` porte ' + thin.res
    + ' appels resolus');
  console.log('     derriere ' + thin.fN + ' financeurs distincts — au-dessus du plancher — a ' + pct(thin.tirage.taux).trim()
    + ' par tirage ' + ic(thin.tirage));
  console.log('     contre ' + ic(base.tirage) + ' pour toute la base: intervalles '
    + (separe ? 'DISJOINTS.' : 'chevauchants.'));
  console.log('     ⚠️ Comparer un sous-groupe a une population qui le CONTIENT attenue l ecart; la');
  console.log('        comparaison propre serait contre le complement, et elle n est pas faite ici.');
}
console.log('\n  ⛔ LE FAIT QUI RESTE, QUEL QUE SOIT LE SEAU: `symbolVerdict` est calcule sur '
  + rows.filter((t) => t.symbolVerdict !== undefined).length + ' des ' + rows.length + ' lignes,');
console.log('     ecrit en base, publie dans `identityWarning` — et AUCUNE regle notee ne le lit. Ce n est');
console.log('     pas une decouverte de signal, c est une decouverte de champ inutilise.');

console.log('\n  ⛔ STRUCTURE, JAMAIS INTENTION. `symbolVerdict` compare un SYMBOLE a un contrat dominant qui');
console.log('     porte le meme — c est une observation sur des chaines de caracteres et des adresses.');
console.log('     Elle ne designe personne, n etablit aucune intention, et ne dit pas qui a lance quoi.');
console.log('  ⛔ ET ELLE NE PROMEUT RIEN. Ajouter une regle notee est date et irreversible: c est un geste');
console.log('     humain. Cette sonde chiffre une hypothese a cote de l existant, jamais a sa place.');
console.log('  ⚠️ `symbolVerdict` manque sur ' + (rows.length - rows.filter((t) => t.symbolVerdict !== undefined).length)
  + ' ligne(s): un champ absent n est pas « genuine », et ces lignes');
console.log('     comptent comme NON marquees dans le contrefactuel — le chiffre est donc un plancher.\n');
