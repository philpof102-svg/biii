#!/usr/bin/env node
// replay-rugready-origine.js — d'ou viennent les `rug_ready`, et que peut-on encore savoir ?
// ================================================================================================
// `rug_ready` est le verdict le plus fort du radar et il est PLAT: 37 tokens a 75,7 % contre 75,3 %
// de taux de base une fois l'imposteur B20 retire. Un echelon de severite dont le sommet ne separe
// pas n'est pas un echelon — mais avant de le retirer ou de le reparer, il faut savoir quelle REGLE
// l'a pose, et la base ne l'enregistre pas.
//
// C'est exactement le defaut repare ce soir sur `b20Check: 'ok'`, qui disait qu'un controle avait
// tourne sans jamais dire ce qu'il avait trouve. Ici la perte est pire: le verdict le plus grave du
// produit ne porte pas la trace de ce qui l'a declenche, donc on ne peut ni le noter par regle, ni
// retirer une regle sans risquer d'en emporter une autre.
//
// Ce script tente la reconstruction A POSTERIORI depuis `firstReason`, et surtout MESURE ce qui reste
// irrecuperable. Une reconstruction par texte est fragile par nature: elle depend de phrases qui ont
// change au moins deux fois. Le nombre qui compte n'est donc pas « combien on a retrouve » mais
// « combien restent sans origine », parce que c'est lui qui justifie l'instrumentation.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const rugged = (t) => t.outcome === 'rugged';
const open = (t) => t.outcome === 'live';
const BASE = rows.filter(rugged).length / rows.length;

const rr = rows.filter((t) => t.firstVerdict === 'rug_ready');

/* Les signatures textuelles des regles connues, tirees du code ACTUEL et non de ma memoire:
 *   · token-radar.js  : la phrase de l'imposteur de prefixe B20
 *   · rugsignals.js   : le honeypot confirme par simulation, et la taxe de vente fatale
 *   · la regle d'usurpation de SYMBOLE, retiree le 26/07 — ses verdicts restent au registre
 * Une phrase qui ne matche rien est un residu d'une formulation disparue: c'est le compte utile. */
const SIGNATURES = [
  { cle: 'b20-imposteur', re: /wears the B20 address prefix/i },
  { cle: 'honeypot-simule', re: /HONEYPOT confirmed by live simulation/i },
  { cle: 'taxe-fatale', re: /economically a honeypot|live sell tax is/i },
  { cle: 'usurpation-symbole', re: /already has a dominant contract|impersonat/i },
  { cle: 'pouvoir-arme', re: /owner is live and can|mintable|blacklist|pausable/i },
];

const parOrigine = new Map();
for (const t of rr) {
  const texte = String(t.firstReason || '');
  const hit = SIGNATURES.find((s) => s.re.test(texte));
  const cle = hit ? hit.cle : 'INCONNUE';
  if (!parOrigine.has(cle)) parOrigine.set(cle, []);
  parOrigine.get(cle).push(t);
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');
console.log(`\n  rug_ready : ${rr.length} tokens  ·  taux de base ${pct(rows.filter(rugged).length, rows.length)}`);
console.log(`  colonnes  : n · rug · ouverts · [borne basse .. haute] · lift sur la basse\n`);

for (const [cle, g] of [...parOrigine.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = (r / g.length - BASE) * 100;
  console.log(`    ${cle.padEnd(22)} ${String(g.length).padStart(3)} · ${String(r).padStart(3)} rug · ${String(o).padStart(2)} ouv · `
    + `${pct(r, g.length).padStart(6)} .. ${pct(r + o, g.length).padStart(6)} · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
}

// Ce qui reste sans origine: le chiffre qui justifie (ou non) d'instrumenter.
const inconnues = parOrigine.get('INCONNUE') || [];
console.log(`\n  ── les ${inconnues.length} sans origine reconstructible ──`);
const parPhrase = new Map();
for (const t of inconnues) {
  const p = String(t.firstReason || '(absente)').slice(0, 58);
  parPhrase.set(p, (parPhrase.get(p) || 0) + 1);
}
for (const [p, n] of [...parPhrase.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}x  ${p}`);
}

/* ⚠️ LE CONTROLE QUI EMPECHE DE CONCLURE TROP VITE. `armedAtFirstSight` porte la capacite qui a arme
 * le verdict — s'il est rempli, l'origine est partiellement recuperable sans instrumentation nouvelle,
 * et le probleme est plus petit qu'annonce. S'il est vide, la perte est totale. */
console.log('\n  ── ce que `armedAtFirstSight` sauve encore ──');
const avecArmed = rr.filter((t) => Array.isArray(t.armedAtFirstSight) && t.armedAtFirstSight.length);
console.log(`    rug_ready portant un armedAtFirstSight non vide : ${avecArmed.length}/${rr.length}`);
if (avecArmed.length) {
  const m = new Map();
  for (const t of avecArmed) { const k = String(t.armedAtFirstSight[0]).slice(0, 54); m.set(k, (m.get(k) || 0) + 1); }
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`      ${String(n).padStart(3)}x  ${k}`);
} else {
  console.log('    ⛔ AUCUN. La capacite qui a arme le verdict le plus grave du produit n est nulle part.');
}

console.log('\n  Lecture : le nombre a retenir est celui des INCONNUES. Une reconstruction par texte');
console.log('  depend de phrases qui ont deja change deux fois — elle ne remplace pas un champ.');
