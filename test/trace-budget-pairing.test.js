#!/usr/bin/env node
'use strict';
/**
 * Deux constantes forment un couple, et rien ne le disait.
 *
 *     TRACE_MAX 20  x  (TRACE_FIXED_CALLS 3 + SIBLING_MAX_PAGES 6)  =  180  =  TRACE_CALL_BUDGET
 *
 * L'enveloppe d'appels est dimensionnee pour que le PIRE cas tienne: vingt tokens qui tous vont au bout
 * de la borne de pages. Mesure du 2026-08-07 — `siblingPageCap` vaut 6 sur les 94 traces persistees,
 * aucune n'a jamais ete rognee par le budget. L'egalite n'est donc pas une coincidence, c'est un
 * dimensionnement, et il vit dans DEUX fichiers differents sans qu'aucun ne mentionne l'autre.
 *
 * ⛔ CE QUE CE TEST EMPECHE. Monter `SIBLING_MAX_PAGES` de 6 a 12 ne casse rien de visible: la suite
 * reste verte, le radar continue de tourner. Ce qui se passe est plus discret — sur les passages assez
 * charges (2,5 % d'entre eux atteignent TRACE_MAX, mesure sur 239 passages reconstruits), `planTrace`
 * ROGNE LA PROFONDEUR au lieu de refuser un token. `siblingPageCap` se met alors a varier d'un token a
 * l'autre DANS un meme passage, et `page_cap` cesse de designer une seule quantite: une densite calculee
 * sur 6 pages et une densite calculee sur 2 deviennent le meme champ. C'est exactement la faute que ce
 * depot vient de passer deux jours a retirer du code — elle rentrerait par une constante.
 *
 * ⚠️ CE TEST NE DIT PAS QUE 6 EST LE BON CHIFFRE. Il dit que les trois constantes doivent bouger
 * ENSEMBLE, et il rend impossible d'en bouger une seule sans le voir.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { planTrace, SIBLING_MAX_PAGES, TRACE_FIXED_CALLS } = require('../lib/feeder');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

/* `token-radar.js` est un SCRIPT: il n'exporte rien, et son sha256 est epingle — l'editer pour ajouter
 * un export arreterait son cron en silence. On lit donc ses constantes dans la source. */
const RADAR = path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js');
function constanteDe(source, nom) {
  const ligne = source.split('\n').find((l) => l.trim().startsWith('const ' + nom + ' ='));
  if (!ligne) return null;
  const n = Number(ligne.split('=')[1].split(';')[0].trim());
  return Number.isFinite(n) ? n : null;
}

/** La regle, isolee pour etre exercee dans les DEUX sens. */
const tient = (tokens, fixes, pages, budget) => tokens * (fixes + pages) <= budget;

console.log('couplage budget/profondeur: trois constantes, deux fichiers, aucun lien ecrit');

const src = fs.readFileSync(RADAR, 'utf8');
const MAX_TOKENS = constanteDe(src, 'TRACE_MAX');
const BUDGET = constanteDe(src, 'TRACE_CALL_BUDGET');

t('★ les constantes du radar sont LISIBLES — sinon ce test passerait en ne verifiant rien', () => {
  /* Un test qui ne trouve pas ses entrees et se tait est un succes-vide: il rassure sans rien couvrir.
   * C'est le motif que `test-suite-must-count-itself` a deja coute une fois a ce depot. */
  assert.ok(Number.isInteger(MAX_TOKENS) && MAX_TOKENS > 0,
    'TRACE_MAX introuvable ou non entier dans token-radar.js — le fichier a change de forme');
  assert.ok(Number.isInteger(BUDGET) && BUDGET > 0,
    'TRACE_CALL_BUDGET introuvable ou non entier dans token-radar.js — le fichier a change de forme');
});

t('★ LE COUPLAGE: le pire cas tient dans l enveloppe', () => {
  const pire = MAX_TOKENS * (TRACE_FIXED_CALLS + SIBLING_MAX_PAGES);
  assert.ok(tient(MAX_TOKENS, TRACE_FIXED_CALLS, SIBLING_MAX_PAGES, BUDGET),
    'TRACE_MAX(' + MAX_TOKENS + ') x (TRACE_FIXED_CALLS(' + TRACE_FIXED_CALLS + ') + SIBLING_MAX_PAGES('
    + SIBLING_MAX_PAGES + ')) = ' + pire + ' DEPASSE TRACE_CALL_BUDGET(' + BUDGET + '). '
    + 'Sur un passage sature, planTrace rognera la profondeur et `siblingPageCap` variera DANS le passage: '
    + '`page_cap` cesserait de designer une seule quantite. Monter le budget a ' + pire + ', ou baisser '
    + 'TRACE_MAX a ' + Math.floor(BUDGET / (TRACE_FIXED_CALLS + SIBLING_MAX_PAGES)) + '.');
});

t('★ la regle MORD vraiment — doubler la profondeur sans toucher au budget doit la casser', () => {
  /* Sans ce cas oppose, l assertion precedente passerait aussi sur une regle qui rend toujours `true`. */
  assert.strictEqual(tient(MAX_TOKENS, TRACE_FIXED_CALLS, SIBLING_MAX_PAGES * 2, BUDGET), false,
    'une profondeur doublee a budget constant DOIT casser le couplage');
  assert.strictEqual(tient(MAX_TOKENS, TRACE_FIXED_CALLS, SIBLING_MAX_PAGES * 2,
    MAX_TOKENS * (TRACE_FIXED_CALLS + SIBLING_MAX_PAGES * 2)), true,
    'et un budget releve en consequence DOIT la retablir');
});

/* ── LE MECANISME SUR LEQUEL TOUT REPOSE, VERIFIE PAR LE PRODUCTEUR ──────────────────────────────── */

t('★ planTrace ROGNE la profondeur avant de refuser — c est ce qui rend le debordement silencieux', () => {
  const plein = planTrace(TRACE_FIXED_CALLS + SIBLING_MAX_PAGES);
  assert.strictEqual(plein.trace, true);
  assert.strictEqual(plein.pages, SIBLING_MAX_PAGES, 'avec l enveloppe pleine, la profondeur est entiere');

  /* Le coeur du risque: il reste de quoi tracer, mais moins profond. Le token est accepte quand meme,
   * avec un plafond ABAISSE — et c est ce plafond-la qui, persiste, ferait de `page_cap` deux mesures. */
  const rogne = planTrace(TRACE_FIXED_CALLS + 2);
  assert.strictEqual(rogne.trace, true, 'un budget reduit ne refuse PAS le token');
  assert.strictEqual(rogne.pages, 2, 'il lui rend une profondeur reduite, en silence');
  assert.ok(rogne.pages < SIBLING_MAX_PAGES, 'et cette profondeur est bien inferieure a la normale');
});

t('les trois etats du budget sont distincts: plein / rogne / refuse', () => {
  const sig = (r) => JSON.stringify([r.trace, r.pages]);
  const plein = planTrace(1000);
  const rogne = planTrace(TRACE_FIXED_CALLS + 1);
  const refus = planTrace(TRACE_FIXED_CALLS - 1);
  assert.strictEqual(refus.trace, false, 'sous les appels fixes, on ne trace pas du tout');
  assert.strictEqual(refus.pages, 0, 'et on ne promet aucune page');
  assert.notStrictEqual(sig(plein), sig(rogne), 'plein et rogne doivent se distinguer');
  assert.notStrictEqual(sig(rogne), sig(refus), 'rogne et refus doivent se distinguer');
  assert.notStrictEqual(sig(plein), sig(refus), 'plein et refus doivent se distinguer');
});

t('une enveloppe absurde ne rend jamais zero page a un token accepte', () => {
  /* `Math.max(1, ...)` existe pour ca: accepter un token en lui donnant zero page produirait un
   * `siblingsRead: false` indistinguable d une panne d explorateur. */
  for (const reste of [TRACE_FIXED_CALLS, TRACE_FIXED_CALLS + 0.5]) {
    const p = planTrace(reste);
    if (p.trace) assert.ok(p.pages >= 1, 'reste=' + reste + ': un token trace a au moins une page');
  }
});

t('un maxPages invalide retombe sur la constante, il n annule pas la trace', () => {
  for (const mauvais of [0, -3, 2.5, null, undefined, 'six']) {
    const p = planTrace(1000, mauvais);
    assert.strictEqual(p.pages, SIBLING_MAX_PAGES, 'maxPages=' + String(mauvais) + ' doit retomber sur '
      + SIBLING_MAX_PAGES + ', pas produire une profondeur arbitraire');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
