#!/usr/bin/env node
// replay-basis-fields.js — les quatre champs de `basisAtFirstSight` jamais mesures SEULS.
// ================================================================================================
// `ownerState` a ete mesure le 05/08 et s'est revele le separateur le plus fort du jeu (76 points).
// Il etait calcule depuis toujours et personne n'avait regarde ce qu'il valait isolement. Les quatre
// autres champs de la meme structure — `holders`, `lpLockedPct`, `topWalletPct`, `unreadable` — sont
// dans le meme cas: ils alimentent des drapeaux, jamais un chiffre.
//
// ⚠️ SEUILS DERIVES, PAS CHOISIS. Un seuil pris a la main sur des issues deja connues ne prouve rien —
// trois regles sont mortes ici de ca. Les champs numeriques sont donc coupes en quartiles DE LEUR
// PROPRE distribution, et les bornes sont imprimees pour qu'on puisse les contester.
//
// ⚠️ `unreadable` compte des champs NON LUS. S'il separe, c'est la couverture de notre source qui
// parle, pas le token — exactement comme `ownerState: unknown`. Le dire, ne pas le vendre.
//
// La resolution vient de lib/prequential.js: `outcome: 'live'` n'est PAS un appel ouvert ici, la
// fenetre derivee vaut 4 h et le jeu couvre dix jours.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, coupeQuartiles } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const resolus = rows.filter((t) => issue(t) !== null);
const BASE = resolus.filter((t) => issue(t) === 'rugged').length / resolus.length;

function ligne(label, g) {
  if (!g.length) { console.log(`    ${label.padEnd(34)}    0 —`); return null; }
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const s = g.filter((t) => issue(t) === 'survived').length;
  const res = r + s;
  const lift = res ? (r / res - BASE) * 100 : 0;
  console.log(`    ${label.padEnd(34)} ${String(g.length).padStart(4)} · ${String(r).padStart(4)} rug · ${String(s).padStart(3)} surv · `
    + `${res ? ((r / res) * 100).toFixed(1).padStart(5) : '  n/a'}% · ${lift >= 0 ? '+' : ''}${lift.toFixed(1)} pts`);
  return { n: g.length, bas: res ? r / res : null };
}

const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const val = (t, champ) => { const b = basis(t); return b ? b[champ] : undefined; };

console.log(`\n  taux de base : ${(BASE * 100).toFixed(1)}%  ·  ${resolus.length} resolus sur ${rows.length}`);
console.log('  colonnes : n · rug · survivants · taux · lift\n');

/** Coupe un champ numerique en quartiles DE SA PROPRE distribution, et publie les bornes. */
function parQuartiles(champ) {
  console.log(`  ── ${champ} ──`);
  const lus = rows.filter((t) => typeof val(t, champ) === 'number' && Number.isFinite(val(t, champ)));
  const absents = rows.filter((t) => !lus.includes(t));
  if (lus.length < 40) { console.log(`    trop peu de valeurs lues (${lus.length}) — rien a couper.\n`); return; }

  /* ⛔ Le quantile ne se recalcule PAS ici. Il vivait deja dans lib/prequential.js et cet instrument
   * en portait une copie, comme replay-ingestion.js — le motif qui a produit sept divergences dans ce
   * depot. La coupe et son garde viennent du meme endroit que le harnais qui les note. */
  const v = lus.map((t) => val(t, champ)).sort((a, b) => a - b);
  const coupe = coupeQuartiles(v);
  const { q1, q2, q3 } = coupe;
  console.log(`    bornes derivees : q1=${q1} · median=${q2} · q3=${q3} · min=${v[0]} · max=${v[v.length - 1]}`);

  const seaux = [
    ['<= q1 (' + q1 + ')', (x) => x <= q1],
    ['q1..median', (x) => x > q1 && x <= q2],
    ['median..q3', (x) => x > q2 && x <= q3],
    ['> q3 (' + q3 + ')', (x) => x > q3],
  ];
  const marques = [];
  for (const [nom, test] of seaux) marques.push(ligne(nom, lus.filter((t) => test(val(t, champ)))));
  ligne('NON LU (absent/null)', absents);

  /* L'ecart entre les seaux extremes, publie a cote des bornes: un lecteur doit pouvoir contester le
   * decoupage, pas seulement le resultat. ⚠️ Et le garde passe AVANT le chiffre: une coupe qui laisse
   * un seau vide ne separe rien, et le dire vaut mieux qu'un ecart calcule sur des bandes fictives.
   * La raison est imprimee telle quelle — un « refuse » sans son pourquoi finit par etre ignore. */
  if (coupe.degeneree) {
    console.log(`    ⛔ ${coupe.degeneree}.`);
    console.log(`       (tailles reelles des 4 seaux : ${coupe.seaux.join(' · ')})`);
  } else {
    const bas = marques[0], haut = marques[3];
    if (bas && haut && bas.bas != null && haut.bas != null) {
      const d = (haut.bas - bas.bas) * 100;
      /* ⚠️ L'ECART VOYAGE AVEC SON EFFECTIF. `topWalletPct` rendait « -21,7 pts » sur des seaux de dix
       * tokens, imprime a l'identique du « +34,3 pts » de `holders` qui en pesait 141. Un chiffre
       * detache de son n se cite ensuite tout seul, et c'est comme ca qu'une regle nait d'un bruit. */
      const plusPetit = Math.min(coupe.seaux[0], coupe.seaux[3]);
      const reserve = plusPetit < 30 ? `  ⚠️ le plus petit des deux seaux ne pese que ${plusPetit} tokens` : '';
      console.log(`    -> ecart entre seaux extremes : ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`
        + `  (n ${coupe.seaux[0]} vs ${coupe.seaux[3]})${reserve}`);
    }
  }
  console.log('');
}

for (const c of ['holders', 'lpLockedPct', 'topWalletPct']) parQuartiles(c);

/* `unreadable` est un COMPTE de champs non lus, pas une propriete du token. On le coupe par valeur
 * exacte, et on rappelle ce qu'il mesure vraiment. */
console.log('  ── unreadable (nombre de champs NON LUS) ──');
const lusU = rows.filter((t) => typeof val(t, 'unreadable') === 'number');
const valeurs = [...new Set(lusU.map((t) => val(t, 'unreadable')))].sort((a, b) => a - b);
for (const u of valeurs) ligne(`unreadable = ${u}`, lusU.filter((t) => val(t, 'unreadable') === u));
ligne('unreadable NON LU', rows.filter((t) => !lusU.includes(t)));
console.log('\n  ⚠️ `unreadable` compte NOS lectures ratees. S il separe, c est la couverture de la source');
console.log('     qui parle — pas une propriete du token. Meme reserve que `ownerState: unknown`.');
