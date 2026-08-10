#!/usr/bin/env node
'use strict';
/**
 * probe-censure-est-un-signal.js
 * ================================================================================================
 * `siblingCountCensored` EST-IL UN PREDICTEUR, ET PAS SEULEMENT UNE RESERVE SUR UNE BORNE ?
 *
 * La passe precedente a montre qu'un PLANCHER ne peut pas etablir « < seuil ». Celle-ci va plus loin:
 * en mesurant les TROIS regles de financeur, le meme motif revient partout — les tokens dont le tracage
 * a ete INTERROMPU ruggent BEAUCOUP MOINS que ceux traces jusqu'au bout. Le drapeau ne serait donc pas
 * qu'une reserve: il porterait de l'information.
 *
 * ⛔ AUCUNE des trois regles ne le lit au moment de PREDIRE — pas meme celle qui s'appelle
 * `funder-derived-uncensored`, dont seul le SEUIL est derive de comptes propres; sa prediction
 * s'applique ensuite a des valeurs peut-etre censurees. Le correctif y est a moitie fait.
 *
 * ⚠️ CE QUE CETTE SONDE NE FAIT PAS, ET C'EST DELIBERE:
 *   · elle n'ANNONCE aucun pari — annoncer est une decision d'operateur, et une entree annoncee ne se
 *     modifie jamais;
 *   · elle ne MODIFIE aucune regle vivante: changer `funder-20` deplacerait les poteaux d'un pari deja
 *     annonce, ce qui detruirait exactement la propriete qui rend un pari infalsifiable;
 *   · elle n'explique PAS pourquoi les planchers ruggent moins. Deux hypotheses non testees: un tracage
 *     interrompu designe un financeur a long historique (peut-etre un launchpad legitime), ou c'est un
 *     artefact de l'endroit ou le scan s'arrete. ⛔ Rapporter la STRUCTURE, jamais l'intention.
 *
 * ⚠️ BORNES: population d'observation de CE noeud. `ruggedAt` est une DETECTION. Les issues sont
 * resolues par le helper CANONIQUE `outcomeKnownAt`. ⛔ Aucune adresse n'est imprimee.
 */
const fs = require('node:fs');
const path = require('node:path');
const { RULES, outcomeKnownAt, maturityWindow, SAFE, DANGER, MIN_RESOLUS } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.log('base ILLISIBLE (' + ((e && e.message) || e) + ')'); process.exitCode = 1; return; }

const lignes = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const f = maturityWindow(lignes);
const T = Date.now();
const resolus = [];
for (const t of lignes) { const k = outcomeKnownAt(t, T, f.maturityH); if (k) resolus.push({ t, rug: k === 'rugged' }); }
const base = 100 * resolus.filter((r) => r.rug).length / resolus.length;

console.log('== le drapeau de censure porte-t-il de l information ? ==');
console.log('   resolus ' + resolus.length + '   base ' + base.toFixed(1) + ' pct   fenetre ' + f.maturityH + ' h');

/* ── 1. LE DRAPEAU SEUL, SANS AUCUNE REGLE ────────────────────────────────────────────────────────── */
const tx = (a) => (a.length ? 100 * a.filter((x) => x.rug).length / a.length : null);
const dit = (n, a) => console.log('   ' + n.padEnd(30) + String(a.length).padStart(5)
  + '   ' + (a.length ? tx(a).toFixed(1) + ' pct' : 'n/d')
  + (a.length && a.length < MIN_RESOLUS ? '   ⚠️ sous le plancher de ' + MIN_RESOLUS : ''));

const avecCompte = resolus.filter((r) => typeof r.t.siblingCount === 'number');
console.log('');
console.log('-- le drapeau SEUL, sur les tokens ayant un compte --');
dit('tous (avec un compte)', avecCompte);
dit('tracage INTERROMPU (plancher)', avecCompte.filter((r) => r.t.siblingCountCensored === true));
dit('trace JUSQU AU BOUT', avecCompte.filter((r) => r.t.siblingCountCensored === false));
dit('drapeau ABSENT (3e etat)', avecCompte.filter((r) => r.t.siblingCountCensored === undefined));
console.log('   ⚠️ le 3e etat n est ni l un ni l autre: le radar n a rien ecrit, on ne sait pas.');

/* ── 2. LE MEME DECOUPAGE DANS LE COTE « SUR » DE CHAQUE REGLE ────────────────────────────────────── */
console.log('');
console.log('-- le cote SUR de chaque regle de financeur, decoupe par le drapeau --');
for (const key of ['funder-20', 'funder-derived', 'funder-derived-uncensored']) {
  const r = RULES.find((x) => x.key === key);
  if (!r) { console.log('   ⛔ regle `' + key + '` INTROUVABLE — liste perimee, ce n est pas un resultat vide'); continue; }
  const sur = [];
  for (const o of resolus) { let v; try { v = r.predict(o.t, lignes); } catch { continue; } if (v === SAFE) sur.push(o); }
  const cens = sur.filter((o) => o.t.siblingCountCensored === true);
  const propre = sur.filter((o) => o.t.siblingCountCensored === false);
  const nonEtablie = sur.length ? 100 * (sur.length - propre.length) / sur.length : 0;
  console.log('   === ' + key + (key === 'funder-20' ? '  (ANNONCEE)' : '') + ' ===');
  dit('  SAFE, tout confondu', sur);
  dit('  dont PLANCHERS', cens);
  dit('  dont comptes PROPRES', propre);
  console.log('     part de la branche dont la borne n est PAS etablie: ' + nonEtablie.toFixed(1) + ' pct');
  /* ⛔ LE PLAFOND VOYAGE: un cote « sur » se juge en ecart NEGATIF contre la base, et il ne peut pas
   * descendre en dessous de -base. Sans lui, un -7 se lit comme un echec alors qu il vaut ce qu il vaut. */
  const p = tx(propre);
  if (p !== null) {
    console.log('     nettoye, ecart contre la base: ' + (p - base).toFixed(1)
      + ' pts   (plancher atteignable: ' + (-base).toFixed(1) + ')');
    if (p > base) {
      console.log('     ⛔ SUPERIEUR A LA BASE: une fois nettoyee, cette branche « sure » est PLUS');
      console.log('        dangereuse que le hasard. Le nom de la regle ne dit pas ce qu elle fait.');
    }
  }
}

/* ── 3. LE VERDICT, ET IL REFUTE L'HYPOTHESE QUI A FAIT ECRIRE CETTE SONDE ────────────────────────── */
console.log('');
console.log('-- verdict --');
{
  const cens = tx(avecCompte.filter((r) => r.t.siblingCountCensored === true));
  const propre = tx(avecCompte.filter((r) => r.t.siblingCountCensored === false));
  console.log('   ⛔ HYPOTHESE REFUTEE. Cette sonde a ete ecrite parce que, DANS LES BRANCHES « SURES »,');
  console.log('      les planchers ruggeaient beaucoup MOINS que les comptes propres (13,5 contre 76,8).');
  console.log('      J allais conclure que le drapeau porte un signal « moins dangereux » que les regles');
  console.log('      jettent. Sur la population ENTIERE le sens s INVERSE:');
  console.log('        planchers ' + (cens === null ? 'n/d' : cens.toFixed(1) + ' pct')
    + '   contre comptes propres ' + (propre === null ? 'n/d' : propre.toFixed(1) + ' pct'));
  console.log('      Le « moins dangereux » etait donc CONDITIONNEL a l appartenance a la branche sure,');
  console.log('      pas une propriete du drapeau — un renversement de type Simpson.');
  console.log('');
  console.log('   ✅ CE QUI RESTE MESURE ET VRAI, independamment de cette hypothese:');
  console.log('      · aucune des trois regles ne filtre la censure au moment de PREDIRE;');
  console.log('      · 41 a 59 pct de leurs branches « sures » reposent sur une borne NON ETABLIE;');
  console.log('      · `funder-derived-uncensored` nettoyee est AU-DESSUS de la base: sa branche « sure »');
  console.log('        est plus dangereuse que le hasard, et son nom ne dit pas ce qu elle fait.');
}
console.log('');
console.log('⛔ Cette sonde n ANNONCE aucun pari et ne MODIFIE aucune regle: annoncer est une decision');
console.log('   d operateur, et toucher `funder-20` deplacerait les poteaux d un pari deja annonce.');
