'use strict';
/**
 * launchers-no-fabrication.test.js — une lecture ratee ne fabrique pas d'observations.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER EMPECHE DE REVENIR. Trois moniteurs de lancements sur neuf rendaient
 * `getMockData()` depuis leur `catch`: jusqu'a cinq tokens dont l'ADRESSE et le CREATEUR sortaient de
 * Math.random(), avec un `risk` tire au sort, et sans poser `lastError`. Mesure sur un echec reseau
 * force, avant correctif: scanAllPlatforms() publiait « totalTokens: 10 » — 1 medium-risk, 9
 * low-risk — et ne declarait que 3 plateformes sur 5 comme NON LUES.
 *
 * Les six autres moniteurs faisaient deja la bonne chose, et c'est ce qui rendait le trou invisible:
 * la franchise des uns faisait lire le silence des autres comme une bonne nouvelle.
 *
 * ⚠️ CE TEST NE FABRIQUE PAS SON ENTREE. Il ne passe pas un faux `fetch`: il pointe les vraies URL
 * sur un port ferme en loopback et laisse le VRAI chemin d'erreur s'executer. Ce qui est teste est le
 * `catch` de production, pas une reconstitution.
 *
 * Portee: prouve la forme du retour sur echec reseau. Ne prouve PAS a quelle frequence cet echec
 * survient en production, ni que ces modules sont planifies sur la flotte distante.
 */

const assert = require('node:assert/strict');

const MODULES = [
  { nom: 'launchers-integration-v2', chemin: '../hermes/agents/biii-monitor/launchers-integration-v2.js' },
  { nom: 'launchers-integration-v3', chemin: '../hermes/agents/biii-monitor/launchers-integration-v3.js' },
];

let pass = 0, fail = 0;
async function ta(nom, fn) {
  try { await fn(); pass++; console.log(`  ok   ${nom}`); }
  catch (e) { fail++; console.log(`  FAIL ${nom}\n       ${e.message}`); }
}

(async () => {
  for (const { nom, chemin } of MODULES) {
    const mod = require(chemin);
    const { LaunchersIntegration, PLATFORMS } = mod;
    /* Port 1 en loopback: ECONNREFUSED immediat, deterministe, sans sortir de la machine. */
    for (const k of Object.keys(PLATFORMS)) PLATFORMS[k].apiUrl = 'http://127.0.0.1:1';

    await ta(`${nom} : aucun moniteur ne fabrique de token apres un echec reseau`, async () => {
      const suite = new LaunchersIntegration();
      for (const [plateforme, monitor] of Object.entries(suite.monitors)) {
        const out = await monitor.getRecentLaunches(20);
        assert.ok(Array.isArray(out), `${plateforme}: doit rendre un tableau`);
        assert.equal(out.length, 0,
          `${plateforme}: a rendu ${out.length} token(s) alors que le reseau a echoue — `
          + `exemple address=${out[0] && out[0].address}`);
      }
    });

    await ta(`${nom} : chaque echec pose SA cause — un vide muet passerait pour « rien lance »`, async () => {
      const suite = new LaunchersIntegration();
      for (const [plateforme, monitor] of Object.entries(suite.monitors)) {
        await monitor.getRecentLaunches(20);
        assert.ok(monitor.lastError, `${plateforme}: vide SANS cause — indiscernable d une absence de lancements`);
      }
    });

    await ta(`${nom} : plus aucun getMockData — la fabrication ne peut pas revenir par une autre porte`, async () => {
      const suite = new LaunchersIntegration();
      for (const [plateforme, monitor] of Object.entries(suite.monitors)) {
        assert.equal(typeof monitor.getMockData, 'undefined',
          `${plateforme}: getMockData existe encore — un appelant peut le rappeler`);
      }
    });

    await ta(`${nom} : l agregat publie ZERO token et declare TOUTES les plateformes non lues`, async () => {
      const suite = new LaunchersIntegration();
      suite.saveResults = () => {};   // on neutralise la seule ecriture disque, pas la logique
      const r = await suite.scanAllPlatforms();
      const plateformes = Object.keys(r.platforms).length;
      assert.equal(r.summary.totalTokens, 0, 'aucun token n existe: le total doit etre 0');
      assert.equal(r.summary.highRisk + r.summary.mediumRisk + r.summary.lowRisk, 0,
        'aucun niveau de risque ne peut etre attribue a des tokens jamais lus');
      assert.equal((r.unavailable || []).length, plateformes,
        `${(r.unavailable || []).length} plateforme(s) declarees NON LUES sur ${plateformes} — `
        + 'une plateforme muette est lue comme saine');
      for (const [plateforme, p] of Object.entries(r.platforms)) {
        assert.ok(p.unavailable, `${plateforme}: publie sans cause d indisponibilite`);
      }
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
