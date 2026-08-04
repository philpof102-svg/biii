#!/usr/bin/env node
/**
 * pistes-restantes — recalcule la liste des fonctions exportees qu'AUCUN test ne nomme.
 *
 * Pourquoi ce fichier est SUIVI par git, et pas dans un scratchpad. La tache de fouille nocturne cite
 * cet outil par son chemin depuis le 2026-07-28, mais il vivait dans `scratchpad/`, qui n'est pas
 * versionne. Mesure du 2026-08-04 : le fichier n'existait plus. Une passe qui le cherche ne trouve rien,
 * et « deviner une piste coute une passe entiere pour rien » — c'est-a-dire que l'outil ecrit pour eviter
 * de deviner avait disparu exactement comme disparait un resultat qu'on ne journalise pas.
 *
 * ⚠️ CE QUE CET INSTRUMENT NE VOIT PAS — a lire AVANT de conclure « non teste ».
 * Il cherche le NOM de l'export dans le texte des tests. Un garde exerce uniquement A TRAVERS SES
 * APPELANTS est donc rapporte comme non couvert alors qu'il est solidement epingle. Mesure du 2026-08-04
 * sur `seedscan.assertUsableIndex` : rapporte ici comme piste, en realite pinne par onze assertions via
 * `scanText`, `judgeRun` et `checksumValid`, messages exacts compris. C'est un FAUX POSITIF de la sonde,
 * pas un trou du sujet — la sortie de ce script est une liste de CANDIDATS a verifier, jamais un verdict.
 *
 * Le controle d'instrument est en bas : si le corpus de tests est vide, la sonde sort en erreur au lieu
 * de rendre « tout est non couvert », qui est la reponse qu'une sonde cassee rend le plus volontiers.
 *
 *   node scripts/pistes-restantes.js .                       # lib/ + bin/ par defaut
 *   node scripts/pistes-restantes.js ../onchain-forensics lib bin
 *
 * Le brief note que se limiter a `lib/` a masque le meilleur defaut du 2026-07-29 (il etait dans `bin/`,
 * la surface MCP que les utilisateurs appellent vraiment). D'ou `lib bin` par defaut, et `hermes`/`scripts`
 * a passer explicitement quand on veut elargir encore.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || '.';
const DIRS = process.argv.length > 3 ? process.argv.slice(3) : ['lib', 'bin'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const testFiles = walk(path.join(ROOT, 'test'));
const testText = testFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const srcFiles = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rows = [];
for (const f of srcFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (!m) continue;
  for (const raw of m[1].split(',')) {
    const n = raw.split(':')[0].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(n)) continue;
    // garder ce qui est DECLARE comme fonction dans ce fichier (un objet de constantes n'est pas une piste)
    const declared = new RegExp('(function\\s+' + n + '\\s*\\(|(?:const|let)\\s+' + n + '\\s*=\\s*(?:async\\s*)?\\()').test(src);
    if (!declared) continue;
    if (!new RegExp('\\b' + n + '\\b').test(testText)) rows.push(path.relative(ROOT, f) + ' -> ' + n);
  }
}

console.log('sources: ' + srcFiles.length + ' fichier(s) dans [' + DIRS.join(', ') + ']');
console.log('tests  : ' + testFiles.length + ' fichier(s), ' + testText.length + ' octets lus');

// Controle d'instrument. Un corpus vide rendrait « chaque export est une piste » — la forme la plus
// convaincante d'un succes vide, puisqu'elle ressemble a une veine riche au lieu d'une panne.
if (testFiles.length === 0 || testText.length === 0) {
  console.error('!! SONDE CASSEE : aucun test lu sous ' + path.join(ROOT, 'test') + ' — resultat non interpretable.');
  process.exit(1);
}
if (srcFiles.length === 0) {
  console.error('!! SONDE CASSEE : aucune source lue sous [' + DIRS.join(', ') + '] — resultat non interpretable.');
  process.exit(1);
}

console.log('\ncandidats (exports non NOMMES par un test — verifier les appelants avant de conclure) : ' + rows.length);
for (const r of rows) console.log('  ' + r);
