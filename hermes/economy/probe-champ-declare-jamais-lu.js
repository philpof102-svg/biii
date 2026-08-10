#!/usr/bin/env node
'use strict';
/**
 * probe-champ-declare-jamais-lu.js
 * ================================================================================================
 * Le 2026-08-10, `siblingCount` etait DECLARE par le schema d'un outil MCP et LU par son handler, mais
 * ni declare ni lu sur la route payante jumelle. Le gate pose dans `test/openapi.test.js` couvre les
 * TROIS routes `/x402/*`. Cette sonde pose la meme question sur la surface bien plus large: les ~40
 * outils de `bin/biii-mcp.js`.
 *
 * QUESTION: pour chaque propriete declaree dans le `inputSchema` d'un outil, le dispatch la LIT-il ?
 *
 * ⚠️ CE QUE CETTE SONDE PEUT ET NE PEUT PAS PROUVER, ecrit ici parce qu'un instrument qui ne dit pas
 * sa borne finit par repondre a la place du monde:
 *   · elle prouve qu'une propriete est NOMMEE quelque part dans le fichier (`a.<prop>` ou `args.<prop>`);
 *   · elle NE prouve PAS que le bon handler la lit, ni qu'il en fait le bon usage;
 *   · un nom tres commun (`address`, `symbol`) sera trouve meme si l'outil qui le declare l'ignore —
 *     donc un « lu » est FAIBLE, tandis qu'un « JAMAIS lu » est FORT. On ne rapporte que le fort.
 *
 * ⛔ Elle ne modifie rien et ne conclut pas: elle rend une liste a verifier a la main.
 *
 * ═══ RESULTAT DU 2026-08-10, ECRIT ICI POUR QU ON NE LA RELANCE PAS NAIVEMENT ═══
 *
 * 29 outils, 119 proprietes declarees (27 requises). Elle a signale SEPT orphelines, toutes sur
 * `till_resolve`: npub · did · nonce · expiry · sigNostr · sigDid · sigBase.
 *
 * ⛔ LES SEPT SONT DES FAUX POSITIFS, et la verification a la main l'a etabli. Le handler fait
 * `bindingLens(a, { now })` — il passe l'objet ENTIER — et `lib/identity.js` lit ces champs
 * abondamment (19, 16, 13, 19, 5, 4, 6 occurrences respectivement). Le defaut etait dans le PERIMETRE
 * de la sonde, qui n'inspectait que le fichier de dispatch, pas la lentille qui consomme.
 *
 * 💎 CONCLUSION UTILE MALGRE TOUT: sur les 119 proprietes declarees, ZERO n'est reellement orpheline.
 * La surface MCP ne porte pas le defaut trouve la veille sur `/x402/vet-meme`.
 *
 * ⚠️ ET LA LECON PORTE SUR L'OUTIL, PAS SUR LE CODE: elargir la recherche aux modules `lib/` ne repare
 * pas ce genre de sonde — les lentilles n'emploient pas le prefixe de la variable d'arguments, donc le
 * champ reste introuvable. Chercher l'identifiant NU echangerait le faux positif contre un faux negatif
 * silencieux (`address`, `symbol` se trouvent partout). La bonne conduite est d'EXEMPTER nommement une
 * route qui delegue son corps entier, pas d'assouplir le filtre.
 */
const fs = require('node:fs');
const path = require('node:path');

const FICHIER = path.join(__dirname, '..', '..', 'bin', 'biii-mcp.js');
const { TOOLS } = require('../../bin/biii-mcp.js');
const src = fs.readFileSync(FICHIER, 'utf8');

/* Un champ est considere LU s'il apparait comme acces de propriete sur l'objet d'arguments. Les deux
 * formes employees dans ce fichier sont `a.<prop>` et `args.<prop>`; on accepte aussi la destructuration
 * `{ <prop> }` pour ne pas fabriquer de faux positifs. */
function estLu(prop) {
  return src.includes('a.' + prop)
      || src.includes('args.' + prop)
      || src.includes('.' + prop + ' ')      // ex: `params.foo `
      || src.includes(prop + ':') && src.includes('{ ' + prop);
}

let outils = 0, champs = 0, requis = 0;
const orphelins = [];

for (const t of TOOLS) {
  outils++;
  const sch = (t && t.inputSchema) || {};
  const props = Object.keys(sch.properties || {});
  const req = new Set(sch.required || []);
  for (const p of props) {
    champs++;
    if (req.has(p)) requis++;
    if (!estLu(p)) orphelins.push({ outil: t.name, champ: p, requis: req.has(p) });
  }
}

console.log('== un champ DECLARE est-il LU ? — les outils MCP ==');
console.log('   outils inspectes        ' + outils);
console.log('   proprietes declarees    ' + champs + ' (dont ' + requis + ' requises)');
console.log('');

/* ⛔ Un gate qui n'a RIEN examine passe en vert: on refuse de rendre un verdict sur zero sujet. */
if (!outils || !champs) {
  console.log('   ⛔ AUCUN outil ou aucune propriete inspecte — la sonde n a pas de sujet, pas de resultat');
  process.exitCode = 1;
  return;
}

if (!orphelins.length) {
  console.log('   ✅ aucune propriete declaree n est absente du fichier.');
  console.log('   ⚠️ RAPPEL DE BORNE: « present dans le fichier » n est pas « lu par LE BON handler ».');
  console.log('      Ce resultat EXCLUT l oubli pur, pas le mauvais branchement.');
} else {
  console.log('   ⛔ ' + orphelins.length + ' propriete(s) declaree(s) qui n apparaissent NULLE PART:');
  for (const o of orphelins) {
    console.log('      ' + (o.requis ? 'REQUISE ' : 'optionnelle ') + o.outil + ' . ' + o.champ);
  }
  console.log('');
  console.log('   ⚠️ A verifier A LA MAIN: une propriete peut etre lue sous une autre forme que celles');
  console.log('      testees ici. Cette liste est un point de DEPART, pas un verdict.');
}
