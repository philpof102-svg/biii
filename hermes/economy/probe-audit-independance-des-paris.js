#!/usr/bin/env node
'use strict';
/**
 * probe-audit-independance-des-paris.js
 * ================================================================================================
 * LES 7 PARIS ANNONCES, PASSES AU CONTROLE D'INDEPENDANCE — LES 14 COTES, D'UN COUP.
 *
 * ⛔ RESULTAT DU 2026-08-11: AUCUN des 14 cotes ne passe. Soit moins de 20 financeurs (taux RETENU),
 * soit plus de 80 pct de SINGLETONS (controle NUL), soit entre les deux (PARTIEL). Zero cote VALIDE.
 *
 * ⚠️ ET CE N'EST PAS « LES PARIS SONT FAUX ». C'est « cette population ne permet pas de le savoir ».
 * La distinction est essentielle: un pari refute et un pari invérifiable demandent des reponses
 * opposees — le premier se retire, le second attend des donnees ou change d'unite EN LE DISANT.
 *
 * ═══ POURQUOI: LA POPULATION EST FAITE DE SINGLETONS ═══
 * Sur un financeur a UN SEUL token, la « moyenne par financeur » EST l'issue de ce token. Le controle
 * d'independance ne controle alors RIEN: il REPETE le taux par token sous un autre nom. Avec ~90 pct de
 * singletons, aucun cote ne peut passer, quelle que soit la qualite de la regle.
 *
 * 🪤 LE PIEGE QUI M'A EU (le meme jour, sur `firstVerdict`): « le plus gros financeur pese 0,7 pct » se
 * lit comme « bien distribue », alors que c'etait « QUE des singletons ». Une domination faible a DEUX
 * causes opposees et elles s'affichent pareil. On imprime donc TROIS chiffres, jamais le premier seul:
 * part-du-plus-gros, part de SINGLETONS, et COUVERTURE (combien de tokens ont seulement un financeur).
 *
 * ⚠️ BORNES: population d'observation de CE noeud. `ruggedAt` est une DETECTION. Issues resolues par le
 * helper CANONIQUE `outcomeKnownAt`. ⛔ Aucune adresse imprimee, aucun pari annonce ni modifie — une
 * entree annoncee ne se modifie JAMAIS, c'est ce qui la rend infalsifiable.
 */
const fs = require('node:fs');
const path = require('node:path');
const { RULES, outcomeKnownAt, maturityWindow, MIN_RESOLUS, DANGER, SAFE } = require('../../lib/prequential');
const { ANNOUNCED } = require('../../lib/announced-rules');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.log('base ILLISIBLE (' + ((e && e.message) || e) + ')'); process.exitCode = 1; return; }

const lignes = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const f = maturityWindow(lignes);
const T = Date.now();
const res = [];
for (const t of lignes) { const k = outcomeKnownAt(t, T, f.maturityH); if (k) res.push({ t, rug: k === 'rugged' }); }
const base = 100 * res.filter((r) => r.rug).length / res.length;
const tx = (a) => (a.length ? 100 * a.filter((x) => x.rug).length / a.length : null);

console.log('== les 7 paris annonces au controle d INDEPENDANCE — les 14 cotes ==');
console.log('   base ' + base.toFixed(1) + ' pct sur ' + res.length + ' resolus   fenetre ' + f.maturityH + ' h');

/* ── LA STRUCTURE DE LA POPULATION, D'ABORD — elle explique tout le reste ──────────────────────────── */
{
  const m = new Map();
  for (const r of res) {
    const k = r.t.funder && String(r.t.funder).toLowerCase();
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const t = [...m.values()];
  const sing = t.filter((x) => x === 1).length;
  console.log('');
  console.log('-- la structure de la population (elle explique tout le reste) --');
  console.log('   tokens avec un financeur   ' + t.reduce((s, x) => s + x, 0) + ' / ' + res.length);
  console.log('   financeurs distincts       ' + m.size);
  console.log('   SINGLETONS                 ' + sing + ' (' + (100 * sing / m.size).toFixed(1) + ' pct)');
  console.log('   ⛔ Sur un financeur a UN token, la moyenne par financeur EST l issue de ce token.');
  console.log('      Avec cette proportion, aucun cote ne peut passer le controle — quelle que soit la regle.');
}

let valides = 0, cotes = 0;
console.log('');
console.log('-- cote par cote --');
for (const a of ANNOUNCED) {
  const r = RULES.find((x) => x.key === a.key);
  if (!r) { console.log('   ' + a.key + ' : ⛔ REGLE VIVANTE ABSENTE — panne du dispositif, pas un vide'); continue; }
  console.log('   === ' + a.key + ' ===');
  for (const cote of [DANGER, SAFE]) {
    const nom = cote === DANGER ? 'DANGER' : 'SUR   ';
    const g = [];
    for (const o of res) { let v; try { v = r.predict(o.t, lignes); } catch { continue; } if (v === cote) g.push(o); }
    if (!g.length) { console.log('     ' + nom + ' : vide — la regle ne classe rien de ce cote'); continue; }
    cotes++;
    const m = new Map();
    let avecF = 0;
    for (const o of g) {
      const k = o.t.funder && String(o.t.funder).toLowerCase();
      if (!k) continue;
      avecF++;
      if (!m.has(k)) m.set(k, { n: 0, r: 0 });
      const e = m.get(k); e.n++; if (o.rug) e.r++;
    }
    const tailles = [...m.values()].map((e) => e.n).sort((x, y) => y - x);
    const sing = tailles.filter((x) => x === 1).length;
    const partS = m.size ? 100 * sing / m.size : 0;
    const pf = m.size ? 100 * [...m.values()].reduce((s, e) => s + e.r / e.n, 0) / m.size : null;

    /* ⛔ TROIS CAUSES D'INVALIDITE, ET ELLES NE SE CONFONDENT PAS: trop peu d'operateurs, que des
     * singletons, ou une couverture trop faible. Les nommer separement evite de repondre « pas assez de
     * donnees » a un probleme de STRUCTURE qui ne se resoudra pas avec le temps. */
    let verdict;
    if (m.size < MIN_RESOLUS) verdict = '⛔ RETENU — ' + m.size + ' financeurs < ' + MIN_RESOLUS;
    else if (partS > 80) verdict = '⛔ CONTROLE NUL — ' + partS.toFixed(0) + ' pct de singletons';
    else if (partS > 50) verdict = '⚠️ PARTIEL — ' + partS.toFixed(0) + ' pct de singletons';
    else { verdict = '✅ VALIDE — ' + pf.toFixed(1) + ' pct par financeur, ecart '
        + (pf - base >= 0 ? '+' : '') + (pf - base).toFixed(1) + ' pts'; valides++; }

    console.log('     ' + nom + ' n=' + String(g.length).padStart(4) + '  ' + tx(g).toFixed(1)
      + ' pct par token   -> ' + verdict);
    console.log('            couverture ' + avecF + '/' + g.length + ' ('
      + (100 * avecF / g.length).toFixed(0) + ' pct)   plus gros financeur '
      + (tailles.length ? (100 * tailles[0] / g.length).toFixed(1) : '0') + ' pct');
  }
}

console.log('');
console.log('-- bilan --');
console.log('   cotes evalues ' + cotes + '   VALIDES ' + valides);
if (valides === 0 && cotes > 0) {
  console.log('   ⛔ AUCUN cote ne passe le controle d independance.');
  console.log('   ⚠️ Ce n est PAS « les paris sont faux » — c est « cette population ne permet pas de le');
  console.log('      savoir ». Un pari REFUTE se retire; un pari INVERIFIABLE attend des donnees, ou');
  console.log('      change d unite EN LE DISANT. Les deux demandent des reponses opposees.');
  console.log('   💎 Question de fond, qui appartient a l operateur: avec ~90 pct de financeurs a UN seul');
  console.log('      token, ce controle pourra-t-il JAMAIS passer ? Si non, il faut soit attendre que les');
  console.log('      operateurs se repetent, soit assumer le TOKEN comme unite — et le dire dans la copie.');
}
