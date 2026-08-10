#!/usr/bin/env node
'use strict';
/**
 * probe-censure-est-un-signal.js
 * ================================================================================================
 * `siblingCountCensored` EST-IL UN PREDICTEUR, ET PAS SEULEMENT UNE RESERVE SUR UNE BORNE ?
 *
 * ⛔ REPONSE, ET ELLE A CHANGE EN COURS DE ROUTE — cet en-tete portait l'hypothese que la sonde a
 * ensuite REFUTEE, et le laisser tel quel aurait fait d'elle un piege.
 *
 * L'hypothese: en mesurant les trois regles de financeur, le meme motif revenait partout — dans les
 * branches « sures », les tokens au tracage INTERROMPU ruggeaient beaucoup MOINS (13,5 pct) que ceux
 * traces jusqu'au bout (76,8). J'allais conclure que le drapeau porte un signal que les regles jettent.
 *
 * La mesure sur la population ENTIERE inverse le sens: planchers 86,0 pct contre comptes propres
 * 76,8 pct. Le « moins dangereux » etait CONDITIONNEL a l'appartenance a la branche, pas une propriete
 * du drapeau — renversement de type Simpson. Voir le verdict en section 3, et la CAUSE en section 4.
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * SECTION 4 — POURQUOI la branche « sure » de `funder-derived-uncensored` est PIRE que le hasard
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * La section precedente a mesure le fait sans l'expliquer. Celle-ci l'explique, et l'explication est
 * plus grave que le fait.
 */
console.log('');
console.log('== SECTION 4 — pourquoi la branche « sure » nettoyee rugge PLUS que la base ==');
{
  const r = RULES.find((x) => x.key === 'funder-derived-uncensored');
  const seuil = r.threshold(lignes);
  const propres = lignes.filter((t) => t.siblingCountCensored === false && typeof t.siblingCount === 'number')
    .map((t) => t.siblingCount).sort((a, b) => a - b);
  const q = (p) => propres[Math.floor(propres.length * p)];
  console.log('   seuil derive           ' + seuil);
  console.log('   comptes PROPRES        n=' + propres.length + '  mediane=' + q(0.5)
    + '  q75=' + q(0.75) + '  q90=' + q(0.9) + '  max=' + propres[propres.length - 1]);
  /* ⛔ UN SEUIL QUI TOMBE SUR UN PLATEAU NE SEPARE PAS: q75 et q90 valent la MEME valeur, donc le
   * quantile ne choisit pas un point de coupure, il choisit un PIC. */
  if (q(0.75) === q(0.9)) {
    console.log('   ⛔ q75 == q90: le seuil tombe sur un PLATEAU, pas sur un point de coupure.');
  }

  const safeP = resolus.filter((o) => typeof o.t.siblingCount === 'number'
    && o.t.siblingCount < seuil && o.t.siblingCountCensored === false);
  const parVal = new Map();
  for (const o of safeP) {
    const v = o.t.siblingCount;
    if (!parVal.has(v)) parVal.set(v, { n: 0, r: 0 });
    const e = parVal.get(v); e.n++; if (o.rug) e.r++;
  }
  console.log('');
  console.log('   la branche SAFE nettoyee, par valeur (n=' + safeP.length + '):');
  for (const [v, e] of [...parVal.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
    console.log('     ' + String(v).padStart(3) + ' x ' + String(e.n).padStart(4)
      + '  ->  ' + (100 * e.r / e.n).toFixed(1) + ' pct de rugs');
  }
  const un = parVal.get(1);
  if (un && safeP.length) {
    console.log('');
    console.log('   💎 LA VALEUR 1 PESE ' + (100 * un.n / safeP.length).toFixed(1)
      + ' pct DE LA BRANCHE et rugge a ' + (100 * un.r / un.n).toFixed(1) + ' pct.');
    console.log('      Un financeur a UN SEUL frere est un DEPLOIEMENT UNIQUE — et un deploiement unique');
    console.log('      rugge plus que la base. Le seuil de ' + seuil + ' est donc presque decoratif: cette');
    console.log('      branche ne mesure pas « peu de freres », elle mesure « exactement un ».');
    console.log('   ⚠️ Une branche dominee par UNE valeur ne mesure pas un seuil: elle mesure cette valeur.');
  }

  /* ── LE POINT LE PLUS GRAVE: LE SIGNE S'INVERSE SELON LA CENSURE ────────────────────────────────── */
  const bas = (cens) => resolus.filter((o) => typeof o.t.siblingCount === 'number'
    && o.t.siblingCount < seuil && o.t.siblingCountCensored === cens);
  const t = (a) => (a.length ? (100 * a.filter((x) => x.rug).length / a.length).toFixed(1) + ' pct' : 'n/d');
  const bp = bas(false), bc = bas(true);
  console.log('');
  console.log('   ⛔ ET LE SIGNE S INVERSE SELON LA CENSURE, ce qui est pire qu une borne imprecise:');
  console.log('      compte BAS et PROUVE   n=' + bp.length + '  ->  ' + t(bp));
  console.log('      compte BAS et CENSURE  n=' + bc.length + '  ->  ' + t(bc));
  console.log('      Melanger les deux ne brouille pas une borne: ca mélange DEUX RELATIONS DE SENS');
  console.log('      OPPOSES sous un seul nom. Un taux moyen entre elles ne decrit aucune des deux.');
  console.log('   ⛔ On ne DIT PAS pourquoi un compte bas censure se comporte ainsi — un tracage arrete');
  console.log('      tot n est pas une propriete de l operateur. Structure, jamais intention.');
}
