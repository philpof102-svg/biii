#!/usr/bin/env node
// probe-independance-financeurs.js — combien de TIRAGES y a-t-il vraiment derriere un pourcentage ?
// ================================================================================================
// Ce depot publie des taux par TOKEN. `runPrequential` parcourt les lignes une par une et compte des
// rugs; les six paris annonces sont notes de la meme facon. Or l'unite d'independance n'est pas le
// token, c'est le FINANCEUR: quinze tokens lances par un meme portefeuille partagent leur sort, et les
// compter comme quinze observations donne a une coincidence l'apparence d'une mesure.
//
// Le depot le SAIT depuis le 2026-08-04 — `lib/prequential.js` documente « 25 financeurs portent 800 des
// 981 tokens » — et s'en est servi pour rejeter une DERIVATION DE SEUIL, jamais pour qualifier ses taux.
// Cette sonde met les deux comptes cote a cote.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: pour un decoupage donne, combien de tokens et combien de financeurs
// DISTINCTS le composent, et de combien l'intervalle s'elargit quand on compte les seconds.
// ⛔ CE QU'ELLE NE PEUT PAS: dire qu'un taux par token est FAUX. Il est exact — c'est bien la proportion
// des tokens observes. Il ne repond simplement pas a la question qu'on lui pose d'habitude, qui est
// « et sur le PROCHAIN cas independant ? ».
// ⛔ ELLE NE TRANCHE RIEN sur les paris annonces. Changer l'unite de notation est une decision produit.
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
const cle = (t) => (typeof t.funder === 'string' ? t.funder.toLowerCase() : null);

const pct = (x) => (x === null ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
function ligne(nom, tokens) {
  const resolus = tokens.filter((t) => issue(t) !== null);
  const rugs = resolus.filter((t) => issue(t) === 'rugged');
  /* Un financeur compte comme UN tirage, et il « rugge » des qu'un de ses tokens resolus a rugge. */
  const parF = new Map();
  for (const t of resolus) {
    const k = cle(t); if (!k) continue;
    if (!parF.has(k)) parF.set(k, false);
    if (issue(t) === 'rugged') parF.set(k, true);
  }
  const fN = parF.size, fRug = [...parF.values()].filter(Boolean).length;

  /* ⚠️ DEUX STATISTIQUES PAR FINANCEUR, ET ELLES NE REPONDENT PAS A LA MEME QUESTION.
   *   `parFinanceur`  — la part des financeurs ayant produit AU MOINS un rug. Elle repond a « ce
   *                     portefeuille a-t-il deja rugge ? » et monte mecaniquement avec le nombre de
   *                     tokens qu'il porte: un financeur a 160 tokens y entre presque surement.
   *   `moyenneParFinanceur` — la moyenne NON PONDEREE des parts de rug de chaque financeur. C'est
   *                     l'analogue direct du taux par token: chaque operateur pese pareil.
   * Les confondre ferait passer l'une pour l'autre; elles sont donc publiees separement. */
  const parts = new Map();
  for (const t of resolus) {
    const k = cle(t); if (!k) continue;
    if (!parts.has(k)) parts.set(k, { r: 0, n: 0 });
    const e = parts.get(k); e.n++; if (issue(t) === 'rugged') e.r++;
  }
  const moyenne = parts.size
    ? [...parts.values()].reduce((s, e) => s + e.r / e.n, 0) / parts.size : null;

  const parToken = proportionAvecBornes(rugs.length, resolus.length);
  const parFinanceur = proportionAvecBornes(fRug, fN, { plancher: MIN_RESOLUS });
  return { nom, tokens: tokens.length, resolus: resolus.length, rugs: rugs.length,
    fN, fRug, parToken, parFinanceur, moyenne,
    groupement: fN ? resolus.length / fN : null };
}

/* ── LE DECOUPAGE QUI A DECLENCHE CETTE SONDE ────────────────────────────────────────────────────── */
const traces = rows.filter((t) => Number.isInteger(t.siblingPagesRead) && t.siblingPagesRead > 0 && cle(t));
const groupes = [
  ligne('histoire COURTE (`end`)', traces.filter((t) => t.siblingScanStoppedBy === 'end')),
  ligne('bornee (`page_cap`)', traces.filter((t) => t.siblingScanStoppedBy === 'page_cap')),
  ligne('panne en cours (`read_error`)', traces.filter((t) => t.siblingScanStoppedBy === 'read_error')),
];
const base = ligne('TOUT le radar (taux de base)', rows.filter((t) => cle(t)));

console.log('\n  ── LE MEME DECOUPAGE, COMPTE DE DEUX FACONS ──\n');
console.log('    groupe                          tok  res  rug   par TOKEN            fin  rug   par FINANCEUR');
console.log('    ' + '-'.repeat(104));
for (const g of [...groupes, base]) {
  const pt = g.parToken.taux === null ? '     —          ' : pct(g.parToken.taux) + ' ['
    + pct(g.parToken.basse).trim() + '–' + pct(g.parToken.haute).trim() + ']';
  const pf = g.parFinanceur.taux === null ? '  RETENU (n<' + MIN_RESOLUS + ')' : pct(g.parFinanceur.taux)
    + ' [' + pct(g.parFinanceur.basse).trim() + '–' + pct(g.parFinanceur.haute).trim() + ']';
  console.log('    ' + g.nom.padEnd(30) + String(g.tokens).padStart(5) + String(g.resolus).padStart(5)
    + String(g.rugs).padStart(5) + '  ' + pt.padEnd(22) + String(g.fN).padStart(4)
    + String(g.fRug).padStart(5) + '  ' + pf);
}

console.log('\n  ⚠️ La colonne « par FINANCEUR » compte les financeurs ayant produit AU MOINS un rug. Elle');
console.log('     monte mecaniquement avec le nombre de tokens portes et n est PAS l analogue du taux par');
console.log('     token. L analogue direct est la moyenne non ponderee ci-dessous — un operateur, une voix.\n');
console.log('    groupe                          par TOKEN   moyenne PAR FINANCEUR   ecart   groupement');
console.log('    ' + '-'.repeat(88));
for (const g of [...groupes, base]) {
  if (!g.groupement) continue;
  const ecart = (g.parToken.taux !== null && g.moyenne !== null)
    ? (100 * (g.moyenne - g.parToken.taux)).toFixed(1).padStart(6) + ' pts' : '     —  ';
  console.log('    ' + g.nom.padEnd(30) + pct(g.parToken.taux) + '        ' + pct(g.moyenne)
    + '        ' + ecart + '   ' + g.groupement.toFixed(1).padStart(5) + ' tok/fin');
}

/* ── LA CONCENTRATION DE TOUTE LA POPULATION JUGEE ──────────────────────────────────────────────── */
const resolusTous = rows.filter((t) => cle(t) && issue(t) !== null);
const parFTous = new Map();
for (const t of resolusTous) parFTous.set(cle(t), (parFTous.get(cle(t)) || 0) + 1);
const tailles = [...parFTous.values()].sort((a, b) => b - a);
const cumul = (n) => tailles.slice(0, n).reduce((s, x) => s + x, 0);
console.log('\n  ── ET CE QUI BORNE TOUT TAUX PUBLIE PAR CE DEPOT ──\n');
console.log('    tokens resolus portant un financeur   ' + resolusTous.length);
console.log('    financeurs DISTINCTS derriere eux     ' + parFTous.size);
for (const n of [1, 5, 10, 25]) {
  if (n > tailles.length) break;
  console.log('    les ' + String(n).padStart(2) + ' plus gros financeurs portent      ' + String(cumul(n)).padStart(5)
    + ' tokens  (' + (100 * cumul(n) / resolusTous.length).toFixed(1) + ' %)');
}
console.log('\n  ⚠️ UN POURCENTAGE PAR TOKEN N EST PAS FAUX — il est exact sur les tokens observes. Mais il');
console.log('     ne repond pas a « et sur le prochain cas INDEPENDANT ? », qui est la question que');
console.log('     posent un acheteur et un funder. Les deux colonnes ci-dessus repondent a deux');
console.log('     questions differentes, et une seule des deux etait publiee.');
console.log('  ⛔ CETTE SONDE NE TRANCHE RIEN. Changer l unite de notation des paris annonces est une');
console.log('     decision produit, et le taux par financeur est ici SOUS le plancher de ' + MIN_RESOLUS + ' — donc');
console.log('     retenu, pas publie. Ce qui est publie est le COMPTE, qui reste lisible.');
console.log('  ⛔ ET LE COMPTE DE FINANCEURS EST LUI-MEME UN MAJORANT D INDEPENDANCE: deux adresses');
console.log('     distinctes peuvent partager un operateur. On ne peut pas le voir depuis la chaine.\n');
