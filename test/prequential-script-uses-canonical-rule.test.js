#!/usr/bin/env node
'use strict';
/**
 * prequential-script-uses-canonical-rule.test.js
 * ================================================================================================
 * `scripts/prequential.js` recalcule les taux que ce projet PUBLIE. Il portait sa propre copie de
 * la regle d'issue, sous un commentaire qui affirmait le contraire :
 *
 *     /** Resolved, open, or rugged — the same rule the scorecard uses, so the two never disagree. *\/
 *     const resolve = (r) => (r.outcome === 'rugged' ? 'rugged'
 *       : ((now - Date.parse(r.firstSeen)) / 3600000 >= W ? 'survived' : 'open'));
 *
 * La copie testait l'age depuis la PREMIERE vue. Le canonique
 * (`lib/prequential.js:outcomeKnownAt`, corrige le 2026-08-05) exige `min(lastSeen, t) - firstSeen
 * >= W` : il ne suffit pas que le token ait VIEILLI, il faut l'avoir VU VIVANT a cet age. Sans ca,
 * un pool entierement retire — `token-radar.js` fait `if (liq == null) continue;` sans regrader —
 * gele sa ligne et vieillit en « survivant ».
 *
 * MESURE sur la base reelle (3 212 tokens, W = 14 h, 2026-08-20) : survived 857 -> 530, open
 * 63 -> 390, baseRate 0.728 -> 0.812, 327 lignes en desaccord ; 675 des 920 tokens 'live' non relus
 * depuis plus de 24 h. Le LIFT survivait (+16 -> +17 pts), chaque taux ABSOLU bougeait de ~8 points.
 *
 * ⛔ BORNES. Ce fichier verifie que le script DELEGUE et que les deux regles different vraiment sur
 * le cas qui les separe. Il ne verifie PAS les taux publies : `lib/announced-rules.js` porte des
 * chiffres FIGES produits sous l'ancienne regle, il est gele par convention, et requalifier un pari
 * annonce apres coup est une decision humaine.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { outcomeKnownAt } = require('../lib/prequential');

let pass = 0, fail = 0;
const ok = (nom, cond, detail) => { if (cond) { pass++; console.log('  ok    ' + nom); } else { fail++; console.log('  FAIL  ' + nom + (detail ? '  -> ' + detail : '')); } };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prequential.js'), 'utf8');

console.log('\n  le script DELEGUE la regle d issue au canonique');
ok('il importe outcomeKnownAt depuis lib/prequential', /require\('\.\.\/lib\/prequential'\)/.test(SRC) && /outcomeKnownAt/.test(SRC));
ok('et son `resolve` L APPELLE', /const resolve = \(r\) => outcomeKnownAt\(r, now, W\)/.test(SRC));

console.log('\n  aucune COPIE de la regle ne subsiste dans le script');
{
  // Le motif exact de la copie : un test d age depuis firstSeen, compare a W, produisant 'survived'.
  const code = SRC.split('\n').filter((l) => !/^\s*[*/]/.test(l)).join('\n');   // hors blocs de commentaire
  ok('plus de `(now - Date.parse(r.firstSeen)) / 3600000 >= W` dans le CODE',
    !/\(now - Date\.parse\(r\.firstSeen\)\) \/ 3600000 >= W/.test(code));
  // DETECTION POWER du filtre lui-meme : la ligne fautive, si elle revenait, serait vue.
  const revenue = "  const resolve = (r) => (r.outcome === 'rugged' ? 'rugged' : ((now - Date.parse(r.firstSeen)) / 3600000 >= W ? 'survived' : 'open'));";
  ok('DETECTION POWER : la ligne d origine, elle, serait attrapee',
    /\(now - Date\.parse\(r\.firstSeen\)\) \/ 3600000 >= W/.test(revenue));
}

console.log('\n  les deux regles DIFFERENT vraiment — sur le cas qui les separe');
{
  const H = 3600000;
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  const W = 14;                                   // heures
  const maintenant = t0 + 400 * H;                // 400 h plus tard
  const ancienne = (tok) => (tok.outcome === 'rugged' ? 'rugged'
    : ((maintenant - Date.parse(tok.firstSeen)) / H >= W ? 'survived' : 'open'));

  // LE CAS : un token vu 2 h, puis plus jamais relu (pool vide, ligne gelee).
  const gele = { firstSeen: new Date(t0).toISOString(), lastSeen: new Date(t0 + 2 * H).toISOString(), outcome: 'live' };
  ok('ancienne regle : un token gele depuis 398 h est declare SURVIVANT', ancienne(gele) === 'survived');
  ok('canonique : il reste OUVERT — on ne l a jamais vu vivant a 14 h', outcomeKnownAt(gele, maintenant, W) === null);

  // CAS OPPOSE 1 : reellement observe vivant au-dela de la fenetre.
  const vrai = { firstSeen: new Date(t0).toISOString(), lastSeen: new Date(t0 + 40 * H).toISOString(), outcome: 'live' };
  ok('canonique : un token VU vivant a 40 h est bien un survivant', outcomeKnownAt(vrai, maintenant, W) === 'survived');
  ok('et les deux regles s accordent sur celui-la', ancienne(vrai) === 'survived');

  // CAS OPPOSE 2 : un rug date reste un rug pour les deux.
  const mort = { firstSeen: new Date(t0).toISOString(), lastSeen: new Date(t0 + 3 * H).toISOString(), outcome: 'rugged', ruggedAt: new Date(t0 + 3 * H).toISOString() };
  ok('un rug date : « rugged » des deux cotes', ancienne(mort) === 'rugged' && outcomeKnownAt(mort, maintenant, W) === 'rugged');

  // CAS OPPOSE 3 : trop jeune pour conclure, des deux cotes.
  const jeune = { firstSeen: new Date(maintenant - 3 * H).toISOString(), lastSeen: new Date(maintenant).toISOString(), outcome: 'live' };
  ok('trop jeune : « open » des deux cotes', ancienne(jeune) === 'open' && outcomeKnownAt(jeune, maintenant, W) === null);
}

console.log('\n  le commentaire ne re-affirme plus une egalite qui etait fausse');
ok('la phrase « the same rule the scorecard uses, so the two never disagree » a disparu telle quelle',
  !/the same rule the scorecard uses, so the two never disagree\. \*\//.test(SRC));
ok('et le fichier PORTE la mesure qui a motive le changement (327 lignes en desaccord)',
  /327 lignes/.test(SRC) && /0\.728/.test(SRC) && /0\.812/.test(SRC));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
