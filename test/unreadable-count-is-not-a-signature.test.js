#!/usr/bin/env node
'use strict';
/**
 * Un COMPTE d'inconnus n'identifie pas QUELS inconnus.
 *
 * `token-radar.js` stocke `v.unknowns.length` et jette la liste. La regle annoncee
 * `simulation-et-financeur-lu` conditionne son cote SUR sur `unreadable === 3`, et son commentaire
 * affirmait que trois etait « la signature exacte du chemin simulation ». Trois est une longueur.
 *
 * ⚠️ CE QUE CE FICHIER PROUVE, ET IL PASSE PAR LE PRODUCTEUR: que `assessRugFields` — le chemin INDEX —
 * peut rendre exactement trois inconnus dont la COMPOSITION differe de celle du chemin simulation. Le
 * melange est donc structurel; ce n'est pas un accident du jeu de donnees du jour.
 *
 * ⛔ CE QU'IL NE PROUVE PAS: combien de tokens sont concernes en production. Cela se mesure sur la base
 * (mesure du 2026-08-06: 105 des 319 tokens du seau viennent du chemin index, et l'ecart entre les deux
 * plus gros sous-groupes atteint 47 points), pas dans un test.
 *
 * ⚠️ AUCUNE FIXTURE N'EST FABRIQUEE A LA MAIN AU NIVEAU DU RESULTAT. On construit des ENTREES et on
 * laisse les deux vraies fonctions produire leurs `unknowns` — un test qui fabriquerait directement le
 * tableau ne prouverait rien du code qui tourne.
 */
const assert = require('node:assert');
const { assessRugFields, assessFromSimulationOnly } = require('../lib/rugsignals');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('un compte d inconnus n est pas une signature');

/** Le chemin SIMULATION, avec un verdict honeypot rendu: la base declaree de trois inconnus. */
const parSimulation = () => assessFromSimulationOnly({ ok: true, honeypot: false, sellTax: 3, holders: 400 });

/* ⚠️ LES ONZE CHAMPS DE DANGER SONT FOURNIS DELIBEREMENT. La premiere version de cette fixture les
 * omettait et `assessRugFields` ajoutait un QUATRIEME inconnu — « 11 danger field(s) not reported » —
 * que rien dans la lecture du code n'avait laisse prevoir. Le producteur a corrige la fixture, ce qui
 * est precisement pourquoi ce test l'appelle au lieu de fabriquer un tableau d'inconnus a la main. */
const CHAMPS_DANGER = ['cannot_sell_all', 'selfdestruct', 'external_call', 'cannot_buy',
  'is_mintable', 'transfer_pausable', 'is_blacklisted', 'slippage_modifiable',
  'personal_slippage_modifiable', 'is_proxy', 'trading_cooldown'];

/** Le chemin INDEX, avec TROIS lectures ratees, mais PAS les memes trois.
 *  Illisibles : statut honeypot (champ absent), taxe de vente (absente), owner (absent).
 *  Lisibles   : verrou LP (un detenteur verrouille dont la part se lit), distribution (un wallet dont
 *               la part se lit), compte de detenteurs, et les onze pouvoirs. */
const parIndex = () => assessRugFields({
  ...Object.fromEntries(CHAMPS_DANGER.map((c) => [c, 0])),
  lp_holders: [{ is_locked: 1, percent: '1' }],
  holders: [{ is_contract: 0, percent: '0.1' }],
  holder_count: '400',
}, null);

t('★ le chemin SIMULATION rend bien les trois inconnus revendiques', () => {
  const v = parSimulation();
  assert.strictEqual(v.unknowns.length, 3);
  assert.deepStrictEqual([...v.unknowns].sort(),
    ['LP lock status', 'holder distribution', 'owner'].sort());
});

t('★ le chemin INDEX rend AUSSI trois inconnus, et ce ne sont PAS les memes', () => {
  const v = parIndex();
  assert.strictEqual(v.unknowns.length, 3,
    'la fixture doit produire exactement trois inconnus, sinon le test ne dit rien — obtenu '
    + JSON.stringify(v.unknowns));
  assert.notDeepStrictEqual([...v.unknowns].sort(), [...parSimulation().unknowns].sort(),
    'les deux compositions doivent differer, sinon il n y a pas de melange a demontrer');
});

t('★ ce que la base garde ne permet PAS de les distinguer', () => {
  // `unreadable` est exactement ce que token-radar.js:495 ecrit: la LONGUEUR, rien d autre.
  const stocke = (v) => (Array.isArray(v.unknowns) ? v.unknowns.length : null);
  assert.strictEqual(stocke(parSimulation()), stocke(parIndex()),
    'deux etats du monde differents doivent devenir la MEME valeur stockee — c est le defaut');
  assert.strictEqual(stocke(parSimulation()), 3);
});

t('le discriminant qui EXISTE deja dans la base: ownerState est absent du chemin simulation', () => {
  /* C est ce qui rend la mesure possible sans rien ajouter au radar: le chemin simulation ne pose
   * aucun owner, le chemin index en pose un. La base stocke `basisAtFirstSight.ownerState`. */
  assert.strictEqual(parSimulation().ownerState, undefined,
    'le chemin simulation ne pose aucun ownerState — c est ce qui le rend reconnaissable dans la base');
  assert.strictEqual(parIndex().ownerState, 'unknown',
    'le chemin index en pose un, meme quand l adresse est illisible');
});

t('un honeypot NON tranche fait QUATRE, pas trois — la frontiere du seau se verifie', () => {
  // Le cas OPPOSE du premier: la simulation rend des chiffres sans verdict -> un quatrieme inconnu.
  const v = assessFromSimulationOnly({ ok: true, honeypot: null, sellTax: 3, holders: 400 });
  assert.strictEqual(v.unknowns.length, 4, 'sans verdict honeypot, le compte doit passer a quatre');
  assert.ok(v.unknowns.includes('honeypot verdict'));
});

t('aucune simulation du tout ne fait pas ZERO inconnu — le pire cas ne se lit pas comme le meilleur', () => {
  const v = assessFromSimulationOnly(null);
  assert.strictEqual(v.verdict, 'unknown');
  assert.ok(v.unknowns.length >= 1, 'ne rien avoir lu ne doit jamais rendre un compte d inconnus vide');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
