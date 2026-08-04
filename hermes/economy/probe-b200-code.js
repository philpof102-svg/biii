#!/usr/bin/env node
// probe-b200-code.js — les 156 sont-elles TOUTES des tokens natifs B20 ?
// ================================================================================================
// Deux sondages ont rendu `0xef`, et un troisieme un bytecode ERC-20 complet. `0xEF` n'est pas un
// bytecode : EIP-3541 INTERDIT de deployer un contrat dont le code commence par cet octet, ce qui
// rend le marqueur infalsifiable — aucun deployeur ne peut l'imiter, le protocole refuse.
//
// Si les 155 adresses de forme structuree rendent toutes `0xef`, alors :
//   · elles ne sont pas des contrats ERC-20 et n'en ont jamais ete ;
//   · « no ERC-20 security record exists » est une reponse CORRECTE du scanner, pas un signal ;
//   · notre verdict `caution` sur ces tokens etiquete NOTRE angle mort comme un risque du token.
//
// Deux sondages ne prouvent pas 155 cas. C'est la raison d'etre de ce script.
//
// ⚠️ LE PIEGE A EVITER ICI : un appel RPC qui echoue ne doit JAMAIS etre compte comme « pas 0xef ».
// C'est le motif numero un du depot — la valeur neutre qui devient une affirmation. Trois etats sont
// tenus separement : marqueur natif · bytecode present · NON LU. Le troisieme se publie.
//
// ⛔ Lecture pure : `eth_getCode` uniquement. Aucune signature, aucun envoi, jamais.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const LOT = 8;           // batch JSON-RPC prudent : le lot de 25 s'est fait refuser par l'endpoint.
const PAUSE = 250;       // respirer entre les lots plutot que se faire limiter et lire « NON LU ».
const MARQUEUR = '0xef'; // EIP-3541 : indeployable, donc inimitable.

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const cible = rows.filter((t) => String(t.addr).toLowerCase().startsWith('0xb200'));

const etat = new Map();  // addr -> 'natif' | 'bytecode' | 'vide' | 'NON LU'

async function lot(tokens) {
  const payload = tokens.map((t, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [t.addr, 'latest'] }));
  let rep;
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    rep = await r.json();
    // Un batch JSON-RPC peut repondre un OBJET d'erreur au lieu du tableau attendu — lot trop gros,
    // quota, methode refusee. Sans ce test, `rep.map` jette et le script meurt en silence sur ce
    // qu'il a deja lu ; avec, l'echec devient un etat nomme et le reste du sondage continue.
    if (!Array.isArray(rep)) throw new Error('reponse non-batch : ' + JSON.stringify(rep).slice(0, 160));
  } catch (e) {
    // L'echec se NOMME. Marquer ces adresses « pas natives » serait fabriquer un resultat.
    for (const t of tokens) etat.set(t.addr, 'NON LU');
    console.error(`    lot de ${tokens.length} NON LU : ${e.message}`);
    return;
  }
  const parId = new Map(rep.map((x) => [x.id, x]));
  for (let i = 0; i < tokens.length; i++) {
    const x = parId.get(i);
    const code = x && typeof x.result === 'string' ? x.result.toLowerCase() : null;
    if (code === null) etat.set(tokens[i].addr, 'NON LU');
    else if (code === MARQUEUR) etat.set(tokens[i].addr, 'natif');
    else if (code === '0x') etat.set(tokens[i].addr, 'vide');
    else etat.set(tokens[i].addr, 'bytecode');
  }
}

async function main() {
  console.log(`\n  sondage de ${cible.length} adresses via ${RPC}  (eth_getCode, lecture pure)`);
  for (let i = 0; i < cible.length; i += LOT) {
    await lot(cible.slice(i, i + LOT));
    process.stdout.write(`\r    ${Math.min(i + LOT, cible.length)}/${cible.length}   `);
    await new Promise((r) => setTimeout(r, PAUSE));
  }
  console.log('\n');

  const par = new Map();
  for (const v of etat.values()) par.set(v, (par.get(v) || 0) + 1);
  for (const [k, n] of [...par.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(10)} ${String(n).padStart(4)}   ${((n / cible.length) * 100).toFixed(1)}%`);
  }

  const nonLus = [...etat.values()].filter((v) => v === 'NON LU').length;
  if (nonLus) console.log(`\n  ⚠️ ${nonLus} adresses NON LUES : elles ne comptent dans aucune conclusion.`);

  // Le taux de rug par etat REEL du code, plutot que par apparence de l'adresse.
  const rugged = (t) => t.outcome === 'rugged';
  const open = (t) => t.outcome === 'live';
  const BASE = rows.filter(rugged).length / rows.length;
  console.log(`\n  taux de rug par etat du code  (base globale ${(BASE * 100).toFixed(1)}%) :`);
  for (const k of ['natif', 'bytecode', 'vide', 'NON LU']) {
    const g = cible.filter((t) => etat.get(t.addr) === k);
    if (!g.length) continue;
    const r = g.filter(rugged).length, o = g.filter(open).length;
    console.log(`    ${k.padEnd(10)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(o).padStart(3)} ouv · ${((r / g.length) * 100).toFixed(1)}% .. ${(((r + o) / g.length) * 100).toFixed(1)}%`);
  }

  // Le controle qui manque encore : les tokens ORDINAIRES ne sont pas sondes ici. Le comparatif
  // « natif vs ERC-20 ordinaire » se lit contre les 1703 de la base, dont on sait deja le taux.
  const ord = rows.filter((t) => !String(t.addr).toLowerCase().startsWith('0xb200'));
  const ro = ord.filter(rugged).length, oo = ord.filter(open).length;
  console.log(`    ${'(1703 hors prefixe, non sondes)'.padEnd(10)} ${String(ord.length).padStart(4)} · ${String(ro).padStart(4)} rug · ${String(oo).padStart(3)} ouv · ${((ro / ord.length) * 100).toFixed(1)}% .. ${(((ro + oo) / ord.length) * 100).toFixed(1)}%`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
