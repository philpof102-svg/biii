#!/usr/bin/env node
// replay-proxy-rule.js — « contrat proxy » merite-t-il d'armer le verdict le plus grave ?
// ================================================================================================
// Decomposition du 04/08 : les 38 `rug_ready` sont 13 residus de la regle d'usurpation de symbole
// (retiree le 26/07, reconnaissables a leur `armedAtFirstSight` VIDE) et 25 pouvoirs reellement armes
// — dont 17 portent la meme phrase : « proxy contract — the code you audited can be swapped ».
//
// Donc 45 % du verdict le plus grave du produit repose sur UNE regle, dans un palier mesure PLAT
// (37 tokens a 75,7 % contre 75,3 % de base une fois l'imposteur B20 retire). C'est la forme exacte
// qui a tue la regle du symbole le 26/07 : elle portait 13 des 13 `rug_ready` de l'epoque et ne
// predisait rien.
//
// ⚠️ ET IL Y A UNE RAISON MECANIQUE DE SE MEFIER, avant meme de mesurer. Un proxy est le motif normal
// de tout token evolutif — stablecoins, RWA, la moitie des actifs serieux de Base. « Le code peut etre
// remplace » est vrai de chacun d'eux. Une regle qui arme sur cette base marque une PROPRIETE
// D'ARCHITECTURE, pas une intention. C'est la meme faute que le prefixe 0xb200 aurait produite.
//
// La mesure porte donc sur les DEUX cotes: le proxy arme rugge-t-il plus, ET les non-proxy rugguent-ils
// moins ? Une regle qui n'informe que dans un sens est une demi-regle.
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
const PROXY = /proxy contract|is_proxy/i;

const liste = (t, champ) => (Array.isArray(t[champ]) ? t[champ] : []);
const proxyArme = (t) => liste(t, 'armedAtFirstSight').some((x) => PROXY.test(String(x)));
// Un drapeau « defuse » porte son propre prefixe: le compter comme un drapeau vivant gonflerait le
// groupe avec des cas ou le pouvoir existe mais que personne ne peut tirer.
const proxyDrapeau = (t) => liste(t, 'flagsAtFirstSight')
  .some((x) => PROXY.test(String(x)) && !/^\(defused/i.test(String(x)));

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(40)}    0 —`); return null; }
  const r = g.filter(rugged).length, o = g.filter(open).length;
  const lift = (r / g.length - BASE) * 100;
  console.log(`    ${label.padEnd(40)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · `
    + `${((r / g.length) * 100).toFixed(1).padStart(5)}% .. ${(((r + o) / g.length) * 100).toFixed(1).padStart(5)}% · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, r, o, bas: r / g.length, haut: (r + o) / g.length };
}

console.log(`\n  taux de base : ${((BASE) * 100).toFixed(1)}%  (${rows.length} tokens)`);
console.log('  colonnes : n · rug · ouverts · [borne basse .. haute] · lift sur la basse\n');

console.log('  ── le proxy, des DEUX cotes ──');
const a = ligne('proxy ARME (pose rug_ready)', rows.filter(proxyArme));
const b = ligne('proxy en drapeau, NON arme', rows.filter((t) => !proxyArme(t) && proxyDrapeau(t)));
const c = ligne('aucune mention de proxy', rows.filter((t) => !proxyArme(t) && !proxyDrapeau(t)));

if (a && c) {
  const d = (a.bas - c.bas) * 100;
  console.log(`\n    -> ecart arme vs sans mention : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`);
  if (a.n < 20) console.log(`    ⚠️ n=${a.n} : trop petit pour trancher. Indication, pas resultat.`);
  const chevauche = a.bas < c.haut && c.bas < a.haut;
  if (chevauche) console.log('    ⚠️ Intervalles chevauchants : les appels ouverts peuvent inverser l ordre.');
}

// Le rappel, sans lequel un lift ne veut rien dire — la lecon des natifs B20 ce soir.
const rugsTotal = rows.filter(rugged).length;
if (a) {
  console.log(`\n    rappel : ${a.r}/${rugsTotal} = ${((a.r / rugsTotal) * 100).toFixed(1)}% des rugs, `
    + `en marquant ${((a.n / rows.length) * 100).toFixed(1)}% de la base`);
  console.log(`    cout   : ${a.o} appel(s) OUVERT(s) marque(s) du verdict le plus grave du produit`);
}

/* LE CONTROLE D'INDEPENDANCE. N observations ne sont pas N operateurs: si les proxys armes partagent
 * un financeur, la regle ne fait que redire le signal du financeur sous un autre nom — c'est
 * exactement ce qui a tue l'usurpation de symbole (5 contrats HBULL = un financeur deguise en cinq
 * prises). Sans ce controle, un lift sur 17 lignes peut n'etre qu'un seul evenement. */
console.log('\n  ── controle d independance : combien d ENTITES derriere le groupe ? ──');
const armes = rows.filter(proxyArme);
const parFunder = new Map(), parDeployeur = new Map();
let sansFunder = 0;
for (const t of armes) {
  if (t.funder) parFunder.set(t.funder, (parFunder.get(t.funder) || 0) + 1); else sansFunder++;
  if (t.deployer) parDeployeur.set(t.deployer, (parDeployeur.get(t.deployer) || 0) + 1);
}
console.log(`    financeurs distincts LUS : ${parFunder.size}   ·   financeur non lu : ${sansFunder}/${armes.length}`);
console.log(`    deployeurs distincts LUS : ${parDeployeur.size}`);
if (parFunder.size) {
  const top = [...parFunder.entries()].sort((x, y) => y[1] - x[1])[0];
  console.log(`    plus gros financeur      : ${top[1]}/${armes.length - sansFunder} des lus`);
}
if (sansFunder === armes.length) {
  console.log('    ⛔ AUCUN financeur lu dans le groupe : l independance est INDECIDABLE ici.');
  console.log('       Ce n est pas « ils sont independants » — c est « on ne peut pas savoir ».');
}

// Et le chevauchement avec la regle du financeur, la seule validee vers l'avant.
const usine = (t) => typeof t.siblingCount === 'number' && t.siblingCount >= 20;
console.log('\n  ── ce que le financeur industriel attrapait DEJA ──');
ligne('proxy arme ET usine', armes.filter(usine));
ligne('proxy arme, financeur lu non-usine', armes.filter((t) => typeof t.siblingCount === 'number' && !usine(t)));
ligne('proxy arme, financeur NON LU', armes.filter((t) => typeof t.siblingCount !== 'number'));
