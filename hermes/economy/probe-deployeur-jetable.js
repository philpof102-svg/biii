#!/usr/bin/env node
// probe-deployeur-jetable.js — le portefeuille a-t-il ete fabrique pour ce lancement ?
// ================================================================================================
// `freshDeployer` vaut `incoming.length === 1` (lib/feeder.js:294): le portefeuille qui a deploye le
// token n'a JAMAIS rien recu d'autre. Il a ete fabrique pour la tache, et jete apres.
//
// ⛔ DEUX CHAMPS AUX NOMS VOISINS, DEUX QUANTITES. `freshDeployer` n'a rien a voir avec
// `FRESH_FUNDING_WINDOW_MS` (6 h): cette fenetre gouverne `freshlyFunded`, l'ecart financement ->
// deploiement. Et `freshlyFunded` n'est persiste sur AUCUNE ligne — pas plus que `fundingToDeployMs`
// ni `deployedAt`. Toute la dimension TEMPORELLE que le tracer calcule est perdue en base; seule
// survit celle-ci, qui est une dimension d'USAGE.
//
// ⚠️ CE CHAMP N'EST PAS UNE DECOUVERTE. `hermes/economy/what-survives.js:116` le compare deja, sous
// forme de PREVALENCE: « single-use » chez 30 % des rugs contre 14 % des survivants. Dans une
// population qui rugge a 82 %, une prevalence est dominee par le taux de base et dit peu. Ce qui
// manquait est le TAUX PAR BRANCHE, ses bornes, et les controles.
//
// ⚠️ CE QUE CETTE SONDE PEUT PROUVER: le taux de rug de chaque branche, avec intervalle exact, apres
// (a) exclusion des cohortes post-panne, (b) stratification sur la liquidite initiale, (c) comptage
// des FINANCEURS distincts derriere chaque chiffre.
// ⛔ CE QU'ELLE NE PEUT PAS: dire que le signal est independant de ceux deja annonces. Un portefeuille
// jetable et un financeur industriel peuvent designer la meme operation vue de deux cotes.
// ⛔ ELLE NE PROMEUT RIEN. Annoncer un pari est un geste date et irreversible: il revient a un humain.
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
let fins = null;
try {
  const j = JSON.parse(fs.readFileSync(path.join(RACINE, 'data/token-radar/blackouts.json'), 'utf8'));
  if (!Array.isArray(j)) throw new Error('pas un tableau');
  fins = j.map((t) => Date.parse(t.to)).filter(Number.isFinite);
} catch (e) { fins = null; }

const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const FENETRE_H = 6;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const reprise = (t) => {
  if (fins === null) return false;
  const ms = Date.parse(t.firstSeen);
  return fins.some((f) => ms >= f && ms < f + FENETRE_H * 3600000);
};
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');

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
  if (p.retenu) return 'RETENU (' + p.effectif + ' tirage(s) < ' + MIN_RESOLUS + ')';
  return 'REFUSE';
};
const disjoints = (a, b) => (a.taux !== null && b.taux !== null && (a.haute < b.basse || b.haute < a.basse));

const ligne = (nom, m) => {
  console.log('    ' + nom.padEnd(22) + String(m.rug).padStart(5) + ' / ' + String(m.res).padStart(5)
    + '   ' + ic(m.brut).padEnd(24) + String(m.fN).padStart(4) + ' fin.  ' + ic(m.tirage));
};
const verdict = (a, b, quoi) => {
  if (a.brut.taux === null || b.brut.taux === null) { console.log('    ⛔ ' + quoi + ': une branche sans appel resolu.'); return; }
  const d = 100 * (a.brut.taux - b.brut.taux);
  console.log('    ecart ' + quoi.padEnd(22) + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts   '
    + (disjoints(a.brut, b.brut) ? '💎 intervalles DISJOINTS' : '⚠️ intervalles CHEVAUCHANTS — non etabli'));
};

console.log('\n  ── LE PORTEFEUILLE FABRIQUE POUR LA TACHE ──\n');
console.log('    groupe                    rug / res   taux par TOKEN            fin.  taux par TIRAGE');
console.log('    ' + '-'.repeat(96));
const T = mesure(rows.filter((t) => t.freshDeployer === true));
const F = mesure(rows.filter((t) => t.freshDeployer === false));
const A = mesure(rows.filter((t) => t.freshDeployer === undefined));
ligne('jetable (1 entrant)', T);
ligne('reutilise (>1)', F);
ligne('(champ absent)', A);
console.log('');
verdict(T, F, 'brut');
console.log('  ⚠️ Le champ n existe que sur les tokens TRACES. Les ' + A.res + ' lignes sans champ ne sont pas');
console.log('     un troisieme profil: c est l absence de trace, deja mesuree ailleurs.');

/* ── CONTROLE 1: LES COHORTES POST-PANNE, QUI RUGGENT DE 12,8 PTS DE MOINS ───────────────────────── */
console.log('\n  ── CONTROLE 1: HORS FENETRES DE REPRISE (' + FENETRE_H + ' h apres chaque panne) ──\n');
if (fins === null) {
  console.log('    ⛔ blackouts.json illisible: ce controle ne se fait PAS, et son absence est dite plutot');
  console.log('       que comblee par le chiffre brut.');
} else {
  const T2 = mesure(rows.filter((t) => t.freshDeployer === true && !reprise(t)));
  const F2 = mesure(rows.filter((t) => t.freshDeployer === false && !reprise(t)));
  ligne('jetable', T2); ligne('reutilise', F2);
  console.log('');
  verdict(T2, F2, 'hors reprise');
}

/* ── CONTROLE 2: LA LIQUIDITE, QUI CONFOND TOUT LE RESTE DANS CE DEPOT ──────────────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
console.log('\n  ── CONTROLE 2: A LIQUIDITE COMPARABLE ──\n');
console.log('    tertiles de firstLiq: < ' + Math.round(q1) + '  |  ' + Math.round(q1) + ' a ' + Math.round(q2)
  + '  |  > ' + Math.round(q2));
for (const [nom, pred] of [['basse', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2], ['haute', (l) => l >= q2]]) {
  const dedans = (t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq);
  const a = mesure(rows.filter((t) => t.freshDeployer === true && dedans(t)));
  const b = mesure(rows.filter((t) => t.freshDeployer === false && dedans(t)));
  console.log('\n    -- strate ' + nom);
  ligne('  jetable', a); ligne('  reutilise', b);
  verdict(a, b, 'strate ' + nom);
}

console.log('\n  ⛔ CE QUE CES CHIFFRES NE PORTENT PAS. Dans les strates ou la branche « reutilise » compte');
console.log('     moins de ' + MIN_RESOLUS + ' financeurs distincts, son taux PAR TIRAGE est retenu — l ecart y reste donc');
console.log('     un ecart par TOKEN, pas par operateur. Le plus grand ecart de la grille est aussi celui');
console.log('     dont le cote « reutilise » est le plus groupe: c est a lire ensemble, pas separement.');
console.log('  ⛔ ET IL N EST PAS ETABLI QUE CE SIGNAL SOIT NOUVEAU. Un portefeuille jetable et un financeur');
console.log('     industriel peuvent designer la meme operation vue de deux cotes; le mesurer demanderait');
console.log('     de croiser les deux, ce que cette sonde ne fait pas.');
console.log('  ⛔ RIEN N EST PROMU. Annoncer un pari est date et irreversible — c est un geste humain.\n');
