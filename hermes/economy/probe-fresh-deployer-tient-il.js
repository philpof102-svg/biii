#!/usr/bin/env node
'use strict';
/**
 * probe-fresh-deployer-tient-il.js
 * ================================================================================================
 * `freshDeployer` EST LE PREMIER SIGNAL DE CETTE SESSION QUI SURVIT A TOUS LES CONTROLES.
 * ET LA POCHE QU'IL SEMBLAIT OUVRIR N'Y SURVIT PAS. Les deux sont dans ce fichier, cote a cote.
 *
 * Le champ est ECRIT par le radar, connu DES LA PREMIERE VUE (pas post-hoc), equilibre
 * (27,0 % true / 27,6 % false / 45,5 % absent) — et AUCUNE regle ne le lit.
 *
 * ⛔ A NE PAS CONFONDRE AVEC `dropPct`, mesure le meme jour: ce dernier n'existe QUE sur les lignes
 * ruggees (1772 valeurs pour 1772 rugs, exactement). C'est une variable POST-HOC: une regle qui la
 * lirait aurait une information parfaite et circulaire. Sa distribution est en plus degeneree —
 * 66,1 % valent exactement 1 et le q25 est deja a 0,99999.
 *
 * ═══ CE QUI SURVIT ═══
 * Mesure du 2026-08-11, base 82,4 % sur 2150 resolus, plafond danger 17,6 pts:
 *     true    n=580   96,2 %   +13,8 pts   (78 % du plafond atteignable)
 *     false   n=568   66,9 %   -15,5 pts
 *     absent  n=1002  83,2 %   +0,8 pt     -> neutre, coherent avec « pas mesure »
 *
 * · CROISE AVEC LA CENSURE — le controle qui a tue les regles de financeur: aucune INVERSION.
 *   `true` donne 97,8 (censure) et 94,7 (prouve); `false` donne 75,2 et 25,8. Meme sens partout.
 * · PAR FINANCEUR — l'unite d'independance: 148 financeurs purs `true` a 87,3 %, 42 purs `false` a
 *   69,6 %. Les DEUX au-dessus du plancher de 20, donc les taux se publient. Ecart 17,7 pts, attenue
 *   par rapport aux 29,3 par token mais de MEME SIGNE.
 *
 * ═══ CE QUI NE SURVIT PAS, ET C'EST LA MOITIE LA PLUS UTILE ═══
 * La poche `false` + compte PROUVE affichait 25,8 % par token (-56,6 pts) — la meilleure zone « sure »
 * vue de la session. ⛔ Par FINANCEUR elle rend 85,2 %, soit AU-DESSUS de la base. Cause: sur ses
 * 27 financeurs, UN SEUL porte 63 des 89 tokens (70,8 % de la poche); les 26 autres en ont un chacun.
 * 💎 Une poche portee par un operateur ne mesure pas une regle, elle mesure CET operateur.
 *
 * ⚠️ BORNES: population d'observation de CE noeud. `ruggedAt` est une DETECTION. Issues resolues par le
 * helper CANONIQUE `outcomeKnownAt`. ⛔ Aucune adresse imprimee. ⛔ Cette sonde n'ANNONCE aucun pari:
 * annoncer est une decision d'operateur.
 */
const fs = require('node:fs');
const path = require('node:path');
const { outcomeKnownAt, maturityWindow, MIN_RESOLUS } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.log('base ILLISIBLE (' + ((e && e.message) || e) + ')'); process.exitCode = 1; return; }

const lignes = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const f = maturityWindow(lignes);
const T = Date.now();
const res = [];
for (const t of lignes) { const k = outcomeKnownAt(t, T, f.maturityH); if (k) res.push({ t, rug: k === 'rugged' }); }
const base = 100 * res.filter((r) => r.rug).length / res.length;
const plafond = 100 - base;

const tx = (a) => (a.length ? 100 * a.filter((x) => x.rug).length / a.length : null);
const dit = (n, a) => {
  const p = tx(a);
  console.log('   ' + n.padEnd(28) + String(a.length).padStart(5) + '   '
    + (p === null ? 'n/d' : p.toFixed(1) + ' pct   ecart ' + (p - base >= 0 ? '+' : '') + (p - base).toFixed(1) + ' pts'));
};

console.log('== `freshDeployer` tient-il sous les controles ? ==');
console.log('   base ' + base.toFixed(1) + ' pct sur ' + res.length + ' resolus   plafond danger ' + plafond.toFixed(1) + ' pts');

/* ── 0. LE PIEGE VOISIN: `dropPct` EST POST-HOC ───────────────────────────────────────────────────── */
const dp = lignes.filter((t) => typeof t.dropPct === 'number').length;
const rugs = lignes.filter((t) => t.outcome === 'rugged').length;
console.log('');
console.log('-- ⛔ `dropPct` d abord: POST-HOC, a ne jamais utiliser comme predicteur --');
console.log('   valeurs de dropPct  ' + dp + '   lignes `rugged`  ' + rugs
  + (dp === rugs ? '   => IDENTIQUE: le champ n existe que sur l issue' : '   => a re-examiner'));

/* ── 1. LE SIGNAL SEUL ────────────────────────────────────────────────────────────────────────────── */
console.log('');
console.log('-- le signal SEUL --');
dit('true  (deployeur frais)', res.filter((r) => r.t.freshDeployer === true));
dit('false (deployeur ancien)', res.filter((r) => r.t.freshDeployer === false));
dit('ABSENT (3e etat)', res.filter((r) => r.t.freshDeployer === undefined));
console.log('   ⚠️ le 3e etat doit etre NEUTRE: s il ne l est pas, l absence de mesure serait elle-meme');
console.log('      un signal, ce qui trahirait un biais de collecte plutot qu une propriete du monde.');

/* ── 2. LE CONTROLE QUI A TUE LES AUTRES REGLES: LA CENSURE ───────────────────────────────────────── */
console.log('');
console.log('-- croise avec la censure du compte de freres (cherche une INVERSION) --');
const sens = [];
for (const fd of [true, false]) {
  for (const cv of [true, false, undefined]) {
    const s = res.filter((r) => r.t.freshDeployer === fd && r.t.siblingCountCensored === cv);
    if (!s.length) continue;
    dit('  fresh=' + fd + ' cens=' + String(cv), s);
    if (cv !== undefined) sens.push({ fd, cv, signe: Math.sign(tx(s) - base) });
  }
}
const parFd = [true, false].map((fd) => sens.filter((s) => s.fd === fd).map((s) => s.signe));
const inversion = parFd.some((sg) => sg.length > 1 && new Set(sg).size > 1);
console.log('   => INVERSION de signe entre strates ? ' + (inversion ? '⛔ OUI — le signal est un melange' : '✅ NON — le sens tient partout'));

/* ── 3. L'UNITE D'INDEPENDANCE ────────────────────────────────────────────────────────────────────── */
console.log('');
console.log('-- par FINANCEUR (financeurs PURS seulement: les mixtes ne trancheraient rien) --');
const parF = new Map();
for (const r of res) {
  const k = r.t.funder && String(r.t.funder).toLowerCase();
  if (!k) continue;
  if (!parF.has(k)) parF.set(k, { fresh: new Set(), n: 0, r: 0 });
  const e = parF.get(k); e.n++; if (r.rug) e.r++;
  if (r.t.freshDeployer !== undefined) e.fresh.add(r.t.freshDeployer);
}
const purs = [...parF.values()].filter((e) => e.fresh.size === 1);
const taux = (g) => (g.length ? 100 * g.reduce((s, e) => s + e.r / e.n, 0) / g.length : null);
for (const v of [true, false]) {
  const g = purs.filter((e) => e.fresh.has(v));
  console.log('   financeurs purs `' + String(v).padEnd(5) + '`  ' + String(g.length).padStart(4) + '   '
    + (g.length >= MIN_RESOLUS ? taux(g).toFixed(1) + ' pct' : 'RETENU (' + g.length + ' < ' + MIN_RESOLUS + ')'));
}
console.log('   mixtes, exclus            ' + String([...parF.values()].filter((e) => e.fresh.size > 1).length).padStart(4));

/* ── 4. LA POCHE QUI NE SURVIT PAS ────────────────────────────────────────────────────────────────── */
console.log('');
console.log('-- ⛔ la poche `false` + compte PROUVE: spectaculaire par token, MORTE par operateur --');
const poche = res.filter((r) => r.t.freshDeployer === false && r.t.siblingCountCensored === false);
dit('  par TOKEN', poche);
const fin = new Map();
for (const r of poche) {
  const k = r.t.funder && String(r.t.funder).toLowerCase();
  if (!k) continue;
  if (!fin.has(k)) fin.set(k, { n: 0, r: 0 });
  const e = fin.get(k); e.n++; if (r.rug) e.r++;
}
const pf = taux([...fin.values()]);
console.log('   financeurs distincts       ' + String(fin.size).padStart(4) + '   '
  + (fin.size >= MIN_RESOLUS ? pf.toFixed(1) + ' pct par FINANCEUR' : 'RETENU (< ' + MIN_RESOLUS + ')'));
const tailles = [...fin.values()].map((e) => e.n).sort((a, b) => b - a);
if (tailles.length && poche.length) {
  console.log('   le plus gros financeur pese ' + (100 * tailles[0] / poche.length).toFixed(1)
    + ' pct de la poche (' + tailles[0] + ' tokens sur ' + poche.length + ')');
}
if (fin.size >= MIN_RESOLUS && pf !== null && tx(poche) !== null && Math.sign(pf - base) !== Math.sign(tx(poche) - base)) {
  console.log('   ⛔ LE SIGNE S INVERSE ENTRE LES DEUX UNITES: ' + tx(poche).toFixed(1) + ' pct par token contre '
    + pf.toFixed(1) + ' par financeur.');
  console.log('   💎 Une poche portee par UN operateur ne mesure pas une regle, elle mesure CET operateur.');
}

console.log('');
console.log('⛔ Cette sonde n ANNONCE aucun pari: annoncer est une decision d operateur, et une entree');
console.log('   annoncee ne se modifie jamais. Elle livre la mesure et ses controles, rien de plus.');
