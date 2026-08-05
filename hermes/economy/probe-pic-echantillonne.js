#!/usr/bin/env node
// probe-pic-echantillonne.js — le troisieme plancher: `peakLiq` est un max sur des POINTS, pas un pic.
// ================================================================================================
// Deux planchers presentes comme des mesures ont deja ete trouves aujourd'hui: `siblingCount` borne
// par une page de lecture, et « survivant » borne par la derniere observation. Voici le troisieme, de
// la meme famille.
//
// token-radar.js decide un rug par `drop = 1 - liq / peakLiq >= 0.80` ET `liq < 2000`. Or `peakLiq`
// n'est PAS le pic de liquidite du token: c'est le maximum sur les instants OU LE RADAR A REGARDE. Le
// vrai pic est >= celui-la, toujours. Donc le denominateur est trop petit, `drop` est SOUS-ESTIME, et
// le test `>= 0.80` se declenche MOINS souvent qu'il ne devrait.
//
// ⚠️ LE SENS DE L'ERREUR EST LE POINT: ce plancher ne peut que MANQUER des rugs, jamais en inventer.
// Un rug manque devient un « survivant » et gonfle tous les taux du cote SUR — exactement comme les
// deux autres planchers. Les trois poussent la mesure dans la meme direction, la rassurante.
//
// ⚠️ CE QU'ON PEUT MESURER ICI: combien de tokens vivants frolent le seuil, c'est-a-dire combien
// basculeraient si le vrai pic avait ete un peu plus haut que le pic observe.
// ⛔ CE QU'ON NE PEUT PAS: connaitre le vrai pic. Il faudrait l'historique de liquidite, que la base ne
// garde pas. Ce rapport borne une EXPOSITION, il ne compte pas des rugs.
//
// Lecture SEULE — aucune ecriture, le radar n'est pas touche.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const RUG_DROP = 0.80;    // recopie de token-radar.js:42 — une divergence future est un ecart a voir
const RUG_FLOOR = 2000;   // token-radar.js:43

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

const vivants = rows.filter((t) => t.outcome === 'live'
  && typeof t.peakLiq === 'number' && t.peakLiq > 0 && typeof t.lastLiq === 'number');

const chute = (t) => 1 - t.lastLiq / t.peakLiq;

console.log(`\n  seuils du radar : chute >= ${(RUG_DROP * 100).toFixed(0)} %  ET  liquidite restante < $${RUG_FLOOR}`);
console.log(`  ${vivants.length} token(s) 'live' avec un pic et une derniere liquidite lisibles\n`);

/* De combien le VRAI pic devrait-il depasser le pic OBSERVE pour que chaque token bascule ?
 * drop_vrai = 1 - liq/pic_vrai >= 0.80  <=>  pic_vrai >= liq / 0.20  =>  facteur = (liq/0.2) / pic_observe */
const sousLeSeuil = vivants.filter((t) => t.lastLiq < RUG_FLOOR && chute(t) < RUG_DROP);
console.log(`  ${sousLeSeuil.length} token(s) passent DEJA le plancher de liquidite (< $${RUG_FLOOR})`);
console.log('  mais ratent le test de chute. Combien le vrai pic devait-il valoir pour qu ils basculent ?\n');
console.log('    facteur requis sur le pic observe    tokens   dont comptes SURVIVANTS');
console.log('    ' + '-'.repeat(66));
for (const f of [1.1, 1.25, 1.5, 2, 3, 5]) {
  const g = sousLeSeuil.filter((t) => (t.lastLiq / (1 - RUG_DROP)) / t.peakLiq <= f);
  const surv = g.filter((t) => issue(t) === 'survived').length;
  console.log(`    pic reel <= ${String(f).padStart(4)} x le pic observe    ${String(g.length).padStart(6)}   ${String(surv).padStart(6)}`);
}

/* La distribution de la chute, pour voir si la population se masse juste sous le seuil — signe qu'un
 * pic sous-estime deplace beaucoup de monde — ou si elle en est loin. */
console.log('\n  distribution de la chute observee chez les vivants sous le plancher de liquidite :');
const bandes = [[0, 0.2], [0.2, 0.5], [0.5, 0.7], [0.7, 0.79], [0.79, 0.8]];
for (const [a, b] of bandes) {
  const n = sousLeSeuil.filter((t) => chute(t) >= a && chute(t) < b).length;
  console.log(`    ${(a * 100).toFixed(0).padStart(3)} % a ${(b * 100).toFixed(0).padStart(3)} %   ${String(n).padStart(5)}`);
}

console.log('\n  ⛔ CE N EST PAS UN COMPTE DE RUGS MANQUES. Le vrai pic est inconnu: la base ne garde pas');
console.log('     l historique de liquidite, seulement le max des instants regardes. Chaque ligne dit');
console.log('     « si le vrai pic valait au moins tant, ce token aurait ete classe rug ».');
console.log('  ⚠️ Et l erreur ne va que DANS UN SENS: un pic sous-estime ne peut que manquer un rug,');
console.log('     jamais en fabriquer. Comme les deux autres planchers, il pousse le cote SUR vers le haut.\n');

/* ── POURQUOI TOUT EST A ZERO, ET POURQUOI CE N'EST PAS UN VIDE ─────────────────────────────────
 * Un token n'entre dans la base qu'au-dessus de MIN_LIQ_WATCH = $5000 (token-radar.js:169), donc
 * `peakLiq >= 5000` toujours. Pour rater un rug il faut `chute < 0.80` avec `liq < 2000`, c'est-a-dire
 * pic < liq/0.2 <= 10000. La bande vulnerable est donc EXACTEMENT pic dans [5000, 10000).
 * En dehors d'elle, le plancher de liquidite implique deja la chute et le pic sous-estime ne peut
 * rien manquer. C'est un argument de MECANISME, pas une absence de donnees. */
const MIN_LIQ_WATCH = 5000;
const bande = vivants.filter((t) => t.peakLiq >= MIN_LIQ_WATCH && t.peakLiq < RUG_FLOOR / (1 - RUG_DROP));
console.log('  ── la bande ou un pic sous-estime pourrait manquer un rug ──\n');
console.log(`    entree minimale du radar        $${MIN_LIQ_WATCH}`);
console.log(`    pic maximal encore vulnerable   $${RUG_FLOOR / (1 - RUG_DROP)}  (= plancher / (1 - seuil de chute))`);
console.log(`    tokens 'live' dans cette bande  ${bande.length} sur ${vivants.length}`);
if (bande.length) {
  const bas = bande.filter((t) => t.lastLiq < RUG_FLOOR).length;
  console.log(`    dont deja sous le plancher      ${bas}`);
}
console.log('\n  => hors de cette bande, `liq < $2000` implique deja une chute >= 80 % (pic >= $10000),');
console.log('     donc le test de chute est REDONDANT et un pic sous-estime ne peut rien manquer.');
console.log('  ⚠️ Le plancher existe donc bel et bien dans le code, et il est INERTE sur cette base.');
console.log('     Le dire est le resultat: un zero explique vaut mieux qu un zero constate.\n');
