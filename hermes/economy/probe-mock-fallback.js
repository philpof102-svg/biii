#!/usr/bin/env node
// probe-mock-fallback.js — ce que rend un moniteur de lancements quand le reseau ECHOUE.
// ================================================================================================
// launchers-integration-v3.js porte deja le correctif « NON LU != aucun lancement »: cinq moniteurs
// posent `lastError` et rendent []. Deux ne le font pas — ils rendent `getMockData()`, c'est-a-dire
// jusqu'a cinq tokens FABRIQUES, adresse et createur tires de Math.random(), `risk` tire au sort.
//
// Cet instrument ne raisonne pas sur le code: il fait ECHOUER l'appel reseau pour de vrai et lit ce
// qui sort. Le port 1 sur 127.0.0.1 refuse la connexion — l'echec est deterministe et local, aucune
// dependance a un service tiers.
//
// Ce qu'il peut prouver: la forme du retour et l'etat de `lastError` apres un echec reseau.
// Ce qu'il ne peut PAS prouver: a quelle frequence cet echec survient en production.
//
// Lecture SEULE.
'use strict';

const mod = require('../agents/biii-monitor/launchers-integration-v3.js');
const { LaunchersIntegration, PLATFORMS } = mod;

/* On casse les URL AVANT de construire les moniteurs: un port ferme en loopback donne ECONNREFUSED
 * sans sortir de la machine. */
for (const k of Object.keys(PLATFORMS)) PLATFORMS[k].apiUrl = 'http://127.0.0.1:1';

(async () => {
  const suite = new LaunchersIntegration();
  console.log('\n  echec reseau force (ECONNREFUSED) sur chaque plateforme :\n');
  console.log('    plateforme        rendu    lastError         verdict');
  console.log('    ' + '-'.repeat(66));

  let muets = 0, fabriques = 0;
  for (const [nom, monitor] of Object.entries(suite.monitors)) {
    const out = await monitor.getRecentLaunches(20);
    const err = monitor.lastError || null;
    const n = Array.isArray(out) ? out.length : -1;
    const invente = Array.isArray(out) && out.length > 0;
    if (invente) fabriques++;
    if (!err) muets++;
    const verdict = invente
      ? 'FABRIQUE ' + n + ' tokens'
      : (err ? 'ok — vide + cause' : 'vide MAIS muet');
    console.log(`    ${nom.padEnd(16)} ${String(n).padStart(4)}    ${(err ? 'pose' : 'ABSENT').padEnd(16)}  ${verdict}`);
    if (invente) {
      const t = out[0];
      console.log(`        -> exemple : address=${t.address} creator=${t.creator} risk=${t.risk}`);
    }
  }

  console.log(`\n  ${fabriques} plateforme(s) rendent des tokens INVENTES apres un echec reseau.`);
  console.log(`  ${muets} plateforme(s) ne posent AUCUNE cause — l appelant les lit comme saines.\n`);

  /* ── CE QUE L'APPELANT EN FAIT ──────────────────────────────────────────────────────────────
   * On ne reimplemente PAS l'agregation: on appelle la vraie, en neutralisant la seule ecriture
   * disque. Reecrire la somme ici prouverait ma lecture du code, pas le comportement du code. */
  const suite2 = new LaunchersIntegration();
  suite2.saveResults = () => {};
  const r = await suite2.scanAllPlatforms();
  console.log('\n  ce que scanAllPlatforms() publie sur ce meme echec :\n');
  console.log(`    totalTokens .......... ${r.summary.totalTokens}   (aucun n existe)`);
  console.log(`    highRisk ............. ${r.summary.highRisk}`);
  console.log(`    mediumRisk ........... ${r.summary.mediumRisk}`);
  console.log(`    lowRisk .............. ${r.summary.lowRisk}`);
  console.log(`    unavailable .......... ${r.unavailable ? r.unavailable.length : 0} plateforme(s) declarees NON LUES`);
  const nommees = (r.unavailable || []).map((u) => u.platform);
  console.log(`      -> ${nommees.length ? nommees.join(', ') : '(aucune)'}`);
  for (const [nom, p] of Object.entries(r.platforms)) {
    console.log(`    ${nom.padEnd(12)} count=${String(p.count).padStart(2)} unavailable=${p.unavailable ? 'oui' : 'NON'}`);
  }
  console.log('');
})();
