#!/usr/bin/env node
'use strict';
/**
 * probe-classifieur-sans-plancher.js
 * ================================================================================================
 * LES DEUX CHEMINS SERVIS RENDENT-ILS LE MEME VERDICT LOCAL ?
 *
 *   route REST  : `lib/vet.js::vetLocal(addr, …)` → `.classifier`
 *   outil MCP   : le wrapper `localClassify` de `bin/biii-mcp.js` (ligne 116), EXPORTE
 *
 * ⛔ CE FICHIER A D'ABORD MESURE UNE COMPOSITION QUI N'EXISTE PAS, ET LE DIRE EST SON PRINCIPAL INTERET.
 *
 * Premier jet: j'avais lu le site d'appel `localClassify(a.address, { resourceUrl })` dans
 * `bin/biii-mcp.js:380` et conclu que le MCP ne passait PAS le plancher — puisque
 * `lib/vet.js::localClassify` fait `knownBad || loadScreen(null)` et que `loadScreen(null)` rend un
 * ensemble VIDE. La sonde appelait donc `require('lib/vet').localClassify` en croyant reproduire le MCP,
 * et rendait un verdict CONSTANT `BLOCK/red` sur sept adresses — « le noeud accuse tout le monde ».
 *
 * ⚠️ FAUX. `bin/biii-mcp.js:116` definit son PROPRE `localClassify`:
 *     const localClassify = (address, opts = {}) => V.localClassify(address, { ...opts, knownBad: KNOWN_BAD });
 * Les sites 380 et 568 passent par ce wrapper, qui injecte le plancher. Mesure sur le VRAI wrapper
 * exporte: il DISCRIMINE (BLOCK/red sur le plancher, PROCEED_LOW_VALUE/green hors plancher).
 *
 * 🔑 LA LECON: un site d'appel ne dit pas a QUOI l'identifiant est lie. Un wrapper local du meme nom
 * peut se trouver quinze lignes plus haut, et simuler la composition « comme au site d'appel » mesure
 * alors une fonction que personne n'appelle. Passer par l'EXPORT REEL, jamais par une reconstitution.
 *
 * ⚠️ BORNE: cette sonde compare des VERDICTS sur un echantillon du plancher local. Elle ne prouve pas
 * l'equivalence des deux chemins sur toute entree, et elle ne dit rien si `trust-core` est absent —
 * ce cas est NOMME plutot que confondu avec « identiques ». ⛔ Aucune adresse n'est imprimee.
 */
const { loadFloor, vetLocal } = require('../../lib/vet');
const MCP = require('../../bin/biii-mcp.js');

const floor = loadFloor();
console.log('== les deux chemins servis rendent-ils le meme verdict local ? ==');
console.log('   plancher charge      ' + (floor.available ? 'OUI, ' + floor.count + ' adresses' : 'NON (vide)'));

/* ⛔ SANS PLANCHER PEUPLE, TOUTE COMPARAISON EST VIDE DE SENS: on le DIT. */
if (!floor.available || floor.count === 0) {
  console.log('   ⛔ aucun plancher known-bad — la sonde ne peut RIEN comparer.');
  console.log('      (lancer scripts/biii-known-bad-ingest.js) — ce n est pas un resultat negatif.');
  process.exitCode = 1;
  return;
}

const sur = [...floor.set].slice(0, 3);                    // sur le plancher
const hors = ['0x' + '9c'.repeat(20), '0x' + '1d'.repeat(20), '0x' + '7e'.repeat(20), '0x' + '42'.repeat(20)];
const echantillon = sur.concat(hors);

const dec = (v) => (v === null || v === undefined ? 'null' : v.decision + '/' + v.color);
const parMcp = echantillon.map((a) => dec(MCP.localClassify(a, {})));
const parRest = echantillon.map((a) => dec(vetLocal(a, {}).classifier));

console.log('');
console.log('-- TEMOIN: le classifieur repond-il, et DISCRIMINE-t-il ? --');
if (parMcp.every((v) => v === 'null') && parRest.every((v) => v === 'null')) {
  console.log('   ⛔ `trust-core` absent: les deux chemins rendent null. La comparaison ne dit RIEN,');
  console.log('      et ce n est PAS « les deux chemins sont identiques ».');
  process.exitCode = 1;
  return;
}
const distinctsMcp = [...new Set(parMcp)];
const distinctsRest = [...new Set(parRest)];
console.log('   MCP  verdicts distincts : ' + JSON.stringify(distinctsMcp));
console.log('   REST verdicts distincts : ' + JSON.stringify(distinctsRest));
/* ⛔ UNE SORTIE CONSTANTE N EST PAS UNE MESURE — c est ce piege qui a produit le faux du premier jet. */
if (distinctsMcp.length < 2 || distinctsRest.length < 2) {
  console.log('   ⛔ un des deux chemins est CONSTANT sur cet echantillon: il ne mesure rien.');
  process.exitCode = 1;
}

console.log('');
console.log('-- les deux chemins, cote a cote --');
let ecarts = 0;
for (let i = 0; i < echantillon.length; i++) {
  const ou = i < sur.length ? 'SUR le plancher ' : 'hors plancher   ';
  const meme = parMcp[i] === parRest[i];
  if (!meme) ecarts++;
  console.log('   ' + ou + ' MCP=' + parMcp[i].padEnd(24) + ' REST=' + parRest[i].padEnd(24)
    + (meme ? '' : '   <- ECART'));
}

console.log('');
console.log(ecarts === 0
  ? '✅ AUCUN ECART sur cet echantillon: les deux compositions s accordent. Le defaut de STRUCTURE\n'
    + '   (deux compositions distinctes pour une meme question) reste, mais il ne produit pas de\n'
    + '   divergence ici — et c est un RESULTAT, pas une absence de resultat.'
  : '⛔ ' + ecarts + ' ECART(S): les deux chemins servis ne rendent pas le meme verdict local.');
