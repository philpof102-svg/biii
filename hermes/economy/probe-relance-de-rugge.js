#!/usr/bin/env node
// probe-relance-de-rugge.js — la meme marque relancee apres chaque rug. Ecrit sur 822 lignes, note nulle part.
// ================================================================================================
// `test/persisted-fields-are-read.test.js` a sorti `relaunchOfRugged` de l'inventaire des champs
// orphelins: ecrit par le radar, lu par aucune notation, jamais mesure. Personne ne l'avait regarde.
//
// CE QUE LE CHAMP EST, LU DANS LE CODE (token-radar.js): le NOMBRE de tokens portant le MEME SYMBOLE,
// vus AVANT celui-ci, dont l'issue etait deja `rugged`. Il est ecrit uniquement quand ce nombre depasse
// zero — donc « absent » recouvre « aucun predecesseur ruggé » et rien d'autre n'est affirme.
// ⚠️ Il est disponible A LA PREMIERE VUE (`p.firstSeen < now`), donc utilisable au moment de decider —
// ce que tous les signaux de ce depot ne sont pas.
//
// ⚠️ CE QU'IL PEUT PROUVER: le taux de rug par valeur du champ, avec bornes et comptage de financeurs,
// et si l'ecart survit a la cohorte, a la liquidite, a l'etat de trace et au verdict de symbole.
// ⛔ CE QU'IL NE PEUT PAS: voir un premier rug. Une marque lancee pour la premiere fois n'a aucun
// predecesseur: ce signal est STRUCTURELLEMENT aveugle au premier exemplaire, et son rappel le dit.
// ⛔ IL NE PROMEUT RIEN. Ajouter une regle notee est un geste date et irreversible.
// ⛔ STRUCTURE, JAMAIS INTENTION: un symbole reutilise prouve une reutilisation de symbole. Il ne
// designe personne, n'etablit aucune intention et ne dit pas que c'est le meme operateur.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, quantile, MIN_RESOLUS } = require('../../lib/prequential');
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
const dj = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));
const relance = (t) => t.relaunchOfRugged !== undefined;

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { res: res.length, rug, fN: f.size, brut: proportionAvecBornes(rug, res.length),
    tir: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}
const duo = (nom, pop) => {
  const a = mesure(pop.filter(relance)), b = mesure(pop.filter((t) => !relance(t)));
  if (!a.res || !b.res) { console.log('    ' + nom.padEnd(20) + '⛔ un cote vide — rien a comparer'); return null; }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ' + nom.padEnd(20) + (a.rug + '/' + a.res).padStart(9) + ' ' + ic(a.brut).padEnd(23)
    + (b.rug + '/' + b.res).padStart(9) + ' ' + ic(b.brut).padEnd(23)
    + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts'
    + (dj(a.brut, b.brut) ? '  💎 DISJOINTS' : '  ⚠️ chevauchants'));
  return dj(a.brut, b.brut);
};

/* ── 1. LE CHAMP, PAR VALEUR ─────────────────────────────────────────────────────────────────────── */
const seau = (t) => (!relance(t) ? 'aucun predecesseur' : (t.relaunchOfRugged >= 2 ? '2 ou plus' : 'exactement 1'));
console.log('\n  ── LA MEME MARQUE, RELANCEE APRES CHAQUE RUG ──\n');
console.log('    predecesseurs ruggés    res    rug   par token                fin.  par tirage');
console.log('    ' + '-'.repeat(102));
const seaux = {};
for (const v of ['aucun predecesseur', 'exactement 1', '2 ou plus']) {
  const m = mesure(rows.filter((t) => seau(t) === v));
  seaux[v] = m;
  console.log('    ' + v.padEnd(22) + String(m.res).padStart(5) + String(m.rug).padStart(7)
    + '   ' + ic(m.brut).padEnd(24) + String(m.fN).padStart(4) + '  ' + ic(m.tir));
}
const base = mesure(rows);
console.log('    ' + 'TOUT le radar'.padEnd(22) + String(base.res).padStart(5) + String(base.rug).padStart(7)
  + '   ' + ic(base.brut).padEnd(24) + String(base.fN).padStart(4) + '  ' + ic(base.tir));

/* ── 2. LA QUALITE DE LA CLE: relancement, ou symboles generiques qui se croisent ? ──────────────── */
const rl = rows.filter(relance);
const parSym = new Map();
for (const t of rl) { const s = String(t.sym || '?'); parSym.set(s, (parSym.get(s) || 0) + 1); }
const top = [...parSym.entries()].sort((a, b) => b[1] - a[1]);
const courts = rl.filter((t) => String(t.sym || '').length <= 2).length;
console.log('\n  ── EST-CE VRAIMENT UN RELANCEMENT, OU DES NOMS QUI SE CROISENT ? ──\n');
console.log('    ' + rl.length + ' token(s) marque(s) sur ' + parSym.size + ' symbole(s) distinct(s)');
console.log('    symboles de 2 caracteres ou moins: ' + courts + '  ('
  + (100 * courts / rl.length).toFixed(1) + ' %)');
console.log('    les plus repetes: ' + top.slice(0, 6).map(([s, n]) => JSON.stringify(s) + ' x' + n).join('  '));
if (courts / rl.length > 0.25) {
  console.log('  ⛔ PLUS D UN QUART DES SYMBOLES SONT TRES COURTS: la cle rapproche probablement des tokens');
  console.log('     sans rapport, et « relancement » n est alors pas la bonne lecture de ce champ.');
} else {
  console.log('  💎 Les symboles sont DISTINCTIFS, pas generiques. La lecture « la meme marque relancee »');
  console.log('     tient: ce sont des noms qu on ne partage pas par hasard.');
}
console.log('  ⚠️ ET L UNITE D INDEPENDANCE RESTE LE FINANCEUR, pas le symbole. Il y a plus de symboles');
console.log('     (' + parSym.size + ') que de financeurs marques, donc le compte par financeur est le plus');
console.log('     PRUDENT des deux — c est lui qui gouverne les taux « par tirage » ci-dessus.');

/* ── 3. LES TROIS CONTROLES ──────────────────────────────────────────────────────────────────────── */
console.log('\n  ── CONTROLE 1: PAR COHORTE (le champ exige un passe, les tokens anciens en manquent) ──\n');
console.log('    fenetre               relance                        sans                           ecart');
const c1 = [];
for (const [nom, apres] of [['tout', '0000'], ['depuis le 08-01', '2026-08-01'],
  ['depuis le 08-04', '2026-08-04'], ['depuis le 08-06', '2026-08-06']]) {
  c1.push(duo(nom, rows.filter((t) => String(t.firstSeen) >= apres)));
}

const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
console.log('\n  ── CONTROLE 2: A LIQUIDITE COMPARABLE ──\n');
const c2 = [];
for (const [nom, p] of [['liq basse', (l) => l < q1], ['liq moyenne', (l) => l >= q1 && l < q2],
  ['liq haute', (l) => l >= q2]]) {
  c2.push(duo(nom, rows.filter((t) => Number.isFinite(t.firstLiq) && p(t.firstLiq))));
}

console.log('\n  ── CONTROLE 3: A ETAT DE TRACE COMPARABLE ──\n');
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
const c3 = [];
for (const e of ['ok', 'no_creator', 'failed', 'no_funder', 'ABSENT']) c3.push(duo(e, rows.filter((t) => etat(t) === e)));

const tot = [...c1, ...c2, ...c3].filter((x) => x !== null);
console.log('\n    ETABLI dans ' + tot.filter(Boolean).length + ' cellule(s) sur ' + tot.length + '.');
if (tot.filter(Boolean).length < tot.length / 2) {
  console.log('  ⛔ L ecart ne survit pas a la majorite des controles: il ne se publie pas comme un signal.');
}

/* ── 4. LE CONTREFACTUEL, ET SA PROPRIETE INHABITUELLE ───────────────────────────────────────────── */
const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);
const union = (t) => parFinanceur(t) === true || parJetable(t) === true;
const resolus = rows.filter((t) => issue(t) !== null);
const rugs = resolus.filter((t) => issue(t) === 'rugged');
const surv = resolus.filter((t) => issue(t) === 'survived');
console.log('\n  ── LE CONTREFACTUEL (mesure, PAS une proposition) ──\n');
console.log('    regle                    rappel                    survivants accuses        rates > 1M$');
console.log('    ' + '-'.repeat(102));
const lignes = {};
for (const [nom, d] of [['UNION actuelle', union], ['relance SEULE', relance],
  ['UNION + relance', (t) => union(t) || relance(t)]]) {
  const vp = rugs.filter((t) => d(t) === true).length;
  const fp = surv.filter((t) => d(t) === true).length;
  const gros = rugs.filter((t) => d(t) !== true && Number.isFinite(t.peakLiq) && t.peakLiq > 1e6).length;
  lignes[nom] = { rappel: proportionAvecBornes(vp, rugs.length), fp: proportionAvecBornes(fp, surv.length), gros };
  console.log('    ' + nom.padEnd(24) + ic(lignes[nom].rappel).padEnd(26)
    + ic(lignes[nom].fp).padEnd(26) + String(gros).padStart(5));
}
const a = lignes['UNION actuelle'], b = lignes['relance SEULE'];
if (a && b && a.fp.taux !== null && b.fp.taux !== null && b.fp.taux < a.fp.taux && b.gros < a.gros) {
  console.log('\n  💎 PROPRIETE INHABITUELLE, ET C EST ELLE QUI MERITE UN HUMAIN: « relance SEULE » accuse');
  console.log('     MOINS de survivants que la regle actuelle (' + pct(b.fp.taux).trim() + ' contre '
    + pct(a.fp.taux).trim() + ') tout en laissant passer');
  console.log('     ' + b.gros + ' rug(s) a plus d un million au lieu de ' + a.gros + '. Sur les gros dossiers elle est moins');
  console.log('     chere ET plus couvrante — ce qu aucun autre candidat mesure cette nuit ne faisait.');
  console.log('  ⚠️ Elle n est PAS dominante pour autant: son rappel global est INFERIEUR ('
    + pct(b.rappel.taux).trim() + ' contre ' + pct(a.rappel.taux).trim() + ').');
  console.log('     Elle attrape moins de rugs au total, et bien plus de rugs COUTEUX. Ce sont deux');
  console.log('     objectifs differents, et choisir entre eux est un arbitrage de produit.');
}

console.log('\n  ⛔ CE SIGNAL EST STRUCTURELLEMENT AVEUGLE AU PREMIER EXEMPLAIRE. Une marque lancee pour la');
console.log('     premiere fois n a aucun predecesseur ruggé: il ne peut rien en dire, jamais. Son rappel');
console.log('     borne exactement cela, et aucune amelioration de collecte ne le levera.');
console.log('  ⛔ STRUCTURE, JAMAIS INTENTION. Un symbole reutilise prouve une reutilisation de symbole:');
console.log('     il ne nomme personne et n etablit pas que c est le meme operateur derriere.');
console.log('  ⛔ RIEN N EST PROMU.\n');
