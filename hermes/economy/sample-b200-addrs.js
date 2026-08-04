#!/usr/bin/env node
// sample-b200-addrs.js — sort les adresses des deux bras, pour aller les lire ON-CHAIN.
// ================================================================================================
// La base sur disque ne peut plus trancher : `deployer` y est absent a 100 %, et la raison « no
// ERC-20 security record » est parfaitement colineaire au prefixe (131 sur 131, zero ailleurs sur
// 1703). Le contrefactuel n'existe pas dans ce fichier — il faut sortir du fichier.
//
// Ce que la chaine peut dire, elle, et que le disque ne peut pas :
//   · `eth_getCode`  -> le contrat a-t-il du bytecode ? L'hypothese memoire (b20-prefix-impersonation)
//                       dit « precompile a ~0 octet ». Un scanner ERC-20 ne peut rien indexer de vide.
//   · le createur    -> une adresse en 0xb200 se mine en CREATE2 ; si les deux bras sortent de la
//                       MEME usine, le prefixe et la raison sont deux traces d'un seul operateur.
//
// ⛔ LECTURE SEULE des deux cotes : ce script lit un fichier, et les appels qui suivront sont des
// `eth_getCode` / `eth_getTransactionReceipt`. Aucune signature, aucun envoi, jamais.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const SANS_RECORD = /no ERC-20 security record/i;
const b200 = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));
const avec = b200.filter((t) => SANS_RECORD.test(String(t.firstReason || '')));
const sans = b200.filter((t) => !SANS_RECORD.test(String(t.firstReason || '')));

const N = Number(process.argv[2] || 4);

// Les deux bras separement : c'est la comparaison qui a du sens. Si les 25 « sans la raison » ont du
// bytecode et les 131 n'en ont pas, le mecanisme est lu directement et l'ecart de 23 pts a une cause.
console.log(`# bras AVEC la raison (${avec.length} tokens)`);
for (const t of avec.slice(0, N)) console.log(t.addr);
console.log(`# bras SANS la raison (${sans.length} tokens)`);
for (const t of sans.slice(0, N)) console.log(t.addr);

// Les raisons du petit bras : s'il n'a pas « no ERC-20 record », il a dit AUTRE CHOSE. Quoi ?
const m = new Map();
for (const t of sans) { const r = String(t.firstReason || '(absent)').slice(0, 46); m.set(r, (m.get(r) || 0) + 1); }
console.log(`# ce que disent les ${sans.length} du petit bras :`);
for (const [r, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`#   ${String(n).padStart(3)}x  ${r}`);
