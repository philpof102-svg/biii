#!/usr/bin/env node
'use strict';
/**
 * probe-quand-le-pari-thin-devient-lisible.js
 * ================================================================================================
 * ⛔ CETTE SONDE EXISTE PARCE QUE J'AI CITÉ UNE DATE QUE JE N'AVAIS PAS MESURÉE.
 *
 * J'ai annoncé à Phil que la première résolution du pari `thin-sous-le-seuil` tombait « vers 03:00Z »,
 * calculé comme `announcedAt` (15:00Z) + 12 h. Les DEUX moitiés de ce calcul sont fausses:
 *
 *   1. Le « 12 h » vient de `basis.sample` dans l'annonce — une DESCRIPTION de l'échantillon au moment
 *      où les taux prédits ont été dérivés. La fenêtre réellement utilisée au scoring est
 *      `scorecard.js:75`: `Math.max(1, Math.ceil(p95RugH))` — le 95e percentile des durées de vie des
 *      rugs OBSERVÉS. Elle est DÉRIVÉE des données et bouge à chaque collecte.
 *
 *   2. Et surtout: la fenêtre de maturité ne gouverne QUE les verdicts « survécu ».
 *      `outcomeKnownAt` rend 'rugged' dès que `ruggedAt <= t`, sans aucune fenêtre. Un token annoncé
 *      après 15:00Z qui rugge à 16:00Z est résolu à 16:00Z.
 *
 * ⚠️ Donc « la première résolution tombe à 03:00Z » confondait « le premier SURVIVANT est déclarable »
 * avec « le premier appel est résolu ». Ce sont deux instants différents, et le second est plus tôt.
 *
 * CE QUE CETTE SONDE MESURE, en lecture seule:
 *   · la fenêtre de maturité COURANTE, telle que le scoring la calcule maintenant;
 *   · combien d'appels du pari sont DÉJÀ résolus, ouverts, et de quel côté;
 *   · l'instant où le premier SURVIVANT deviendra déclarable, dérivé de la fenêtre courante.
 *
 * ⛔ Elle ne conclut RIEN sur la justesse du pari: sous MIN_RESOLUS le taux reste RETENU, et c'est le
 * comportement voulu. Elle répond à « quand est-ce lisible », pas à « est-ce juste ».
 */
const fs = require('node:fs');
const path = require('node:path');
const { gradeAnnounced, maturityWindow, MIN_RESOLUS } = require('../../lib/prequential');
const { ANNOUNCED } = require('../../lib/announced-rules');

const CLE = 'thin-sous-le-seuil';
const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');

let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) {
  /* ⛔ Une base illisible n'est pas une base vide: on le DIT plutôt que de rendre des zéros. */
  console.log('base ILLISIBLE (' + ((e && e.message) || e) + ') — aucun chiffre ne peut etre rendu');
  process.exitCode = 1;
  return;
}

const rows = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const maintenant = new Date().toISOString();

console.log('== quand le pari `' + CLE + '` devient-il lisible ? ==');
console.log('   lu a                    ' + maintenant);
console.log('   lignes datables         ' + rows.length + ' / ' + Object.keys(brut).length);

/* ── 1. LA FENÊTRE COURANTE, CALCULÉE COMME LE SCORING LA CALCULE ─────────────────────────────────── */
const f = maturityWindow(rows);
console.log('');
console.log('-- la fenetre de maturite, MESUREE et non citee --');
console.log('   maturityH courante      ' + (f.maturityH == null ? 'INDISPONIBLE (aucun rug observe)' : f.maturityH + ' h'));
console.log('   p95 des durees de rug   ' + (f.p95RugH == null ? 'n/d' : f.p95RugH + ' h'));
console.log('   rug le plus lent vu     ' + (f.slowestRugH == null ? 'n/d' : f.slowestRugH + ' h'));
console.log('   rugs au-dela de la fenetre  ' + f.beyondWindow + ' / ' + f.ruggedRows);
if (f.unreadable) console.log('   ⚠️ lignes illisibles    ' + f.unreadable);

/* ⛔ LE CHIFFRE QUE J'AI CITÉ, MIS FACE À CELUI QUI GOUVERNE. */
const annonce = ANNOUNCED.find((a) => a.key === CLE);
const CITE = 12;
if (f.maturityH != null && f.maturityH !== CITE) {
  console.log('   ⛔ j ai cite ' + CITE + ' h (description de l echantillon); le scoring utilise '
    + f.maturityH + ' h — ecart de ' + (f.maturityH - CITE) + ' h');
}

/* ── 2. CE QUI EST DÉJÀ RÉSOLU — LA VRAIE RÉPONSE À « QUAND » ─────────────────────────────────────── */
/* ⛔ `.cards`, PAS `.cartes` — et j'avais deja code contre la forme supposee une fois dans ce fichier.
 * On imprime donc la carte telle qu'elle est rendue, plutot que d'en nommer les champs de memoire. */
const bulletin = gradeAnnounced(rows, maintenant);
const carte = (bulletin.cards || []).find((c) => c.key === CLE);
console.log('');
console.log('-- les appels du pari, MAINTENANT --');
if (!carte) {
  console.log('   ⛔ aucune carte rendue pour cette cle — panne du dispositif, pas un resultat vide');
  process.exitCode = 1;
} else {
  for (const [k, v] of Object.entries(carte)) {
    if (k === 'note' || k === 'label') continue;                 // longs, imprimes a part
    console.log('   ' + k.padEnd(20) + ' ' + (v && typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  /* ⛔ Un appel OUVERT n'est ni juste ni faux — il ne compte dans AUCUNE direction, et le plancher de
   * MIN_RESOLUS s'applique par COTE, pas au total. */
  console.log('   (plancher MIN_RESOLUS = ' + MIN_RESOLUS + ')');
  if (carte.note) console.log('   note: ' + carte.note);
}

/* ── 3. QUAND LE PREMIER SURVIVANT DEVIENDRA DÉCLARABLE ───────────────────────────────────────────── */
console.log('');
console.log('-- l instant que je cherchais vraiment --');
const debut = Date.parse(annonce ? annonce.announcedAt : NaN);
if (!Number.isFinite(debut)) {
  console.log('   ⛔ `announcedAt` illisible — aucun instant ne peut etre derive');
} else if (f.maturityH == null) {
  console.log('   ⛔ aucune fenetre disponible: aucun SURVIVANT ne peut etre declare, a aucune heure');
} else {
  /* ⚠️ Borne SUPÉRIEURE, pas une prédiction: un token vu à l'instant même de l'annonce est le plus
   * précoce possible. Les tokens réels sont vus plus tard, donc mûrissent plus tard. */
  const auPlusTot = new Date(debut + f.maturityH * 3600000).toISOString();
  console.log('   annonce a               ' + annonce.announcedAt);
  console.log('   + fenetre de ' + String(f.maturityH).padStart(2) + ' h        ' + auPlusTot);
  console.log('   ⚠️ c est la borne LA PLUS PRECOCE, pas une prediction: elle suppose un token vu a');
  console.log('      l instant exact de l annonce. Un token vu plus tard murit plus tard.');
  console.log('   ⛔ et elle ne concerne QUE les survivants: un rug est resolu des qu il rugge.');
}
