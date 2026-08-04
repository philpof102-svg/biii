#!/usr/bin/env node
// replay-b200-path.js — pourquoi les 156 ont-elles TOUTES un financeur illisible ?
// ================================================================================================
// Mesure precedente : les 156 adresses en `0xb200` ruggent a 83,3 %, soit +10,8 pts contre leur vrai
// groupe temoin (les 722 autres tokens dont le financeur n'a pas ete lu). Le signal survit a son
// controle, et il est independant de la regle du financeur PAR CONSTRUCTION — puisqu'aucune des 156
// n'a de compte de freres lu.
//
// C'est ce 100 % sans exception qui est suspect. Un prefixe vanity ne rend pas un financeur
// illisible. L'hypothese : ces tokens sont deployes d'une maniere que le traceur ne sait pas suivre,
// et le prefixe n'est qu'un PROXY de ce chemin. Si un autre champ separe les 156 des 722, c'est LUI
// la regle a ecrire — six caracteres hexadecimaux ne sont pas un mecanisme.
//
// Ce script compare les deux groupes champ par champ. Il ne conclut pas a la place du lecteur : un
// champ qui separe est une PISTE, pas une regle, et il faudra un test prequentiel comme pour tout le
// reste.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const estB200 = (t) => String(t.addr).toLowerCase().startsWith('0xb200');
const nonLu = (t) => typeof t.siblingCount !== 'number';
const rugged = (t) => t.outcome === 'rugged';
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');

const B200 = rows.filter((t) => estB200(t) && nonLu(t));      // 156
const TEMOIN = rows.filter((t) => !estB200(t) && nonLu(t));   // 722

console.log(`\n  groupe    : 0xb200 non-lus = ${B200.length}   ·   temoin non-lus = ${TEMOIN.length}`);
console.log(`  rug       : ${pct(B200.filter(rugged).length, B200.length)}   vs   ${pct(TEMOIN.filter(rugged).length, TEMOIN.length)}`);

/** Distribution d'un champ dans les deux groupes, triee par l'ecart le plus parlant. */
function compare(champ, valeur = (t) => t[champ]) {
  const dist = (g) => {
    const m = new Map();
    for (const t of g) { const v = String(valeur(t) ?? '(absent)'); m.set(v, (m.get(v) || 0) + 1); }
    return m;
  };
  const a = dist(B200), b = dist(TEMOIN);
  const cles = [...new Set([...a.keys(), ...b.keys()])];
  const lignes = cles.map((k) => {
    const na = a.get(k) || 0, nb = b.get(k) || 0;
    return { k, na, nb, pa: na / B200.length, pb: nb / TEMOIN.length };
  }).sort((x, y) => Math.abs(y.pa - y.pb) - Math.abs(x.pa - x.pb));

  console.log(`\n  ── ${champ} ──`);
  for (const l of lignes.slice(0, 6)) {
    const d = (l.pa - l.pb) * 100;
    const flag = Math.abs(d) >= 40 ? '  ⭐ SEPARE' : Math.abs(d) >= 15 ? '  ·' : '';
    console.log(`    ${String(l.k).slice(0, 30).padEnd(32)} 0xb200 ${pct(l.na, B200.length).padStart(6)}  |  temoin ${pct(l.nb, TEMOIN.length).padStart(6)}  ${d >= 0 ? '+' : ''}${d.toFixed(1)}${flag}`);
  }
}

compare('source');
compare('chain');
compare('firstVerdict');
compare('freshDeployer');
compare('deployer present', (t) => (t.deployer ? 'oui' : 'non'));
compare('funder present', (t) => (t.funder ? 'oui' : 'non'));
compare('firstReason', (t) => String(t.firstReason || '(absent)').slice(0, 28));

// Le deployeur partage : si les 156 sortent d'une poignee de deployeurs, ce n'est pas un prefixe,
// c'est une USINE — et le mecanisme serait le meme que le financeur industriel, juste vu d'un autre
// champ.
// ⚠️ CORRIGE. La premiere version comptait `(absent)` — sa propre valeur de repli — comme un
// deployeur, trouvait « 1 deployeur distinct pour 156 tokens » et imprimait « c est une usine ».
// L'absence de donnee etait devenue une affirmation sur le monde : le motif exact que cette session
// passe son temps a retirer du code, produit ici par mon propre instrument. Un compte ne se fait que
// sur les valeurs LUES, et le nombre de non-lus se dit a cote.
console.log('\n  ── concentration des deployeurs ──');
const lus = B200.filter((t) => t.deployer);
console.log(`    deployeur LU : ${lus.length}/${B200.length}   ·   absent : ${B200.length - lus.length}`);
if (!lus.length) {
  console.log('    ⛔ Aucun deployeur lu dans le groupe : la concentration est INDECIDABLE.');
  console.log('       Ce n est pas « pas de concentration » — c est « on ne peut pas savoir ».');
} else {
  const parDeployeur = new Map();
  for (const t of lus) parDeployeur.set(t.deployer, (parDeployeur.get(t.deployer) || 0) + 1);
  const top = [...parDeployeur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`    deployeurs distincts parmi les ${lus.length} lus : ${parDeployeur.size}`);
  for (const [d, n] of top) console.log(`      ${d.slice(0, 24).padEnd(26)} ${n} token(s)  ${pct(n, lus.length)}`);
  // La part se lit sur les LUS, et ne vaut que si les lus sont assez nombreux pour representer.
  const share = top[0][1] / lus.length;
  if (lus.length < 20) console.log(`    ⚠️ n=${lus.length} lus : part non representative du groupe de ${B200.length}.`);
  else console.log(share >= 0.5
    ? '    ⭐ Un deployeur porte la moitie des LUS — piste d usine, a confirmer sur les non-lus.'
    : '    Pas de deployeur dominant parmi les lus.');
}
