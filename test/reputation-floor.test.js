#!/usr/bin/env node
'use strict';
/**
 * fetchReputation — un plancher local qui n'a pas tourné se lisait comme un plancher qui a dit « rien ».
 * ======================================================================================================
 * ⚠️ LE DÉFAUT, forme n°6 de la liste du SKILL : la couche du dessous distingue trois cas, celle du
 * dessus les aplatit sur un booléen. `screenAddress` rend explicitement
 *
 *     { blocked:false, available:false, reason:'no known-bad list loaded — screening UNAVAILABLE, not a clean verdict' }
 *
 * et `fetchReputation` ne lisait que `blocked`. Deux états de preuve DIFFÉRENTS sortaient identiques :
 *
 *     liste indisponible     + oracle répond OK  ->  { decision:'OK', source:'mainstreet-oracle' }
 *     liste chargée, absente + oracle répond OK  ->  { decision:'OK', source:'mainstreet-oracle' }
 *
 * Dans le premier cas le plancher local n'a JAMAIS tourné — et ce plancher est précisément ce qui tient
 * quand l'oracle se trompe. Le défaut n'est visible dans aucun des deux modules pris seul : uniquement
 * en les comparant. Le même fait est divulgué ailleurs dans ce dépôt
 * (`wallet-watch.judgeCounterparty`), ce qui rend l'omission plus nette : la bonne réponse était déjà
 * écrite, dans un autre fichier.
 *
 * ⚠️ LES BORNES. Tout ceci serait satisfait par une fonction qui met un avertissement partout : quand le
 * plancher A tourné, il ne doit y avoir AUCUN `caveat`, sinon l'avertissement devient du bruit et on
 * apprend à le sauter — la faute que ce dépôt appelle « un garde qui crie au loup se fait désinstaller ».
 *
 * Run: node test/reputation-floor.test.js
 */
const assert = require('node:assert');
const { fetchReputation } = require('../bin/biii-mcp');

let pass = 0, fail = 0;
const t = async (n, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + n); }
  catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e && e.message)); }
};
/* La suite se compte elle-même : une promesse qui ne se résout jamais ferait sortir Node en 0, ce qui se
 * lit exactement comme un succès. Leçon payée une heure plus tôt sur listing-manifest. */
const ATTENDUS = 8;
setTimeout(() => {
  console.log('\n  FAIL le fichier ne s\'est pas terminé — ' + pass + '/' + ATTENDUS + ' cas exécutés.');
  process.exit(1);
}, 15000);

const ADR = '0x' + 'a1'.repeat(20);
const MAUVAISE = '0x' + 'bd'.repeat(20);
/* Deux planchers: un chargé (avec une adresse dedans), un indisponible. La forme est celle que
 * `loadScreen` produit — un Set + la disponibilité. */
const CHARGE = { set: new Set([MAUVAISE]), available: true, sources: ['test'], asOf: '2026-07-29' };
const ABSENT = { set: new Set(), available: false, sources: [], asOf: null };
const oracleOK = async () => ({ decision: 'OK', score: 80 });
const oracleMuet = async () => ({ error: 'oracle unreachable' });

(async () => {
  console.log('fetchReputation — le plancher local a-t-il tourné, oui ou non ?\n');

  await t('★ plancher INDISPONIBLE + oracle qui répond : le verdict le DIT', async () => {
    const r = await fetchReputation(ADR, { floor: ABSENT, oracle: oracleOK });
    assert.equal(r.decision, 'OK', 'la lecture de l\'oracle passe toujours');
    assert.equal(r.localScreen.available, false, 'et le plancher se déclare non disponible');
    assert.match(r.caveat, /did NOT run/, 'un avertissement explicite doit accompagner ce verdict');
    assert.match(r.caveat, /oracle ALONE/, 'et dire sur quoi il repose vraiment');
  });

  await t('★ BORNE: plancher CHARGÉ + oracle qui répond : AUCUN avertissement', async () => {
    const r = await fetchReputation(ADR, { floor: CHARGE, oracle: oracleOK });
    assert.equal(r.decision, 'OK');
    assert.equal(r.localScreen.available, true);
    assert.equal(r.caveat, undefined, 'crier au loup quand tout va bien apprend à ignorer les alertes');
  });

  await t('★ les deux cas ne sont plus indiscernables', async () => {
    const a = await fetchReputation(ADR, { floor: ABSENT, oracle: oracleOK });
    const b = await fetchReputation(ADR, { floor: CHARGE, oracle: oracleOK });
    assert.notDeepStrictEqual(a, b, 'c\'est exactement ce qui était identique avant');
  });

  await t('★ BORNE: une adresse sur la liste reste BLOQUÉE, sans passer par l\'oracle', async () => {
    let appele = false;
    const r = await fetchReputation(MAUVAISE, { floor: CHARGE, oracle: async () => { appele = true; return { decision: 'OK' }; } });
    assert.equal(r.decision, 'BLOCK');
    assert.equal(r.source, 'local-known-bad');
    assert.equal(appele, false, 'le plancher local doit court-circuiter l\'oracle, pas le consulter');
  });

  await t('   et le blocage porte lui aussi l\'état du plancher', async () => {
    const r = await fetchReputation(MAUVAISE, { floor: CHARGE, oracle: oracleOK });
    assert.equal(r.localScreen.available, true);
    assert.match(r.localScreen.reason, /known-bad list/);
  });

  await t('BORNE: plancher chargé + oracle muet reste un `null` honnête, jamais un « clean »', async () => {
    const r = await fetchReputation(ADR, { floor: CHARGE, oracle: oracleMuet });
    assert.equal(r, null, 'aucun signal vivant ne doit se déguiser en verdict');
  });

  await t('BORNE: plancher indisponible + oracle muet reste null aussi', async () => {
    const r = await fetchReputation(ADR, { floor: ABSENT, oracle: oracleMuet });
    assert.equal(r, null);
  });

  await t('un score sans décision compte comme une réponse de l\'oracle', async () => {
    const r = await fetchReputation(ADR, { floor: CHARGE, oracle: async () => ({ score: 42 }) });
    assert.equal(r.score, 42);
    assert.equal(r.source, 'mainstreet-oracle');
  });

  const manquants = ATTENDUS - (pass + fail);
  if (manquants !== 0) { fail++; console.log('  FAIL le compte ne tombe pas : ' + (pass + fail - 1) + '/' + ATTENDUS); }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
