#!/usr/bin/env node
// probe-survivant-jamais-note.js — combien de « survivants » ont simplement cesse d'etre lisibles ?
// ================================================================================================
// token-radar.js:295 fait `if (liq == null) continue;` avec le commentaire « no pool returned =
// delisted/illiquid; needs 2 runs to confirm ». RIEN n'implemente cette seconde passe: un token dont
// le pool a entierement disparu — le rug le plus COMPLET qui soit — n'est jamais regrade et garde
// `outcome: 'live'` indefiniment.
//
// ⛔ ET `outcomeKnownAt` COMPTE TOUT `'live'` ASSEZ ANCIEN COMME « SURVECU ». Donc un token dont le
// pool s'est evapore il y a dix jours entre dans le denominateur ET au numerateur des survivants de
// chaque taux publie. Tous les taux du cote SUR sont gonfles d'autant.
//
// C'est la MEME classe que le compte de freres censure trouve plus tot: une valeur bornee par le
// processus de lecture, presentee comme une mesure du monde. Ici la borne est temporelle.
//
// ⚠️ CE QUE CET INSTRUMENT PEUT PROUVER: combien de « survivants » ont un `lastSeen` fige loin
// derriere la derniere observation de la base.
// ⚠️ CE QU'IL NE PEUT PAS PROUVER: qu'ils ont rugge. Un pool illisible n'est pas un rug — c'est
// precisement l'etat qu'on refuse de trancher. Le chiffre est un PLAFOND de contamination, pas un
// compte de rugs.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

/* La derniere observation de la BASE, pas l'heure courante: le radar peut etre arrete, et mesurer la
 * fraicheur contre une horloge murale confondrait « le token a disparu » et « le radar dort ». */
const derniere = Math.max(...rows.map((t) => Date.parse(t.lastSeen) || 0));
const H = 3600000;
const retard = (t) => (derniere - (Date.parse(t.lastSeen) || 0)) / H;

console.log(`\n  derniere observation de la base : ${new Date(derniere).toISOString()}`);
console.log(`  fenetre de maturite : ${maturityH} h\n`);

const vivants = rows.filter((t) => t.outcome === 'live');
const seuils = [maturityH, 24, 72, 168];
console.log(`  ${vivants.length} token(s) marques 'live'. Combien ont cesse d etre lus ?\n`);
console.log('    retard de lastSeen     tokens   dont comptes SURVIVANTS par le harnais');
console.log('    ' + '-'.repeat(70));
for (const s of seuils) {
  const g = vivants.filter((t) => retard(t) >= s);
  const comptes = g.filter((t) => issue(t) === 'survived').length;
  console.log(`    >= ${String(s).padStart(4)} h            ${String(g.length).padStart(6)}   ${String(comptes).padStart(6)}`);
}

/* Le seau SUR du pari le plus fort, sous le meme angle. */
const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const seauSur = rows.filter((t) => {
  const b = basis(t);
  return b && b.unreadable === 3 && typeof t.siblingCount === 'number' && t.siblingCount < 20;
});
const surSurvivants = seauSur.filter((t) => issue(t) === 'survived');
const surFiges = surSurvivants.filter((t) => retard(t) >= maturityH);

console.log(`\n  ── le seau SUR de \`simulation-et-financeur-lu\` ──\n`);
console.log(`    ${seauSur.length} token(s), dont ${surSurvivants.length} comptes SURVIVANTS`);
console.log(`    dont ${surFiges.length} n ont plus ete lus depuis au moins ${maturityH} h`
  + ` (${surSurvivants.length ? (100 * surFiges.length / surSurvivants.length).toFixed(1) : '0'} %)`);

const mediane = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
if (surFiges.length) {
  const r = surFiges.map(retard);
  console.log(`    retard median de ces figes : ${mediane(r).toFixed(1)} h  ·  max ${Math.max(...r).toFixed(1)} h`);
}

console.log('\n  ⛔ CE N EST PAS UN COMPTE DE RUGS. Un pool illisible peut etre un rug complet comme une');
console.log('     paire migree ou un token simplement illiquide. C est un PLAFOND de contamination:');
console.log('     au plus ce nombre de « survivants » sont en realite des issues jamais tranchees.');
console.log('  ⚠️ Et la borne joue dans UN SEUL SENS: elle ne peut que faire paraitre le cote SUR');
console.log('     meilleur qu il n est, jamais pire.\n');

/* ── L'IMPACT: que deviennent les taux si un « survivant » doit avoir ete OBSERVE vivant ? ────────
 * Definition alternative, appliquee ICI seulement — aucun module n'est modifie: un token compte comme
 * survivant s'il a ete VU vivant au moins `maturityH` apres sa premiere apparition, c'est-a-dire si
 * lastSeen - firstSeen >= maturityH. Sinon son issue n'est pas tranchee, et la clause 3 du harnais
 * dit qu'elle ne doit compter d'AUCUN cote. */
const vraimentSurvecu = (t) => {
  const a = Date.parse(t.firstSeen), b = Date.parse(t.lastSeen);
  return Number.isFinite(a) && Number.isFinite(b) && (b - a) >= maturityH * H;
};
const issueStricte = (t) => {
  const i = issue(t);
  if (i !== 'survived') return i;
  return vraimentSurvecu(t) ? 'survived' : null;   // null = non tranche, exclu des deux cotes
};

function taux(nom, g) {
  const rA = g.filter((t) => issue(t) === 'rugged').length;
  const sA = g.filter((t) => issue(t) === 'survived').length;
  const rB = g.filter((t) => issueStricte(t) === 'rugged').length;
  const sB = g.filter((t) => issueStricte(t) === 'survived').length;
  const pA = (rA + sA) ? (100 * rA / (rA + sA)) : null;
  const pB = (rB + sB) ? (100 * rB / (rB + sB)) : null;
  console.log(`    ${nom.padEnd(30)} ${(pA == null ? 'n/a' : pA.toFixed(1) + ' %').padStart(8)} sur ${String(rA + sA).padStart(4)}`
    + `   ->   ${(pB == null ? 'n/a' : pB.toFixed(1) + ' %').padStart(8)} sur ${String(rB + sB).padStart(4)}`
    + `   ${(pA != null && pB != null) ? ((pB - pA >= 0 ? '+' : '') + (pB - pA).toFixed(1) + ' pts') : ''}`);
}

console.log('  ── impact sur les taux publies (definition actuelle -> « vu vivant apres maturite ») ──\n');
console.log('    population                        actuel   n         strict   n        ecart');
console.log('    ' + '-'.repeat(84));
taux('toute la base', rows);
taux('seau SUR (le pari a 1,0 %)', seauSur);
const seauDanger = rows.filter((t) => { const b = basis(t); return b && b.unreadable === 3 && typeof t.siblingCount === 'number' && t.siblingCount >= 20; });
taux('seau DANGER (93,4 %)', seauDanger);

console.log('\n  ⛔ AUCUN MODULE N EST MODIFIE ICI. La definition stricte est appliquee dans cette sonde');
console.log('     seulement, pour chiffrer ce que le changement couterait avant de le proposer.');
console.log('  ⚠️ Le cote DANGER bouge peu par construction: un rug est DATE (ruggedAt), donc il ne');
console.log('     depend pas de la fraicheur. Seul le cote SUR repose sur une absence de nouvelle.\n');
