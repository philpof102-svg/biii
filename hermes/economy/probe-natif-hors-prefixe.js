#!/usr/bin/env node
// probe-natif-hors-prefixe.js — un natif B20 peut-il vivre SANS le prefixe 0xb200 ?
// ================================================================================================
// Le radar ne demande le code on-chain qu'aux adresses qui portent deja `0xb200`
// (token-radar.js:346, prefiltre gratuit). Consequence mesuree le 2026-08-05: sur les 13 tokens
// apparus depuis la frontiere d'annonce, `b20Check` est ABSENT pour les 13. La regle gelee
// `natif-b20` rend donc SAFE pour toute adresse non prefixee — une affirmation tiree d'un NOM, sur
// une regle dont le sujet est precisement que les noms s'achetent.
//
// Le prefiltre n'est legitime que si une seule chose est vraie: aucun token natif ne peut exister
// hors du prefixe. C'est verifiable, et ca ne se suppose pas. Le marqueur natif est le code
// exactement `0xef`, rendu infalsifiable par EIP-3541 qui interdit de DEPLOYER ce premier octet.
//
// ⚠️ CE QU'ON MESURE: la presence du marqueur sur un echantillon d'adresses NON prefixees.
// ⚠️ CE QU'ON NE PEUT PAS PROUVER: son absence ailleurs. Un echantillon qui ne trouve rien borne le
// taux, il ne le met pas a zero — et le plafond de lecture est DECLARE, jamais silencieux.
//
// Lecture SEULE — eth_getCode uniquement.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RPC = 'https://mainnet.base.org';
const PLAFOND = Number(process.env.PLAFOND || 60);   // plafond DECLARE de lectures on-chain
const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');

const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8')))
  .map(([addr, v]) => ({ addr, ...v }))
  .filter((t) => /^0x[0-9a-f]{40}$/i.test(t.addr));

/* Les plus RECENTS d'abord: si le standard s'etend hors de son prefixe, c'est la que ca se voit. */
const candidats = rows
  .filter((t) => !/^0xb200/i.test(t.addr))
  .sort((a, b) => Date.parse(b.firstSeen || 0) - Date.parse(a.firstSeen || 0))
  .slice(0, PLAFOND);

async function code(addr) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

(async () => {
  console.log(`\n  ${rows.length} tokens en base · ${candidats.length} adresse(s) NON prefixee(s) lue(s)`);
  console.log(`  plafond DECLARE : ${PLAFOND} lectures on-chain (les plus recentes)\n`);

  let natifs = 0, lus = 0, echecs = 0, vides = 0;
  const exemples = [];
  for (const t of candidats) {
    let c;
    try { c = await code(t.addr); } catch (e) { echecs++; continue; }
    lus++;
    if (!c || c === '0x') { vides++; continue; }
    /* Le marqueur est le PREMIER octet, exactement 0xef — pas « commence par ef » au hasard d'un
     * bytecode: un contrat deployable ne PEUT pas commencer par cet octet (EIP-3541). */
    if (c.toLowerCase() === '0xef' || /^0xef$/i.test(c)) {
      natifs++;
      exemples.push(t.addr);
    }
  }

  console.log(`  lues avec succes : ${lus}`);
  console.log(`  code vide (EOA)  : ${vides}`);
  console.log(`  echecs de lecture: ${echecs}   ${echecs ? '⛔ ni « natif » ni « pas natif » — NON LU' : ''}`);
  console.log(`  marqueur 0xef    : ${natifs}\n`);

  if (natifs) {
    console.log('  ⛔ UN NATIF EXISTE HORS DU PREFIXE. Le prefiltre du radar rend ces tokens invisibles,');
    console.log('     et la regle gelee les declare SAFE sur la foi de leur adresse. Exemples :');
    for (const a of exemples.slice(0, 5)) console.log('     ' + a);
  } else if (lus) {
    console.log(`  ✅ aucun marqueur natif hors prefixe sur ${lus} lecture(s) reussie(s).`);
    console.log('     ⚠️ BORNE: ca ne met pas le taux a zero, ca le borne. Avec 0 sur ' + lus + ', la borne');
    console.log('        haute a 95 % de confiance est environ ' + (100 * 3 / lus).toFixed(1) + ' % (regle de trois).');
  } else {
    console.log('  ⛔ AUCUNE lecture reussie: ce rapport ne dit RIEN. Ce n est pas « propre ».');
  }
  console.log('');
})();
