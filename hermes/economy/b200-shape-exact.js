#!/usr/bin/env node
// b200-shape-exact.js — la forme, au caractere pres, et le payload RPC pour aller la verifier.
// ================================================================================================
// Le repo ne fabrique aucune de ces adresses (grep : seuls mes propres scripts de rejeu citent
// « b200 »), et l'enregistrement est reel — MECHACOIN, 43 k$ de liquidite initiale, 135 k$ au pic,
// 0 a la fin. Ce sont de vrais tokens. Donc la question n'est plus « d'ou vient cette chaine de
// caracteres » mais « qu'est-ce que cette adresse EST sur la chaine ».
//
// Avant de sonder, compter — position et longueur du tunnel de zeros, longueur de l'adresse. J'ai
// deja essaye de compter ces zeros a l'oeil deux fois dans cette session et je me suis repris deux
// fois : un identifiant se copie, il ne se lit pas.
//
// Sortie : la forme, puis un fichier de payloads `eth_getCode` prets a etre curl-es. `eth_getCode`
// est une lecture pure — aucune signature, aucun envoi, jamais.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const b200 = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));

/** Le plus long tunnel de zeros : longueur ET position de depart. */
function tunnel(addr) {
  const hex = String(addr).toLowerCase().replace(/^0x/, '');
  let best = { len: 0, at: -1 }, cur = 0;
  for (let i = 0; i < hex.length; i++) {
    cur = hex[i] === '0' ? cur + 1 : 0;
    if (cur > best.len) best = { len: cur, at: i - cur + 1 };
  }
  return { ...best, hexLen: hex.length };
}

const formes = new Map();
for (const t of b200) {
  const s = tunnel(t.addr);
  const k = `hexLen=${s.hexLen}  tunnel=${s.len} a partir de l index ${s.at}`;
  formes.set(k, (formes.get(k) || 0) + 1);
}
console.log('\n  formes exactes parmi les 156 :');
for (const [k, n] of [...formes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}x  ${k}`);
}

// Un echantillon volontairement mixte : deux ruggés, deux appels ouverts. Sonder uniquement les
// morts confirmerait n'importe quelle histoire — c'est la meme faute que noter une regle sur les
// seuls cas ou elle a gagne.
const rug = b200.filter((t) => t.outcome === 'rugged').slice(0, 2);
const live = b200.filter((t) => t.outcome === 'live').slice(0, 2);
const echantillon = [...rug, ...live];

const out = path.join(__dirname, 'b200-probe.json');
fs.writeFileSync(out, JSON.stringify(echantillon.map((t, i) => ({
  jsonrpc: '2.0', id: i + 1, method: 'eth_getCode', params: [t.addr, 'latest'],
})), null, 0));

console.log(`\n  echantillon a sonder (${echantillon.length}) — 2 rugges, 2 ouverts :`);
for (const t of echantillon) console.log(`    ${t.addr}  ${String(t.sym).padEnd(12)} ${t.outcome}`);
console.log(`\n  payload batch ecrit dans ${out}`);
console.log('  -> curl -s -X POST https://mainnet.base.org -H "content-type: application/json" -d @' + out);
