#!/usr/bin/env node
// probe-arrivee-densite.js — a quelle VITESSE arrive la preuve qu'attend le seuil de densite ?
// ================================================================================================
// `probe-divergences-densite.js` compte les divergences et refuse de chiffrer le seuil tant qu'il n'en
// a pas 20 sur lecture complete et resolues. Ce compte se lit comme une attente: il en faut 20, on en a
// quelques-unes, donc il suffit d'attendre. Cette sonde mesure si c'est vrai.
//
// Elle repond a UNE question: au rythme OBSERVE, dans combien de temps le chiffrage devient possible ?
// Et si la reponse est « des semaines », alors attendre n'est pas un plan et il faut le dire.
//
// ⛔ LE DENOMINATEUR NE SE DEVINE PAS. La tentation est de mesurer la duree sur le champ `firstSeen` des
// tokens qui portent une densite. C'est une autre quantite: l'ETALEMENT DES TOKENS, pas l'uptime de
// l'instrument. Les deux tombent proches et n'ont rien a voir — un token vu il y a trois jours peut
// recevoir le champ aujourd'hui. Le seul temoin de la mise en service est GIT: le plus ancien commit de
// `data/token-radar/tokens.json` qui contienne le champ. C'est ce que cette sonde lit.
//   ⚠️ Ce temoin depend de l'historique: un squash ou une reecriture le deplacerait, et le taux avec.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: combien de financeurs porteurs de densite sont apparus, sur quelle duree
// mesuree, combien franchissent le filtre du chiffrage, et l'intervalle de confiance du delai restant.
// ⛔ CE QU'ELLE NE PEUT PAS: promettre une date. Un taux estime sur k evenements a une dispersion enorme
// quand k est petit — c'est precisement pourquoi l'intervalle est publie A COTE du point, et non apres.
// ⛔ Elle ne peut pas non plus dire POURQUOI le rythme est ce qu'il est. Elle publie l'etat de balayage
// de chaque financeur; la lecture de ce tableau est le travail d'un humain.
//
// Lecture SEULE (un `git log`, un fichier JSON).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
/* ⛔ `execFileSync`, PAS `execSync`: sur Windows `execSync` passe par cmd.exe, qui a mange le `|` du
 * format git a la premiere execution de cette sonde. Un tableau d'arguments ne traverse aucun shell. */
const { execFileSync } = require('node:child_process');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');
/* ⛔ L'intervalle vit dans lib/poisson.js, teste par test/poisson.test.js. Une copie locale ici serait
 * le motif le plus cher de ce depot: le helper correct existe, et l'appelant a fort enjeu ne l'appelle
 * pas — sauf qu'ici l'appelant EST l'enjeu, puisque c'est l'intervalle qui porte toute la conclusion. */
const { intervallePoisson } = require('../../lib/poisson');

const CHAMP = 'siblingTxScanned';
const SEUIL_COMPTE = 20;
const SEUIL_DENSITE = 0.40;
const RACINE = path.join(__dirname, '..', '..');
const REL_DB = 'data/token-radar/tokens.json';

/* ── 1. QUAND L'INSTRUMENT A-T-IL ETE MIS EN SERVICE ? Git, pas les donnees. ──────────────────────── */
/* `-S` rend les commits ou le NOMBRE d'occurrences du terme change; le plus ancien est l'introduction. */
let miseEnService = null, commitService = null, erreurGit = null;
try {
  const sortie = execFileSync('git', ['log', '--format=%H|%aI', '-S', CHAMP, '--', REL_DB],
    { cwd: RACINE, encoding: 'utf8' }).trim();
  const lignes = sortie ? sortie.split('\n') : [];
  if (lignes.length) {
    const [sha, iso] = lignes[lignes.length - 1].split('|');
    commitService = sha.slice(0, 7);
    miseEnService = Date.parse(iso);
  }
} catch (e) { erreurGit = e.message; }

/* ── 2. CE QUI EST ARRIVE DEPUIS ─────────────────────────────────────────────────────────────────── */
const rows = Object.entries(JSON.parse(fs.readFileSync(path.join(RACINE, REL_DB), 'utf8')))
  .map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

/* Meme cle que la sonde de divergences: un financeur, pas un token. Deux financeurs distincts peuvent
 * entrer en collision sur le meme couple — ce qui SOUS-compte, donc le rythme publie est un PLANCHER. */
const parFinanceur = new Map();
for (const t of rows) {
  if (!(t[CHAMP] > 0) || typeof t.siblingCount !== 'number') continue;
  const cle = t.siblingCount + '/' + t[CHAMP];
  if (!parFinanceur.has(cle)) {
    parFinanceur.set(cle, { cle, compte: t.siblingCount, tx: t[CHAMP],
      arret: t.siblingScanStoppedBy || 'inconnu', tokens: [] });
  }
  parFinanceur.get(cle).tokens.push(t);
}

const financeurs = [...parFinanceur.values()].map((f) => {
  const densite = f.compte / f.tx;
  const parCompte = f.compte >= SEUIL_COMPTE;
  const parDensite = densite >= SEUIL_DENSITE;
  return { ...f, densite, diverge: parCompte !== parDensite,
    resolus: f.tokens.filter((t) => issue(t) !== null).length };
});

const complets = financeurs.filter((f) => f.arret === 'end');
const utiles = complets.filter((f) => f.diverge && f.resolus > 0);   // ce que le chiffrage exige

/* ── 3. UN TAUX, ET SA DISPERSION — parce qu'un taux sur k petit n'est pas un taux ───────────────── */
const heures = miseEnService ? (MAINTENANT - miseEnService) / 3600000 : null;

console.log('\n  ── L INSTRUMENT ──\n');
if (erreurGit) {
  console.log('    ⛔ git n a pas repondu: ' + erreurGit);
  console.log('       Sans date de mise en service, AUCUN taux ne se publie ici. Le compte reste lisible.');
} else if (!miseEnService) {
  console.log('    ⛔ Aucun commit de ' + REL_DB + ' ne contient ' + CHAMP + '.');
  console.log('       Soit le champ n a jamais ete persiste, soit l historique a ete reecrit. Rien a mesurer.');
} else {
  console.log('    mis en service   ' + new Date(miseEnService).toISOString() + '  (commit ' + commitService + ')');
  console.log('    mesure arretee a ' + new Date(MAINTENANT).toISOString());
  console.log('    duree mesuree    ' + heures.toFixed(2) + ' h');
}

console.log('\n  ── CE QUI EST ARRIVE ──\n');
console.log('    financeurs distincts porteurs d une densite  ' + financeurs.length);
const etats = new Map();
for (const f of financeurs) etats.set(f.arret, (etats.get(f.arret) || 0) + 1);
for (const [e, n] of [...etats.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('      ' + String(n).padStart(4) + '  ' + e);
}
console.log('    dont lecture COMPLETE (`end`)                ' + complets.length
  + (financeurs.length ? '   (' + (100 * complets.length / financeurs.length).toFixed(0) + ' %)' : ''));
console.log('    dont divergents ET resolus (le filtre)       ' + utiles.length + ' sur les ' + MIN_RESOLUS + ' exiges');

/* ── 4. LE DELAI, AVEC SES DEUX BORNES ───────────────────────────────────────────────────────────── */
if (heures && heures > 0) {
  const restant = MIN_RESOLUS - utiles.length;
  console.log('\n  ── LE DELAI, AU RYTHME OBSERVE ──\n');
  const taux = (n) => (n / heures);
  console.log('    financeurs / h                  ' + taux(financeurs.length).toFixed(3));
  console.log('    lectures completes / h          ' + taux(complets.length).toFixed(3));
  console.log('    divergences utiles / h          ' + taux(utiles.length).toFixed(3));
  if (restant <= 0) {
    console.log('\n    ✅ Le filtre est atteint: ' + utiles.length + ' divergence(s) utile(s). Le chiffrage devient possible.');
  } else {
    const [lo, hi] = intervallePoisson(utiles.length);   // bornes sur le NOMBRE attendu sur la duree mesuree
    const tauxLo = lo / heures, tauxHi = hi / heures;
    const jours = (r) => (r > 0 ? (restant / r / 24) : Infinity);
    console.log('\n    il en manque ' + restant + '.');
    console.log('    au point estime                 ' + jours(taux(utiles.length)).toFixed(1) + ' jour(s)');
    console.log('    borne OPTIMISTE (IC 95 % haut)  ' + jours(tauxHi).toFixed(1) + ' jour(s)');
    console.log('    borne PESSIMISTE (IC 95 % bas)  '
      + (Number.isFinite(jours(tauxLo)) ? jours(tauxLo).toFixed(0) + ' jour(s)' : 'jamais (le taux bas inclut 0)'));
    console.log('\n  ⚠️ L INTERVALLE EST LA MESURE, PAS LE POINT. Avec ' + utiles.length + ' evenement(s) observe(s), le');
    console.log('     point estime n a aucune autorite: l intervalle ci-dessus est ce qu on sait vraiment.');
    console.log('     Ce qu il autorise a dire est une ECHELLE (heures / jours / mois), jamais une date.');
  }
}

/* ── 5. OU LE DEBIT SE PERD — publie sans conclusion, parce que le remede a un cout ──────────────── */
const plancher = financeurs.filter((f) => f.arret === 'page_cap' || f.arret === 'read_error');
if (plancher.length && financeurs.length) {
  console.log('\n  ── OU LE DEBIT SE PERD ──\n');
  console.log('    ' + plancher.length + ' financeur(s) sur ' + financeurs.length + ' s arretent sur une borne, pas sur la fin de');
  console.log('    l historique. Leur densite est exacte DANS la fenetre et ne vaut pas comme taux de vie:');
  console.log('    ils ne comptent donc pas vers le chiffrage, quel que soit leur nombre.');
  console.log('  ⛔ CE N EST PAS UNE RECOMMANDATION DE LEVER LA BORNE. Elle borne aussi le COUT en appels');
  console.log('     explorateur par token, et sa valeur change le sens de `page_cap` pour tout ce qui le lit');
  console.log('     en aval. C est un arbitrage cout/semantique, il revient a un humain.\n');
}
