#!/usr/bin/env node
// probe-croisement-jetable-financeur.js — deux signaux, ou le meme vu de deux cotes ?
// ================================================================================================
// `probe-deployeur-jetable.js` a mesure que `freshDeployer` separe de 25,0 points par TIRAGE, des deux
// cotes du plancher d'independance. Ce chiffre ne vaut que si le signal apporte une information que le
// depot n'a pas deja: un portefeuille jetable et un financeur industriel peuvent tres bien designer la
// meme operation, l'une vue par le deployeur et l'autre par le payeur.
//
// LE TEST: `freshDeployer` separe-t-il ENCORE a l'interieur de chaque branche du financeur, et
// reciproquement ? Si oui, chacun porte quelque chose que l'autre n'a pas. Si non, l'un est l'ombre de
// l'autre — et les deux reponses sont un resultat.
//
// ⛔ LE CROISEMENT NE PASSE PAS PAR `industrialFunder`, ET C'EST DELIBERE. Ce champ n'est persiste que
// si `siblingCount >= 20` ET que le verdict n'etait pas deja `rug_ready` (token-radar.js:715) — il
// MANQUE donc precisement sur les tokens les plus dangereux, et croiser dessus fabriquerait une table
// biaisee. On utilise le predicat du pari annonce lui-meme: `siblingCount >= 20`, avec ABSTENTION
// quand ce n'est pas un nombre. Trois etats, pas deux.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: le taux de rug des quatre cellules, leurs bornes, et si les ecarts
// survivent au conditionnement mutuel.
// ⛔ CE QU'ELLE NE PEUT PAS: etablir une causalite, ni dire lequel des deux « cause » l'autre. Elle
// mesure du recouvrement d'information, pas un mecanisme.
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

/* Trois etats sur l'axe financeur, jamais deux: un `siblingCount` absent n'est pas « sous le seuil ». */
const axeFinanceur = (t) => (typeof t.siblingCount !== 'number' ? 'abstention'
  : t.siblingCount >= SEUIL ? 'industriel' : 'sous seuil');
const axeJetable = (t) => (t.freshDeployer === true ? 'jetable'
  : t.freshDeployer === false ? 'reutilise' : 'absent');

function mesure(g) {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(res.map(fnd).filter(Boolean));
  return { res: res.length, rug, fN: f.size,
    brut: proportionAvecBornes(rug, res.length),
    tirage: proportionAvecBornes(rug, res.length, { effectif: f.size, plancher: MIN_RESOLUS }) };
}
const ic = (p) => {
  if (p.taux !== null) return pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']';
  if (p.retenu) return 'RETENU (' + p.effectif + ' < ' + MIN_RESOLUS + ')';
  return 'REFUSE';
};
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));
const cellule = (jet, fin) => mesure(rows.filter((t) => axeJetable(t) === jet && axeFinanceur(t) === fin));

console.log('\n  ── LA TABLE, ' + SEUIL + ' FRERES ET LE PORTEFEUILLE JETABLE ──\n');
console.log('    ' + ''.padEnd(12) + 'financeur INDUSTRIEL (>=' + SEUIL + ')'.padEnd(34)
  + 'financeur SOUS le seuil');
console.log('    ' + '-'.repeat(92));
const grille = {};
for (const jet of ['jetable', 'reutilise']) {
  grille[jet] = { industriel: cellule(jet, 'industriel'), sousSeuil: cellule(jet, 'sous seuil') };
  const c = grille[jet];
  const rendu = (m) => (String(m.rug) + '/' + m.res).padStart(9) + '  ' + ic(m.brut).padEnd(25)
    + String(m.fN).padStart(3) + ' fin.';
  console.log('    ' + jet.padEnd(12) + rendu(c.industriel) + '   ' + rendu(c.sousSeuil));
}
const abst = { jetable: cellule('jetable', 'abstention'), reutilise: cellule('reutilise', 'abstention') };
console.log('\n    ⚠️ ABSTENTION (siblingCount non lu — un TROISIEME etat, pas « sous le seuil »):');
for (const jet of ['jetable', 'reutilise']) {
  console.log('       ' + jet.padEnd(12) + String(abst[jet].rug) + '/' + abst[jet].res
    + '   ' + ic(abst[jet].brut) + '   ' + abst[jet].fN + ' fin.');
}

/* ── LE TEST QUI DECIDE: CHACUN SEPARE-T-IL ENCORE DANS LA BRANCHE DE L'AUTRE ? ──────────────────── */
console.log('\n  ── LE JETABLE SEPARE-T-IL ENCORE, A FINANCEUR FIXE ? ──\n');
for (const [nom, k] of [['financeur INDUSTRIEL', 'industriel'], ['financeur SOUS le seuil', 'sousSeuil']]) {
  const a = grille.jetable[k], b = grille.reutilise[k];
  if (a.brut.taux === null || b.brut.taux === null) {
    console.log('    ' + nom.padEnd(26) + '⛔ une branche sans appel resolu — rien a comparer'); continue;
  }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ' + nom.padEnd(26) + pct(a.brut.taux) + ' vs ' + pct(b.brut.taux)
    + '   ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
    + (disjoints(a.brut, b.brut) ? '💎 DISJOINTS par token' : '⚠️ chevauchants — non etabli'));
  /* ⛔ ET LE MEME ECART, RAMENE AUX TIRAGES. C'est lui qui decide: un ecart par token peut tenir sur
   * une poignee d'operateurs, et ce depot a deja vu 91 points s'evaporer de cette facon. */
  console.log('      ' + 'par tirage'.padEnd(24) + ic(a.tirage) + '  vs  ' + ic(b.tirage)
    + (disjoints(a.tirage, b.tirage) ? '   💎 DISJOINTS'
      : (a.tirage.taux === null || b.tirage.taux === null) ? '   ⛔ retenu d un cote au moins'
        : '   ⚠️ chevauchants'));
}

console.log('\n  ── LE FINANCEUR SEPARE-T-IL ENCORE, A JETABLE FIXE ? ──\n');
for (const jet of ['jetable', 'reutilise']) {
  const a = grille[jet].industriel, b = grille[jet].sousSeuil;
  if (a.brut.taux === null || b.brut.taux === null) {
    console.log('    ' + jet.padEnd(26) + '⛔ une branche sans appel resolu — rien a comparer'); continue;
  }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ' + jet.padEnd(26) + pct(a.brut.taux) + ' vs ' + pct(b.brut.taux)
    + '   ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
    + (disjoints(a.brut, b.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants — non etabli'));
}

/* ── LE CONTROLE QUI RETIRE LE PLANCHER: SEULEMENT LES COMPTES LUS EN ENTIER ─────────────────────
 * `siblingCount` est un PLANCHER quand la lecture s'est arretee sur une borne. Un financeur censure
 * sous 20 peut en avoir 300, et il se retrouve alors dans la colonne « sous seuil » — celle qui porte
 * tout l'ecart. Plutot que de raisonner sur le SENS de cette contamination, on la retire: `token-radar`
 * persiste `siblingCountCensored`, on ne garde que les lectures non censurees. */
const nonCensure = (t) => t.siblingCountCensored === false;
console.log('\n  ── CONTROLE: SUR LES SEULS COMPTES LUS EN ENTIER (non censures) ──\n');
const dispo = rows.filter((t) => t.siblingCountCensored !== undefined).length;
if (!dispo) {
  console.log('    ⛔ `siblingCountCensored` absent de toutes les lignes: ce controle ne se fait pas, et');
  console.log('       son absence est dite plutot que comblee par le chiffre precedent.');
} else {
  const cel = (jet, fin) => mesure(rows.filter((t) => nonCensure(t) && axeJetable(t) === jet
    && axeFinanceur(t) === fin));
  for (const [nom, k] of [['financeur INDUSTRIEL', 'industriel'], ['financeur SOUS le seuil', 'sous seuil']]) {
    const a = cel('jetable', k), b = cel('reutilise', k);
    if (!a.res || !b.res) { console.log('    ' + nom.padEnd(26) + '⛔ une branche vide apres filtrage'); continue; }
    const d = 100 * (a.brut.taux - b.brut.taux);
    console.log('    ' + nom.padEnd(26) + (a.rug + '/' + a.res).padStart(9) + ' ' + ic(a.brut)
      + '  vs ' + (b.rug + '/' + b.res).padStart(9) + ' ' + ic(b.brut));
    console.log('      ' + 'ecart'.padEnd(24) + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
      + (disjoints(a.brut, b.brut) ? '💎 DISJOINTS' : '⚠️ chevauchants — non etabli')
      + '   (' + a.fN + ' vs ' + b.fN + ' financeurs)');
  }
  console.log('  ⚠️ ' + (rows.length - dispo) + ' ligne(s) n ont pas le drapeau et sont exclues du controle:');
  console.log('     leur absence PRECEDE la fonctionnalite, ce n est pas « non censure ».');
}

/* ── LE RECOUVREMENT BRUT: LES DEUX DRAPEAUX SE LEVENT-ILS SUR LES MEMES TOKENS ? ────────────────── */
const traces = rows.filter((t) => axeJetable(t) !== 'absent' && axeFinanceur(t) !== 'abstention');
const nJ = traces.filter((t) => axeJetable(t) === 'jetable').length;
const nI = traces.filter((t) => axeFinanceur(t) === 'industriel').length;
const nJI = traces.filter((t) => axeJetable(t) === 'jetable' && axeFinanceur(t) === 'industriel').length;
console.log('\n  ── LE RECOUVREMENT, EN TOKENS ──\n');
console.log('    tokens portant les DEUX lectures          ' + traces.length);
console.log('    dont jetable                              ' + nJ + '  (' + (100 * nJ / traces.length).toFixed(1) + ' %)');
console.log('    dont financeur industriel                 ' + nI + '  (' + (100 * nI / traces.length).toFixed(1) + ' %)');
console.log('    dont LES DEUX                             ' + nJI + '  (' + (100 * nJI / traces.length).toFixed(1) + ' %)');
if (nJ && nI) {
  const attendu = nJ * nI / traces.length;
  console.log('    attendu si INDEPENDANTS                   ' + attendu.toFixed(1)
    + '   -> observe / attendu = ' + (nJI / attendu).toFixed(2) + 'x');
  console.log('  ⚠️ Ce rapport n est PAS un test: il ne porte aucune borne et deux drapeaux peuvent se');
  console.log('     recouvrir fortement tout en gardant chacun de l information. Ce qui tranche est la');
  console.log('     paire de comparaisons conditionnelles ci-dessus, pas ce nombre.');
}

console.log('\n  ⛔ CE QUE CETTE TABLE NE DIT PAS. Elle mesure un RECOUVREMENT D INFORMATION, jamais un');
console.log('     mecanisme ni une causalite. Et `siblingCount` reste un PLANCHER quand la lecture a ete');
console.log('     bornee: une cellule « sous le seuil » peut contenir des financeurs qui l auraient franchi');
console.log('     avec plus de pages. Le sens de cette erreur est connu — elle deplace des tokens vers la');
console.log('     colonne « sous seuil », donc elle ATTENUE l ecart du financeur, jamais elle ne le cree.');
console.log('  ⛔ RIEN N EST PROMU. Annoncer un pari est date et irreversible.\n');
