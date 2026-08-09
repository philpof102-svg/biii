#!/usr/bin/env node
// probe-candidats-se-recouvrent.js — les candidats de la table de decision sont-ils DISTINCTS ?
// ================================================================================================
// La bande « 1-4 freres » avait l'air d'un axe neuf: 48 points d'ecart, intervalles disjoints. Croisee
// contre `freshDeployer`, elle ne separait plus DANS AUCUNE branche — c'etait un DOUBLON. Ce test n'a
// jamais tourne sur les autres candidats, et la table de decision les compte comme quatre lectures
// independantes. Si deux d'entre elles disent la meme chose, « quatre candidats » en fait moins.
//
// LE TEST, celui qui a demasque la bande: chaque lecture separe-t-elle ENCORE a l'interieur de chaque
// branche de l'autre ? Si l'une s'effondre partout, elle est l'ombre de l'autre.
//
// ⛔ ET UNE PAIRE NE PEUT PAS ETRE TESTEE DU TOUT, ce qui est le resultat principal de cette sonde.
// `freshDeployer` n'est ecrit que sur la branche `ok` de la trace (token-radar.js:629). Un token dont
// la trace rend `no_creator` n'a JAMAIS de `freshDeployer` — mesure ici, pas suppose. Les deux drapeaux
// sont mutuellement exclusifs PAR CONSTRUCTION, et une table 2x2 dont deux cellules sont vides par
// construction ne se lit pas comme « ces axes sont independants ». Cette sonde refuse de la produire.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: pour chaque paire CROISABLE, si chaque lecture survit au conditionnement.
// ⛔ CE QU'ELLE NE PEUT PAS: dire qu'une lecture est inutile. Une cellule qui chevauche peut n'avoir que
// quelques lignes; tous les effectifs sont imprimes pour que le lecteur voie s'il lit une egalite ou un
// manque de puissance.
// ⛔ ELLE NE PROMEUT NI NE RETIRE RIEN, et n'imprime aucune adresse.
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

/* ── LE TERRAIN, ET POURQUOI IL Y EN A DEUX ──────────────────────────────────────────────────────────
 * Sur la population entiere, 87 a 92 % ruggent: la plupart des cellules 2x2 n'ont pas vingt points de
 * marge, et une lecture ne peut pas y montrer d'ecart meme si elle en porte un. La ou une separation
 * est seulement POSSIBLE, c'est la branche « sur » de la regle vivante — celle qui laisse passer. La
 * meme sonde tourne donc sur les deux, et la comparaison des deux est le resultat.
 *   node probe-candidats-se-recouvrent.js                    -> population entiere
 *   node probe-candidats-se-recouvrent.js '' --branche-sure   -> siblingCount < 20 */
const SUR = process.argv.includes('--branche-sure');
const SEUIL = 20;
const rows = SUR ? toutes.filter((t) => typeof t.siblingCount === 'number' && t.siblingCount < SEUIL) : toutes;
console.log('\n  ══ TERRAIN: ' + (SUR ? 'BRANCHE « SUR » (siblingCount < ' + SEUIL + ')' : 'POPULATION ENTIERE')
  + '  —  ' + rows.length + ' lignes sur ' + toutes.length + ' ══');
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? 'RETENU' : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

/* ── LES TROIS LECTURES, chacune avec sa condition de LISIBILITE ─────────────────────────────────────
 * « absent » n'est pas « faux »: une ligne dont le champ n'a pas ete ecrit sort de la comparaison, et
 * le nombre de sorties est imprime. */
const LECTURES = {
  thin: { champ: 'symbolVerdict', lisible: (t) => typeof t.symbolVerdict === 'string'
    && t.symbolVerdict !== 'not_a_candidate' && t.symbolVerdict !== 'unknown',
  vrai: (t) => t.symbolVerdict === 'thin' },
  jetable: { champ: 'freshDeployer', lisible: (t) => typeof t.freshDeployer === 'boolean',
    vrai: (t) => t.freshDeployer === true },
  no_creator: { champ: 'funderTrace', lisible: (t) => typeof t.funderTrace === 'string',
    vrai: (t) => t.funderTrace === 'no_creator' },
};

function mesure(g) {
  const rug = g.filter((t) => issue(t) === 'rugged').length;
  const f = new Set(g.map(fnd).filter(Boolean));
  return { res: g.length, rug, fN: f.size, brut: proportionAvecBornes(rug, g.length) };
}

/* ── LA GARDE QUI A SAUVE CETTE SONDE DE SON PROPRE TITRE ────────────────────────────────────────────
 * Croiser A contre B ne peut se faire que la ou B est LISIBLE — et la lisibilite de B n'est pas tiree
 * au sort. Ici elle depend de la reussite de la trace, qui est elle-meme liee a l'issue: mesure, le
 * groupe temoin rugge a 86,8 % la ou `freshDeployer` est lisible contre 59,8 % la ou il ne l'est pas.
 * Vingt-sept points d'ecart cause par notre instrument, pas par le monde.
 *
 * Consequence: si A separe HORS terrain mais pas DESSUS, conclure « A est l'ombre de B » decrit le
 * terrain, pas A. Cette fonction mesure les deux et le verdict est RETENU quand ils divergent. */
function horsTerrain(A, B) {
  const dedans = rows.filter((t) => issue(t) !== null && A.lisible(t) && B.lisible(t));
  const dehors = rows.filter((t) => issue(t) !== null && A.lisible(t) && !B.lisible(t));
  const ecart = (g) => {
    const v = mesure(g.filter(A.vrai)), f = mesure(g.filter((t) => !A.vrai(t)));
    if (!v.res || !f.res) return null;
    return { n: g.length, d: 100 * (v.brut.taux - f.brut.taux), v, f, disj: disjoints(v.brut, f.brut) };
  };
  return { dedans: ecart(dedans), dehors: ecart(dehors) };
}

/* ── D'ABORD: QUELLES PAIRES SONT SEULEMENT CROISABLES ? ─────────────────────────────────────────── */
console.log('\n  ── LISIBILITE CROISEE: quelles paires peuvent seulement etre testees ? ──\n');
const paires = [['thin', 'jetable'], ['no_creator', 'jetable'], ['thin', 'no_creator']];
const croisables = [];
for (const [a, b] of paires) {
  const A = LECTURES[a], B = LECTURES[b];
  const deux = rows.filter((t) => A.lisible(t) && B.lisible(t));
  const resolus = deux.filter((t) => issue(t) !== null);
  /* La question qui tue: parmi les lignes ou A est VRAI, combien ont B lisible ? Si c'est zero, les
   * deux drapeaux ne coexistent jamais et la table 2x2 aurait deux cellules vides par CONSTRUCTION. */
  const aVrai = rows.filter((t) => A.lisible(t) && A.vrai(t));
  const aVraiEtB = aVrai.filter((t) => B.lisible(t)).length;
  const bVrai = rows.filter((t) => B.lisible(t) && B.vrai(t));
  const bVraiEtA = bVrai.filter((t) => A.lisible(t)).length;
  const bloque = (aVrai.length > 0 && aVraiEtB === 0) || (bVrai.length > 0 && bVraiEtA === 0);
  console.log('    ' + (a + ' x ' + b).padEnd(26) + 'les deux lisibles ' + String(deux.length).padStart(5)
    + '   resolus ' + String(resolus.length).padStart(5));
  console.log('        parmi les ' + String(aVrai.length).padStart(4) + ' ou `' + a + '` est VRAI, '
    + aVraiEtB + ' ont `' + b + '` lisible');
  console.log('        parmi les ' + String(bVrai.length).padStart(4) + ' ou `' + b + '` est VRAI, '
    + bVraiEtA + ' ont `' + a + '` lisible');
  if (bloque) {
    console.log('    ⛔ NON CROISABLE PAR CONSTRUCTION: les deux drapeaux ne coexistent sur AUCUNE ligne.');
    console.log('       Une table 2x2 aurait deux cellules vides, et « vide par construction » ne se lit');
    console.log('       PAS comme « axes independants ». Cette paire ne sera pas testee.\n');
  } else if (resolus.length < 40) {
    console.log('    ⛔ trop peu de lignes resolues pour une table 2x2: rien ne se publie.\n');
  } else { croisables.push([a, b, resolus]); console.log('    ✅ croisable.\n'); }
}

/* ── PUIS: LE TEST, SUR LES SEULES PAIRES CROISABLES ─────────────────────────────────────────────── */
const verdicts = [];
for (const [a, b, terrain] of croisables) {
  const A = LECTURES[a], B = LECTURES[b];
  console.log('  ── ' + a.toUpperCase() + ' x ' + b.toUpperCase() + ' ──\n');
  const cel = (va, vb) => mesure(terrain.filter((t) => A.vrai(t) === va && B.vrai(t) === vb));
  const G = { vv: cel(true, true), vf: cel(true, false), fv: cel(false, true), ff: cel(false, false) };
  console.log('    ' + ''.padEnd(18) + (b + ' VRAI').padEnd(34) + (b + ' FAUX'));
  console.log('    ' + '-'.repeat(88));
  const rendu = (m) => (m.res ? (m.rug + '/' + m.res).padStart(9) + ' ' + ic(m.brut).padEnd(24)
    : '   (vide)'.padEnd(34));
  console.log('    ' + (a + ' VRAI').padEnd(18) + rendu(G.vv) + rendu(G.vf));
  console.log('    ' + (a + ' FAUX').padEnd(18) + rendu(G.fv) + rendu(G.ff));

  /* ── LE PLAFOND, PARCE QU'IL A FAILLI ME FAIRE PUBLIER UN NUL POUR UNE MESURE ────────────────────
   * Dans une cellule ou tout rugge a 96 %, il ne reste que quatre points a separer: aucune lecture ne
   * peut y montrer un ecart disjoint, et « +0,7, chevauchants » n'y dit rien sur la lecture. La marge
   * disponible est donc imprimee A COTE de l'ecart, et une comparaison dont la marge est plus etroite
   * que l'intervalle le plus large est marquee SATUREE — elle ne compte ni pour ni contre. */
  const cmp = (titre, x, y, ex, ey) => {
    if (!x.res || !y.res) { console.log('    ' + titre.padEnd(28) + '⛔ une cellule vide'); return null; }
    const d = 100 * (x.brut.taux - y.brut.taux);
    const ref = Math.max(x.brut.taux, y.brut.taux) === x.brut.taux ? y.brut : x.brut;
    const marge = 100 * (1 - ref.taux);
    const largeur = Math.max(100 * (x.brut.haute - x.brut.basse), 100 * (y.brut.haute - y.brut.basse));
    const sature = marge < largeur;
    const disj = disjoints(x.brut, y.brut);
    console.log('    ' + titre.padEnd(28) + (ex + ' ' + pct(x.brut.taux)).padEnd(16)
      + (ey + ' ' + pct(y.brut.taux)).padEnd(16) + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts'
      + ' / ' + marge.toFixed(1) + ' possibles  '
      + (sature ? '⛔ SATUREE' : disj ? '💎 DISJOINTS' : '⚠️ chevauchants'));
    return sature ? 'sature' : disj;
  };
  console.log('\n    `' + a + '` separe-t-il encore, a `' + b + '` fixe ?');
  const a1 = cmp('  ' + b + ' VRAI', G.vv, G.fv, 'oui', 'non');
  const a2 = cmp('  ' + b + ' FAUX', G.vf, G.ff, 'oui', 'non');
  console.log('\n    `' + b + '` separe-t-il encore, a `' + a + '` fixe ?');
  const b1 = cmp('  ' + a + ' VRAI', G.vv, G.vf, 'oui', 'non');
  const b2 = cmp('  ' + a + ' FAUX', G.fv, G.ff, 'oui', 'non');

  /* Une branche SATUREE ne compte ni pour ni contre: le denominateur est le nombre de branches ou une
   * separation etait seulement POSSIBLE. « 0 sur 1 » et « 0 sur 2 » ne sont pas la meme preuve. */
  const na = [a1, a2].filter((x) => x === true).length, nb = [b1, b2].filter((x) => x === true).length;
  const ta = [a1, a2].filter((x) => x !== 'sature' && x !== null).length;
  const tb = [b1, b2].filter((x) => x !== 'sature' && x !== null).length;
  console.log('\n    `' + a + '` separe dans ' + na + ' des ' + ta + ' branche(s) testable(s) · `'
    + b + '` dans ' + nb + ' des ' + tb
    + ((ta < 2 || tb < 2) ? '   ⛔ (des branches SATUREES sont exclues du denominateur)' : ''));

  /* ── LE TERRAIN EST-IL REPRESENTATIF ? ────────────────────────────────────────────────────────── */
  console.log('\n    ── le terrain testable est-il representatif ? ──');
  const biais = [];
  for (const [nom, X, Y] of [[a, A, B], [b, B, A]]) {
    const h = horsTerrain(X, Y);
    if (!h.dedans || !h.dehors) { console.log('      `' + nom + '` : un des deux cotes est vide — non verifiable'); continue; }
    const fmt = (e) => (e.d >= 0 ? '+' : '') + e.d.toFixed(1) + ' pts' + (e.disj ? ' DISJOINTS' : ' chevauchants')
      + '  (n=' + e.n + ')';
    console.log('      `' + nom + '` sur le terrain   ' + fmt(h.dedans));
    console.log('      `' + nom + '` HORS terrain     ' + fmt(h.dehors));
    if (h.dehors.disj && !h.dedans.disj) {
      biais.push(nom);
      console.log('      ⛔ `' + nom + '` separe HORS terrain et pas DESSUS: le terrain testable est');
      console.log('         precisement la ou cette lecture est la plus faible. Tout verdict de doublon');
      console.log('         la concernant decrirait le TERRAIN, pas la lecture.');
    }
  }

  let verdict;
  if (!ta || !tb) {
    verdict = '⛔ RETENU — toutes les branches testables sont SATUREES pour `' + (ta ? b : a)
      + '`: le plafond de rug ne laisse pas assez de marge pour qu une separation soit seulement visible';
  } else if (na === 0 && nb === 0) verdict = 'AUCUNE ne separe une fois l autre fixee — les deux disent la meme chose, ou le terrain est trop mince';
  else if (na === 0) verdict = '`' + a + '` est l OMBRE de `' + b + '` — doublon';
  else if (nb === 0) verdict = '`' + b + '` est l OMBRE de `' + a + '` — doublon';
  else verdict = 'les DEUX survivent quelque part — aucune n est le reflet de l autre';
  if (biais.length) {
    verdict = '⛔ RETENU — terrain non representatif pour ' + biais.map((x) => '`' + x + '`').join(', ')
      + ' (aurait dit: ' + verdict + ')';
  }
  console.log('\n    -> ' + verdict + '\n');
  verdicts.push([a, b, verdict]);
}

console.log('  ── CE QUE CETTE PASSE ETABLIT ──\n');
for (const [a, b, v] of verdicts) console.log('    ' + (a + ' x ' + b).padEnd(26) + v);
if (!croisables.length) console.log('    aucune paire croisable: le resultat est cette impossibilite elle-meme.');
console.log('\n  ⚠️ Une cellule qui chevauche n est pas une egalite: elle peut n avoir que peu de lignes, et');
console.log('     tous les effectifs sont imprimes au-dessus pour trancher entre les deux.');
console.log('  ⛔ ET RIEN N EST PROMU NI RETIRE. Qu une lecture soit un doublon dit qu elle n AJOUTE rien,');
console.log('     pas qu elle est fausse. Consolider la table de decision est une decision produit.');
console.log('  ⛔ Aucune adresse imprimee.\n');
