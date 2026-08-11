'use strict';
// gitlawb × BIII trust composition — offline, pure. Run: node test/gitlawb-trust.test.js
const assert = require('node:assert');
const { combineAgentTrust, requiredTrust } = require('../lib/gitlawb-trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII × gitlawb — reputation composes with safe-to-pay, fail-closed:');

t('a BIII block is DECISIVE — no gitlawb reputation buys back a denylisted address', () => {
  const r = combineAgentTrust({ biiiAllowed: false, biiiDecision: 'deny', gitlawbTrust: 0.99, amountUsd: '10' });
  assert.equal(r.release, false);
  assert.equal(r.tier, 'blocked');
  assert.match(r.reason, /cannot override/);
});

t('amount-scaled bar: small payout releases on a FRESH agent (0.05); large payout does NOT', () => {
  const small = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.05, amountUsd: '50' });
  assert.equal(small.release, true, '$50 to a fresh but BIII-clear agent is fine');
  assert.equal(small.needed, 0);
  const big = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.05, amountUsd: '250' });
  assert.equal(big.release, false, '$250 needs standing (0.2) the fresh 0.05 agent lacks');
  assert.equal(big.tier, 'caution');
  assert.equal(big.needed, 0.2);
});

t('a reputable agent (0.7) clears a large payout; the 1000+ bar is 0.5', () => {
  assert.equal(requiredTrust('1000'), 0.5);
  const r = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.7, amountUsd: '2000' });
  assert.equal(r.release, true);
  assert.equal(r.tier, 'reputable');
  // exactly at the bar releases; a hair under does not
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.5, amountUsd: '1000' }).release, true);
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.49, amountUsd: '1000' }).release, false);
});

/* ── LE SEUIL 0.2 EST LE SEUL QUE NOTRE PROPRE AGENT TOUCHE, ET IL N'AVAIT PAS DE TEST DE BORD ──────
 * Mesure du 2026-08-11: `gl node trust did:key:z6Mku...` rend Score 0.20 / Level contributor / Pushes 3.
 * `requiredTrust(100..999)` vaut exactement 0.2. Notre agent est donc PILE au bord du palier moyen —
 * et le seuil 0.5 avait ses deux bords testes (0.5 -> true, 0.49 -> false) tandis que 0.2 n'etait
 * approche qu'a 0.05, loin dessous.
 * ⚠️ CE QUE LA MUTATION A CORRIGE DANS MON PROPRE RAISONNEMENT: `>=` -> `>` sur cette ligne etait DEJA
 * attrape par le bord 0.5 existant. Le trou n'etait donc pas total. Ce qui n'etait couvert par RIEN,
 * c'est le seuil 0.2 lui-meme et le bord du MONTANT dans `requiredTrust` — muter `amt >= 100` en
 * `amt > 100` laissait l'ancienne suite VERTE. C'est cette mutation-la que les cas ci-dessous arretent.
 * ⛔ Un comparateur se teste avec TROIS elements, le cas special AU MILIEU. */
t('le seuil 0.2 aux trois bords — 0.19 refuse, 0.20 (notre agent) passe, 0.21 passe', () => {
  const sous = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.19, amountUsd: '100' });
  assert.equal(sous.release, false, '0.19 est SOUS la barre du palier 100-999');
  assert.equal(sous.tier, 'caution');
  const pile = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.2, amountUsd: '100' });
  assert.equal(pile.release, true, 'a la barre EXACTE on libere — c est la position de notre propre agent');
  assert.equal(pile.tier, 'ok', 'au bord du palier moyen on est `ok`, jamais `reputable`');
  assert.equal(pile.needed, 0.2);
  const dessus = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: 0.21, amountUsd: '100' });
  assert.equal(dessus.release, true);
});

/* ⚠️ RATE RAPPORTE A COTE DE LA PRISE: j'ai d'abord soupconne une fragilite FLOTTANTE au seuil (le score
 * n'est lisible qu'a deux decimales via `gl node trust`). MESURE: tous les chemins plausibles — littéral,
 * `parseFloat('0.20')`, 0.05*4, 0.05 additionne quatre fois — rendent le MEME double 0.20000000000000001110
 * et franchissent la barre. La fragilite n'existe pas. On la fige ici pour qu'elle ne naisse pas plus tard. */
t('un score reconstruit par ACCUMULATION franchit la barre comme le littéral (pas de piege flottant)', () => {
  const accumule = 0.05 + 0.05 + 0.05 + 0.05;
  assert.equal(accumule >= 0.2, true, 'si ceci casse un jour, le palier moyen se ferme en silence');
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: accumule, amountUsd: '500' }).release, true);
});

/* ⛔ LE BORD DU MONTANT, l'autre moitie du meme comparateur: `>= 100` bascule le seuil requis de 0 a 0.2.
 * Un agent frais est donc libere a 99,99 $ et retenu a 100,00 $ — c'est voulu, mais ce n'etait pas prouve. */
t('le bord du MONTANT: 99,99 $ ne demande aucune standing, 100,00 $ en demande', () => {
  assert.equal(requiredTrust('99.99'), 0);
  assert.equal(requiredTrust('100'), 0.2);
  assert.equal(requiredTrust('999.99'), 0.2);
  assert.equal(requiredTrust('1000'), 0.5);
  const frais = { biiiAllowed: true, gitlawbTrust: 0.05 };
  assert.equal(combineAgentTrust({ ...frais, amountUsd: '99.99' }).release, true, 'sous 100 un agent frais passe');
  assert.equal(combineAgentTrust({ ...frais, amountUsd: '100' }).release, false, 'a 100 pile il ne passe plus');
});

t('unavailable reputation → only sub-$100 payouts proceed (fail-closed on the missing signal)', () => {
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: null, amountUsd: '99' }).release, true);
  assert.equal(combineAgentTrust({ biiiAllowed: true, gitlawbTrust: undefined, amountUsd: '100' }).release, false);
  // a garbage / negative score is treated as unavailable, not as a real 0
  const bad = combineAgentTrust({ biiiAllowed: true, gitlawbTrust: -1, amountUsd: '500' });
  assert.equal(bad.gitlawbTrust, null);
  assert.equal(bad.release, false);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
