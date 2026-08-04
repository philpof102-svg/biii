#!/usr/bin/env node
// replay-b20-vetmeme.js — `vetMeme` sait-il retrouver un B20 natif VIVANT ?
// ================================================================================================
// `vetMeme` repond a « quel contrat porte VRAIMENT ce symbole ? » en classant les candidats par
// liquidite. C'est un tool a verdict, il est expose en MCP, et il ne consulte pas `classifyB20`.
//
// Le risque a mesurer n'est pas theorique: si un indexeur de liquidite traite un precompile
// autrement qu'un ERC-20, alors pour un symbole porte par un B20 natif, `vetMeme` peut soit
// n'annoncer AUCUN contrat credible (`thin`), soit — bien pire — couronner un ERC-20 imposteur
// comme canonique parce que c'est le seul qu'il voit. Un agent qui demande « lequel est le vrai »
// serait alors dirige vers le faux, par notre propre reponse.
//
// ⚠️ PREMIER ESSAI RATE, et il vaut d'etre dit: j'ai teste MECHACOIN, qui a RUGGE. `thin` y est la
// bonne reponse — sa liquidite est nulle. Un token mort ne peut pas mesurer une cecite d'indexation.
// On ne teste donc que des natifs ENCORE VIVANTS, tries par liquidite reelle.
//
// Lecture SEULE. Appels DexScreener publics et gratuits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { vetMeme } = require('../../lib/meme.js');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const IMPOSTEUR = '0xb200fb5839afa4d7761981143617c5799f063b7f';
const natifsVivants = rows
  .filter((t) => String(t.addr).toLowerCase().startsWith('0xb200')
    && String(t.addr).toLowerCase() !== IMPOSTEUR
    && t.outcome === 'live')
  .sort((a, b) => (b.lastLiq || 0) - (a.lastLiq || 0));

const N = Number(process.argv[2] || 6);
const echantillon = natifsVivants.slice(0, N);

async function main() {
  console.log(`\n  natifs B20 encore vivants dans la base : ${natifsVivants.length}`);
  console.log(`  sondes (les ${echantillon.length} plus liquides) :\n`);

  const par = new Map();
  let pointeVersAutreChose = 0;
  for (const t of echantillon) {
    let r = null, panne = null;
    try { r = await vetMeme({ symbol: t.sym, chainId: 'base', address: t.addr }); }
    catch (e) { panne = (e && e.message) || String(e); }

    if (panne) { console.log(`    ${String(t.sym).padEnd(14)} ⚠️ NON LU : ${panne}`); par.set('NON LU', (par.get('NON LU') || 0) + 1); continue; }

    const canon = r.canonical && r.canonical.address ? String(r.canonical.address).toLowerCase() : null;
    par.set(r.status, (par.get(r.status) || 0) + 1);

    /* LE CAS QUI COUTE: un canonique DIFFERENT du natif qu'on interroge. La reponse dirigerait alors
     * un acheteur vers un autre contrat que celui qu'il tient — c'est le seul resultat de ce script
     * qui serait un defaut, et non une simple absence de couverture. */
    const detourne = canon && canon !== String(t.addr).toLowerCase();
    if (detourne) pointeVersAutreChose++;

    console.log(`    ${String(t.sym).padEnd(14)} liq=${String(Math.round(t.lastLiq || 0)).padStart(7)}  ${String(r.status).padEnd(14)}`
      + `${canon ? ' canon=' + canon.slice(0, 12) + '…' : ' canon=aucun'}${detourne ? '   ⛔ POINTE AILLEURS' : ''}`);
  }

  console.log('\n  distribution des verdicts :');
  for (const [k, n] of [...par.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(16)} ${n}`);

  console.log('');
  if (pointeVersAutreChose) {
    console.log(`  ⛔ ${pointeVersAutreChose} reponse(s) designent un contrat AUTRE que le natif interroge.`);
    console.log('     C est le cas couteux: un acheteur serait dirige vers un autre contrat par notre reponse.');
  } else {
    console.log('  ✅ Aucune reponse ne designe un autre contrat que celui interroge.');
    console.log('     La cecite B20 de vetMeme ne produit donc PAS de fausse designation ici — c est une');
    console.log('     absence de couverture, pas une erreur d aiguillage. Les deux se corrigent');
    console.log('     differemment, et les confondre ferait ecrire la mauvaise regle.');
  }
  console.log(`\n  ⚠️ n=${echantillon.length}. Un echantillon de cette taille peut montrer qu un defaut EXISTE,`);
  console.log('     jamais qu il est absent.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
