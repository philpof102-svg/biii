#!/usr/bin/env node
// probe-reprise-apres-panne.js — ce que le radar voit quand il rouvre les yeux n'est pas ce qu'il voit
//                                 en temps normal.
// ================================================================================================
// `probe-sans-financeur.js` a dissous le « 46 % » de `no_funder` en trois morceaux, mais a laisse un
// chiffre sans explication: 25,7 % de rugs sur 35 tokens de la strate de liquidite moyenne. Cette sonde
// le retrouve, et la reponse ne concerne pas les tokens — elle concerne le RADAR.
//
// Vingt-et-un de ces 35 sont apparus le MEME JOUR, le 2026-07-31, et un seul a rugge (4,8 %). Hors ce
// jour, le groupe rugge a 8/14 = 57,1 %. Or le 2026-07-31 a 08:36Z, le radar reprenait apres une panne
// de 11,2 h enregistree dans `blackouts.json`.
//
// L'HYPOTHESE, ET ELLE N'EST PAS ENTIEREMENT PROUVEE ICI: un token decouvert juste apres une panne a
// deja VECU pendant la cecite. Il entre donc dans la base pre-selectionne pour la survie — ceux qui ont
// rugge pendant le trou n'ont souvent jamais eu de pool visible a la reprise. C'est un biais du
// survivant, injecte par chaque panne, et il tire tout taux global vers le bas.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: que les tokens vus juste apres une panne ruggent MOINS, de combien, et
// que `no_funder` y est sur-represente.
// ⛔ CE QU'ELLE NE PEUT PAS: prouver le MECANISME. Il exigerait l'age du token a la premiere vue, et
// `deployedAt` n'est persiste pour AUCUNE des 2037 lignes — `traceFeeder` le rend pourtant. Sans lui,
// « plus vieux a la premiere vue » reste une histoire cohérente, pas une mesure.
// ⛔ ELLE NE PEUT PAS NON PLUS generaliser a toutes les pannes: le detail par trou n'est pas uniforme,
// et les trois plus anciens PRECEDENT l'existence du champ `funderTrace` — leurs zeros ne sont pas des
// observations.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
let trous;
try {
  trous = JSON.parse(fs.readFileSync(path.join(RACINE, 'data/token-radar/blackouts.json'), 'utf8'));
  if (!Array.isArray(trous)) throw new Error('le journal n est pas un tableau');
} catch (e) {
  console.log('\n  ⛔ blackouts.json illisible (' + e.message + '). Sans les pannes, cette sonde n a aucun');
  console.log('     decoupage a proposer et ne publie rien plutot que de comparer au hasard.\n');
  process.exit(0);
}
const MAINTENANT = Date.parse(process.argv[3] || new Date().toISOString());
const FENETRE_H = Number(process.argv[2]) || 2;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');

const fins = trous.map((t) => Date.parse(t.to)).filter(Number.isFinite);
const dansReprise = (ms) => fins.some((f) => ms >= f && ms < f + FENETRE_H * 3600000);

const bloc = (g) => {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  return { n: g.length, res: res.length, rug, nf: g.filter((t) => etat(t) === 'no_funder').length,
    p: proportionAvecBornes(rug, res.length) };
};
const avecDate = rows.filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const rep = bloc(avecDate.filter((t) => dansReprise(Date.parse(t.firstSeen))));
const hors = bloc(avecDate.filter((t) => !dansReprise(Date.parse(t.firstSeen))));

console.log('\n  ── LES DEUX POPULATIONS ──');
console.log('     fenetre de reprise: ' + FENETRE_H + ' h apres la fin de chacune des ' + fins.length + ' pannes\n');
console.log('    groupe            tok   res   rug   taux de rug             part no_funder');
const ligne = (nom, b) => {
  const ic = b.p.taux === null ? '     —' : pct(b.p.taux) + ' [' + pct(b.p.basse).trim() + '–' + pct(b.p.haute).trim() + ']';
  console.log('    ' + nom.padEnd(16) + String(b.n).padStart(5) + String(b.res).padStart(6)
    + String(b.rug).padStart(6) + '   ' + ic.padEnd(24) + (b.n ? (100 * b.nf / b.n).toFixed(1) + ' %' : '—'));
};
ligne('DANS la reprise', rep);
ligne('HORS reprise', hors);

if (rep.p.taux !== null && hors.p.taux !== null) {
  const ecart = 100 * (rep.p.taux - hors.p.taux);
  const chev = !(rep.p.haute < hors.p.basse || hors.p.haute < rep.p.basse);
  console.log('\n    ecart de taux de rug      ' + ecart.toFixed(1) + ' pts   '
    + (chev ? '⚠️ intervalles CHEVAUCHANTS — l ecart n est pas etabli'
      : '💎 intervalles DISJOINTS — l ecart est etabli'));
  console.log('    ecart de part no_funder   '
    + ((100 * rep.nf / rep.n) - (100 * hors.nf / hors.n)).toFixed(1) + ' pts');
}

/* ── LE DETAIL PAR PANNE, PARCE QUE LA MOYENNE PEUT ETRE PORTEE PAR UNE SEULE ──────────────────── */
console.log('\n  ── PAR PANNE, ET CE N EST PAS UNIFORME ──\n');
console.log('    reprise a           duree     tok   rug/res    taux    no_funder');
for (const t of trous) {
  const f = Date.parse(t.to);
  if (!Number.isFinite(f)) continue;
  const b = bloc(avecDate.filter((x) => { const ms = Date.parse(x.firstSeen); return ms >= f && ms < f + FENETRE_H * 3600000; }));
  console.log('    ' + t.to.slice(0, 16) + String(t.hours).padStart(8) + ' h'
    + String(b.n).padStart(7) + '   ' + (b.rug + '/' + b.res).padStart(8)
    + (b.res ? pct(b.p.taux).padStart(9) : '        —') + String(b.nf).padStart(9));
}
console.log('\n  ⛔ LES TROIS PLUS ANCIENNES REPRISES NE COMPTENT PAS POUR `no_funder`: le champ');
console.log('     `funderTrace` n existe dans la base qu a partir du 2026-07-29. Leurs zeros sont une');
console.log('     ABSENCE DE CHAMP, pas une absence de cas — les lire comme des observations ferait');
console.log('     paraitre l effet plus regulier qu il ne l est.');

/* ── CE QUE CA COUTE AU TAUX DE BASE ────────────────────────────────────────────────────────────── */
console.log('\n  ── CE QUE CA FAIT AU TAUX DE BASE PUBLIE ──\n');
const tout = bloc(avecDate);
console.log('    population entiere        ' + pct(tout.p.taux) + '  sur ' + tout.res + ' resolus');
console.log('    hors reprises seulement   ' + pct(hors.p.taux) + '  sur ' + hors.res + ' resolus');
if (tout.p.taux !== null && hors.p.taux !== null) {
  console.log('    dilution                  ' + (100 * (hors.p.taux - tout.p.taux)).toFixed(1)
    + ' pts   — chaque panne injecte une cohorte qui tire le taux vers le bas');
}

console.log('\n  ⛔ AUCUN CORRECTIF N EST PROPOSE ICI. Exclure les reprises du calcul serait une decision');
console.log('     de methode: on jetterait des tokens REELS parce qu on doute de leur representativite,');
console.log('     ce qui est exactement le genre de geste qui fabrique un chiffre flatteur. La mesure est');
console.log('     publiee; le choix appartient a un humain.');
console.log('  ⛔ ET LE MECANISME RESTE UNE HYPOTHESE. Le tester demande l age du token a la premiere vue.');
console.log('     `traceFeeder` rend `deployedAt`, et AUCUNE des ' + rows.length + ' lignes ne le porte —');
console.log('     le radar garde le booleen `freshDeployer` qui en derive et jette l horodatage. Persister');
console.log('     `deployedAt` rendrait cette question mesurable au lieu de plausible.\n');
