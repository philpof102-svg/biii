#!/usr/bin/env node
'use strict';
/**
 * creator-state.test.js — « createur inconnu » doit vouloir dire la meme chose aux cinq endroits.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER EMPECHE DE REVENIR. Cinq sites de scoring dans launchers-integration-v2/v3
 * demandaient « createur inconnu ? » de deux facons, dont une qui ne pouvait JAMAIS etre vraie:
 *
 *     if (!token.creator || token.creator === '0x000...') score += 40;   // v2:186 v3:197 (+40) v3:345 (+35)
 *     if (!launch.creator) score += 50;                                  // v2:230 v3:241
 *
 * `'0x000...'` contient des POINTS litteraux — c'est une forme d'AFFICHAGE. Un createur reel fait `0x`
 * + 40 hex, donc la clause etait morte, et le trou qu'elle laissait ouvert etait celui-ci: un token dont
 * l'API annonce `creator: '0x0000...0000'` ne marquait AUCUN point sur les cinq sites.
 *
 * 🧬 LA MEME FORME A DEJA ETE UN DEFAUT MESURE ICI: voir test/owner-state.test.js:10, ou
 * `if (!o || o === '0x000…0') return false;` testait deux etats sur un champ qui en a trois.
 *
 * 👯 LE JUMEAU. Les deux sites Bankr posaient la question SANS le litteral: une recherche de
 * `'0x000...'` ne les trouve pas. Le dernier test de ce fichier ne consulte donc aucune liste ecrite a
 * la main — il ENUMERE les moniteurs des deux modules et exige que tout site sensible au createur le
 * soit identiquement pour chaque orthographe de l'inconnu. Un sixieme site ajoute « en clair » demain
 * echouera ici sans que personne ait pense a l'inscrire.
 *
 * ⚠️ CE TEST NE REIMPLEMENTE PAS LE SCORING. Il appelle le VRAI `assessRisk` des VRAIES classes, via
 * `new LaunchersIntegration().monitors`. Il ne fait aucun appel reseau: `assessRisk` est pur.
 *
 * 📐 LES BORNES VOYAGENT AVEC LES CHIFFRES. Chaque attendu (+40, +50, +35) est ecrit ici avec son site.
 * Un bareme deplace en douce fait echouer ce fichier — c'est voulu: modifier un palier est une decision
 * produit, pas un effet de bord.
 *
 * ⚖️ PORTEE. Prouve la FORME du jugement et le bareme applique. Ne prouve PAS que ces modules tournent
 * (mesure du 2026-08-05: les cinq API amont sont muettes — 404, connexion refusee, HTML, 530 — donc
 * `assessRisk` ne note aucun token en production ce jour-la), ni ce que « createur inconnu » DEVRAIT
 * valoir.
 */

const assert = require('node:assert/strict');
const { creatorState, creatorIsUnknown } = require('../lib/creator-state');

let pass = 0, fail = 0;
const t = (nom, fn) => {
  try { fn(); pass++; console.log('  ok   ' + nom); }
  catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
};

const VRAI_CREATEUR = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const LITTERAL_MORT = '0x000...';

console.log('les etats du champ createur:');
t('une adresse reelle se lit known', () => assert.equal(creatorState(VRAI_CREATEUR), 'known'));
t('la casse ne change pas le verdict', () => assert.equal(creatorState(VRAI_CREATEUR.toUpperCase().replace('0X', '0x')), 'known'));
t('un champ ABSENT se lit unknown', () => assert.equal(creatorState(undefined), 'unknown'));
t('null se lit unknown', () => assert.equal(creatorState(null), 'unknown'));
t('la chaine vide se lit unknown', () => assert.equal(creatorState(''), 'unknown'));
t("L'ADRESSE ZERO se lit unknown — pas de cle privee, donc aucun deploiement signe", () => assert.equal(creatorState(ZERO), 'unknown'));
t('la dead address se lit unknown pour la meme raison', () => assert.equal(creatorState(DEAD), 'unknown'));
t("le litteral d'affichage '0x000...' se lit unknown, jamais comme un createur", () => assert.equal(creatorState(LITTERAL_MORT), 'unknown'));
t('une adresse tronquee a l affichage se lit unknown', () => assert.equal(creatorState('0xd8da6bf2…6045'), 'unknown'));
t('41 caracteres (le defaut deja vu dans watchlist.json) se lit unknown', () => assert.equal(creatorState(VRAI_CREATEUR + 'a'), 'unknown'));
t('39 caracteres se lit unknown', () => assert.equal(creatorState(VRAI_CREATEUR.slice(0, -1)), 'unknown'));

t("⚠️ ownerState et creatorState rendent des verdicts OPPOSES sur l'adresse zero, et c'est correct", () => {
  const { ownerState } = require('../lib/rugsignals');
  assert.equal(ownerState({ owner_address: ZERO }), 'renounced');   // bonne nouvelle: plus personne ne tire
  assert.equal(creatorState(ZERO), 'unknown');                      // pas une observation: un bouche-trou
});

/* ── Le vrai scoring, sur les vraies classes ─────────────────────────────────────────────────────── */

const MODULES = [
  { nom: 'launchers-integration-v2', chemin: '../hermes/agents/biii-monitor/launchers-integration-v2.js',
    attendus: { toshimart: 40, bankr: 50 } },
  { nom: 'launchers-integration-v3', chemin: '../hermes/agents/biii-monitor/launchers-integration-v3.js',
    attendus: { toshimart: 40, bankr: 50, b20: 35 } },
];

/* Base DELIBEREMENT saine sur tous les seuils des cinq moniteurs, pour deux raisons: le score de
 * reference vaut 0, donc l'ecart mesure vient du seul champ createur; et la somme reste loin de 100,
 * donc `Math.min(score, 100)` ne peut pas ecraser l'ecart et faire passer un test pour vert. */
const base = () => ({
  marketCap: 1e9, usd_market_cap: 1e9, volume24h: 1e9, replies: 1000,
  name: 'Sain', symbol: 'SAIN', deployer: VRAI_CREATEUR,
});
const avecCreateur = (c) => (c === undefined ? base() : Object.assign(base(), { creator: c }));

for (const { nom, chemin, attendus } of MODULES) {
  const { LaunchersIntegration } = require(chemin);
  const monitors = new LaunchersIntegration().monitors;

  console.log(`\n${nom} — ce que le createur coute, par moniteur:`);

  t(`${nom} : un createur reel ne coute rien sur AUCUN moniteur`, () => {
    for (const [plateforme, m] of Object.entries(monitors)) {
      assert.equal(m.assessRisk(avecCreateur(VRAI_CREATEUR)), 0,
        `${plateforme}: une base saine + createur connu doit valoir 0, sinon l ecart mesure plus bas ne mesure pas le createur`);
    }
  });

  for (const [plateforme, points] of Object.entries(attendus)) {
    const m = monitors[plateforme];

    t(`${nom}/${plateforme} : createur ABSENT coute exactement +${points}`, () => {
      assert.ok(m, `${plateforme} n existe plus dans ce module`);
      assert.equal(m.assessRisk(avecCreateur(undefined)), points);
    });

    t(`${nom}/${plateforme} : LE CORRECTIF — l'adresse zero coute aussi +${points} (valait 0 avant)`, () => {
      assert.equal(m.assessRisk(avecCreateur(ZERO)), points);
    });

    t(`${nom}/${plateforme} : la dead address coute +${points}`, () => {
      assert.equal(m.assessRisk(avecCreateur(DEAD)), points);
    });

    t(`${nom}/${plateforme} : le litteral mort '0x000...' coute +${points}`, () => {
      assert.equal(m.assessRisk(avecCreateur(LITTERAL_MORT)), points);
    });
  }

  /* ⛔ LE GARDE ANTI-JUMEAU. Aucune liste ecrite a la main: on enumere. Tout moniteur qui REAGIT a un
   * createur absent doit reagir PAREIL a chaque autre orthographe de l'inconnu. Les moniteurs qui ne
   * notent pas le createur (pump.fun, clankr) sont reconnus comme tels et non inventes. */
  t(`${nom} : AUCUN moniteur ne traite l'adresse zero autrement qu'un createur absent`, () => {
    const notentLeCreateur = [];
    for (const [plateforme, m] of Object.entries(monitors)) {
      const connu = m.assessRisk(avecCreateur(VRAI_CREATEUR));
      const absent = m.assessRisk(avecCreateur(undefined));
      if (absent === connu) continue;                 // ce moniteur ne note pas le createur
      notentLeCreateur.push(plateforme);
      for (const [etiquette, valeur] of [['zero', ZERO], ['dead', DEAD], ['litteral', LITTERAL_MORT]]) {
        assert.equal(m.assessRisk(avecCreateur(valeur)), absent,
          `${plateforme}: createur=${etiquette} note ${m.assessRisk(avecCreateur(valeur))} alors qu'un createur ABSENT note ${absent} — `
          + 'deux orthographes du meme inconnu, deux scores: c est la divergence que ce fichier existe pour empecher');
      }
    }
    assert.deepEqual(notentLeCreateur.sort(), Object.keys(attendus).sort(),
      `les moniteurs sensibles au createur ont change: ${notentLeCreateur.join(',')} — `
      + 'si un site a ete ajoute ou retire, ce test doit etre relu, pas contourne');
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
