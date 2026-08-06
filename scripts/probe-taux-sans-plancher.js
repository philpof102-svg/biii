#!/usr/bin/env node
// probe-taux-sans-plancher.js — quels taux publies peuvent reposer sur un denominateur minuscule ?
// ================================================================================================
// Trois fois en deux jours, le meme defaut: une valeur calculee `x / n` est publiee comme une MESURE
// alors que `n` peut valoir 1. `eval/verdict-harness.js` rendait 1 sur un corpus vide (corrige le
// 2026-08-06), `gradeAnnounced` publiait un taux sur 2 tokens parce que son plancher gardait une SOMME,
// et `runPrequential` n'avait aucun plancher (« 100 % des appels SUR ont rugge » sur n=1). Cette sonde
// cherche les sites restants.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: qu'un site divise par un compte et met le resultat en forme de taux, et
// quelle garde protege ce denominateur sur la MEME instruction.
// ⛔ CE QU'ELLE NE PEUT PAS: dire si `n` est reellement petit en production. Un `/ total` sur une base
// de 1731 lignes est irreprochable; le meme code sur un sous-groupe ne l'est pas. Le classement
// ci-dessous est un point de DEPART pour la lecture, jamais un verdict.
// ⛔ ELLE EST AVEUGLE aux expressions etalees sur plusieurs lignes: la garde peut vivre trois lignes
// plus haut. Un site classe « aucune garde » doit etre LU avant d'etre cru.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
/* ⛔ L automate vit dans lib/code-only.js, teste par test/code-only.test.js. En garder une copie ici
 * recreerait le motif qui coute le plus cher dans ce depot: le helper correct existe, et l appelant a
 * fort enjeu ne l appelle pas. */
const { codeOnly } = require('../lib/code-only');

const RACINE = path.join(__dirname, '..');


/* Les fichiers du depot, hors tests (un test qui divise par 2 est un test) et hors cette sonde. */
const fichiers = execSync('git ls-files "*.js"', { cwd: RACINE, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('test/') && !f.includes('probe-') && !f.includes('node_modules'));

const MISE_EN_FORME = /\.toFixed\(|\* *100|percent|Pct|Rate|rate/;
const DIVISION = /\/ *([A-Za-z_$][\w$.]*)/;

const trouves = [];
for (const f of fichiers) {
  const brut = fs.readFileSync(path.join(RACINE, f), 'utf8');
  const code = codeOnly(brut);
  const lignesCode = code.split('\n');
  const lignesBrutes = brut.split('\n');
  for (let n = 0; n < lignesCode.length; n++) {
    const l = lignesCode[n];
    if (!DIVISION.test(l) || !MISE_EN_FORME.test(l)) continue;
    const denom = l.match(DIVISION)[1];
    /* Trois classes de garde, du plus fort au plus faible. Le plancher NOMME est le seul qui borne;
     * le `?` ne fait que distinguer zero de non-zero, ce qui laisse passer n=1. */
    const garde = /MIN_RESOLUS|tauxPublie|< *(?:20|MIN)/.test(l) ? 'plancher'
      : /\? /.test(l) ? 'ternaire (2 etats: 0 ou pas 0)'
        : 'aucune sur cette ligne';
    trouves.push({ f, n: n + 1, denom, garde, texte: lignesBrutes[n].trim().slice(0, 96) });
  }
}

const parGarde = new Map();
for (const t of trouves) parGarde.set(t.garde, (parGarde.get(t.garde) || 0) + 1);

console.log(`\n  ${fichiers.length} fichier(s) hors tests · ${trouves.length} site(s) qui mettent un ratio en forme de taux\n`);
for (const [g, n] of [...parGarde.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)}  ${g}`);
}

for (const classe of ['aucune sur cette ligne', 'ternaire (2 etats: 0 ou pas 0)', 'plancher']) {
  const g = trouves.filter((t) => t.garde === classe);
  if (!g.length) continue;
  console.log(`\n  ── ${classe} (${g.length}) ──`);
  for (const t of g) console.log(`    ${t.f}:${t.n}  [/ ${t.denom}]\n        ${t.texte}`);
}

console.log('\n  ⛔ CE N EST PAS UNE LISTE DE DEFAUTS. Un ratio sur une base de 1731 lignes n a besoin');
console.log('     d aucun plancher. Ce qui se lit ici, c est OU un denominateur pourrait etre petit,');
console.log('     et le seul moyen de trancher est de lire le site et de savoir ce que `n` compte.');
console.log('  ⚠️ Et le scan ne voit qu UNE ligne a la fois: une garde posee plus haut lui echappe.\n');
