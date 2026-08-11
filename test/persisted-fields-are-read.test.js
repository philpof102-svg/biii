#!/usr/bin/env node
'use strict';
/**
 * Un champ calcule, ecrit, publie — et lu par personne.
 *
 * `test/trace-witness-persisted.test.js` garde le premier maillon: ce que `traceFeeder` renvoie doit
 * atteindre le disque. Il a ete ecrit apres la perte de `siblingTxScanned`. Ce test garde le maillon
 * SUIVANT, qui n'etait garde par rien: ce que le radar ECRIT doit etre LU par quelque chose qui note.
 *
 * ⛔ CE N'EST PAS THEORIQUE, ET LA NUIT DU 2026-08-07 L'A PAYE TROIS FOIS:
 *   · `symbolVerdict` est calcule sur 1830 lignes, stocke, et repris dans `identityWarning` — aucune
 *     regle notee ne le consomme. Six des douze plus gros rugs rates le portaient.
 *   · `funderTrace` distingue quatre etats de lecture sur 1309 lignes; `no_creator` rugge a 93,2 % et
 *     tombe en SILENCE dans la branche « sur ».
 *   · `relaunchOfRugged` est ecrit sur 781 lignes et n'est lu par aucune notation.
 *
 * ⚠️ CE QUE CE TEST NE FAIT PAS, ET C'EST DELIBERE. Il ne declare PAS qu'un orphelin est un defaut.
 * Beaucoup le sont legitimement: `dropPct` est une SORTIE de la decision de rug, `peakLiq`/`lastLiq`
 * sont le suivi qui la produit, `firstReason` est une phrase pour un humain. Exiger que tout champ
 * nourrisse une regle serait fabriquer une alarme. Ce que ce test exige, c'est que la liste des
 * orphelins soit DECLAREE: chaque entree de l'allowlist porte une raison, et un champ nouveau qui
 * n'est lu par personne fait echouer la porte tant que quelqu'un n'a pas ecrit pourquoi.
 *
 * ⛔ L'EXTRACTION PASSE PAR `lib/code-only.js`. Sans lui, la mention d'un champ dans un COMMENTAIRE le
 * fait compter comme ecrit: `token-radar.js:405` contient litteralement « db[c.addr].champ = » dans une
 * phrase explicative, et la premiere version de ce test l'a pris pour un champ. Le neutraliseur existe
 * et est teste; ne pas l'appeler etait le motif que ce depot paie le plus souvent.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { codeOnly } = require('../lib/code-only');

let pass = 0, fail = 0;
const t = (nom, fn) => { try { fn(); pass++; console.log('  ok   ' + nom); }
  catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); } };

const RACINE = path.join(__dirname, '..');
const lire = (rel) => codeOnly(fs.readFileSync(path.join(RACINE, rel), 'utf8'));

/** Les champs que le radar ECRIT sur une ligne de token. */
function champsEcrits(source) {
  const s = new Set();
  for (const m of source.matchAll(/db\[[^\]]+\]\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) s.add(m[1]);
  for (const m of source.matchAll(/\bt\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) s.add(m[1]);
  return s;
}
/**
 * Les champs qu'un consommateur LIT sur une ligne de token.
 * ⛔ `c.` est volontairement ABSENT de la liste des noms. Dans `prequential.js`, `c` est l'objet
 * COMPTEUR (`c.dangerRugged++`), pas un token: l'inclure ferait passer un compteur pour une lecture de
 * champ, et un compteur qui porterait par hasard le nom d'un champ persiste masquerait un vrai
 * orphelin. Verifie le 2026-08-08: avec ou sans `c`, la liste d'orphelins est identique (29) — le motif
 * n'apporte rien aujourd'hui et ne peut qu'affaiblir demain.
 */
function champsLus(source) {
  const s = new Set();
  for (const m of source.matchAll(/\b(?:t|token|h|row|x)\.([A-Za-z_$][\w$]*)/g)) s.add(m[1]);
  for (const m of source.matchAll(/\['([A-Za-z_$][\w$]*)'\]/g)) s.add(m[1]);
  return s;
}

/* Ce qui compte comme « notation »: ce qui transforme une ligne en verdict ou en score. Le digest et
 * les sondes lisent aussi des champs, mais lire pour AFFICHER n'est pas lire pour DECIDER. */
const CONSOMMATEURS = ['lib/prequential.js', 'lib/announced-rules.js', 'lib/scorecard.js'];

/**
 * ORPHELINS DECLARES. Chaque entree porte une raison, et la raison est le point du test: elle oblige
 * a dire pourquoi un champ ecrit n'entre dans aucune decision. Retirer une entree d'ici parce qu'elle
 * genait serait retirer la question.
 */
const DECLARES = {
  // — sorties et suivi: ce sont des RESULTATS de la decision, pas des entrees
  dropPct: 'sortie de la detection de rug, pas une entree de regle',
  peakLiq: 'suivi de liquidite qui PRODUIT `outcome`',
  lastLiq: 'suivi de liquidite qui PRODUIT `outcome`',
  liqMissStreak: 'compteur de lectures manquees, sert a la fraicheur',
  liqMissSince: 'horodatage de la premiere lecture manquee',
  // — texte pour un humain
  firstReason: 'phrase publiee, pas une variable de decision',
  /* ⚠️ MESURE DU 2026-08-11, qui change ce qu'on peut en faire: 673 lignes sur 2436 (27,6 pct) en
   * portent un, et le champ dit VRAI sans exception — 0/673 de ces lignes ont un `funder`, contre
   * 74,5 pct des lignes sans erreur. Mais la VENTILATION des messages compte plus que le total:
   *   631  « the explorer ANSWERED but records no creator for this address »  -> LIMITE DE LA SOURCE
   *    34  « the explorer did not answer for this token address »             -> panne, reessayable
   *     8  « could not resolve the deploying wallet »
   * ⇒ 94 pct de ces « erreurs » ne sont PAS des pannes: l'explorateur repond, il n'a simplement pas
   * l'information. Reessayer ces 631 ne changerait rien. Deux etats opposes sous un seul nom. */
  funderTraceError: 'message d erreur, lisible par un humain (94 pct = limite de source, pas panne)',
  identityWarning: 'phrase publiee; la variable de decision serait `symbolVerdict`',
  rejudgedReason: 'phrase publiee lors d un re-jugement',
  // — re-jugement et diagnostics
  rejudgedAt: 'horodatage de re-jugement',
  rejudgedVerdict: 'verdict de re-jugement, hors marche prequentielle',
  symbolCheck: 'trace brute de la verification de symbole',
  symbolCheckError: 'message d erreur de la verification de symbole',
  cleanBand: 'reste d une bande abandonnee (0 ligne en base)',
  cleanBandUnknown: 'reste d une bande abandonnee (0 ligne en base)',
  // — identites, gardees pour l enquete et non pour la note
  deployer: 'identite, gardee pour tracer; aucune regle ne note un deployeur',
  funder: 'identite; les regles notent `siblingCount`, pas l adresse',
  fundedEth: 'montant du financement, jamais entre dans une regle',
  identicalAmountEth: 'montant repete, sert au motif d usine dans le digest',
  impersonates: 'adresse du contrat dominant; la decision passerait par `symbolVerdict`',
  // — TEMOINS D INSTRUMENT: ils qualifient une mesure, ils ne se notent pas seuls
  siblingsRead: 'temoin: la fratrie a-t-elle ete lue',
  siblingPageCap: 'temoin: quel plafond de pages s appliquait',
  siblingScanStoppedBy: 'temoin: pourquoi le balayage s est arrete',
  siblingTxScanned: 'temoin: denominateur de la densite',
  siblingCountCensored: 'temoin: le compte est-il un plancher',
  identicalAmountSiblings: 'compte de virements identiques, lu par le digest',
  industrialFunder: 'copie de `siblingCount` au-dessus du seuil; la regle lit la source',
  /* ✅ `symbolVerdict` A QUITTE CETTE LISTE LE 2026-08-09, et c'est le garde qui l'a exige: la regle
   * `thin-sous-le-seuil` le LIT desormais dans `lib/prequential.js`, donc son marqueur de dette devenait
   * un mensonge. Une allowlist qu'on n'allege jamais finit par masquer les vrais orphelins — c'est
   * exactement ce que ce fichier teste par ailleurs (« l'allowlist ne contient pas de champ FANTOME »). */
  // — ⚠️ CANDIDATS MESURES ET NON NOTES. Ceux-la sont la vraie dette, et ils sont nommes comme telle.
  funderTrace: '⚠️ CANDIDAT MESURE, NON NOTE — 1309 lignes; `no_creator` rugge a 93,2 % (2026-08-08)',
  freshDeployer: '⚠️ CANDIDAT MESURE, NON NOTE — 1115 lignes; +58,9 pts sur lectures completes (2026-08-08)',
  relaunchOfRugged: '⚠️ CANDIDAT MESURE, NON NOTE — 781 lignes; jamais mesure, jamais note',
};

console.log('un champ ecrit par le radar est-il lu par quelque chose qui NOTE ?');

const radar = lire('hermes/economy/token-radar.js');
const ecrits = champsEcrits(radar);
const lus = new Set();
for (const f of CONSOMMATEURS) for (const c of champsLus(lire(f))) lus.add(c);
const orphelins = [...ecrits].filter((c) => !lus.has(c)).sort();

t('★ l EXTRACTION n est pas degeneree — sinon ce test passerait en ne verifiant rien', () => {
  /* Un succes-vide est le motif que `test-suite-must-count-itself` a deja coute a ce depot: si le
   * fichier change de forme et que les deux ensembles tombent a zero, tout « passe ». */
  assert.ok(ecrits.size >= 25, 'seulement ' + ecrits.size + ' champ(s) ecrit(s) reperes dans le radar — '
    + 'la forme du fichier a change et l extraction ne voit plus rien');
  assert.ok(lus.size >= 5, 'seulement ' + lus.size + ' champ(s) lu(s) reperes chez les consommateurs');
});

t('★ les COMMENTAIRES ne comptent pas comme des ecritures', () => {
  /* token-radar.js:405 contient litteralement « db[c.addr].champ = » dans une phrase explicative.
   * Sans `codeOnly`, ce test inventait un champ nomme `champ`. */
  assert.ok(!ecrits.has('champ'), 'le champ fantome `champ` vient d un commentaire: `codeOnly` n a pas '
    + 'ete applique, ou ne neutralise plus les blocs');
  const brut = fs.readFileSync(path.join(RACINE, 'hermes/economy/token-radar.js'), 'utf8');
  assert.ok(champsEcrits(brut).has('champ'), 'le temoin doit MORDRE: sur la source BRUTE, `champ` doit '
    + 'apparaitre — sinon ce cas ne prouve plus rien');
});

t('★ aucun champ ecrit n est orphelin SANS avoir ete declare', () => {
  const nonDeclares = orphelins.filter((c) => !(c in DECLARES));
  assert.deepStrictEqual(nonDeclares, [], 'champ(s) ecrit(s) par le radar et lu(s) par AUCUN '
    + 'consommateur de notation, et non declare(s) dans ce test:\n       ' + nonDeclares.join(', ')
    + '\n       Ajouter une entree dans DECLARES avec la RAISON — ou brancher le champ sur une regle. '
    + 'Le silence est ce que cette porte interdit.');
});

t('★ la porte MORD — un champ orphelin simule est detecte', () => {
  const simule = new Set([...ecrits, 'unChampQuePersonneNeLit']);
  const orph = [...simule].filter((c) => !lus.has(c) && !(c in DECLARES));
  assert.deepStrictEqual(orph, ['unChampQuePersonneNeLit'],
    'la porte doit reperer un champ ecrit que personne ne lit et que rien ne declare');
});

t('l allowlist ne contient pas de champ FANTOME — une entree morte masquerait un vrai orphelin', () => {
  /* Cas oppose du precedent: une allowlist qui grossit sans jamais maigrir finit par tout autoriser. */
  const fantomes = Object.keys(DECLARES).filter((c) => !ecrits.has(c));
  assert.deepStrictEqual(fantomes, [], 'entree(s) de DECLARES qui ne correspondent a aucun champ ecrit: '
    + fantomes.join(', ') + ' — les retirer, sinon l allowlist autorise du vide');
});

t('★ les CANDIDATS non notes sont nommes, pas noyes', () => {
  /* La dette utile n est pas « 30 orphelins », c est la poignee de lectures qui POURRAIENT decider et
   * qui ne decident pas. Elles portent un marqueur, et ce cas verifie qu il n a pas ete efface. */
  const candidats = Object.entries(DECLARES).filter(([, r]) => r.includes('CANDIDAT MESURE'));
  assert.ok(candidats.length >= 1, 'aucun candidat marque: si la dette a ete resorbee, ce cas doit etre '
    + 'mis a jour DELIBEREMENT, pas passer en silence');
  for (const [c] of candidats) {
    assert.ok(ecrits.has(c), 'le candidat ' + c + ' n est plus ecrit par le radar');
    assert.ok(!lus.has(c), 'le candidat ' + c + ' EST desormais lu par la notation — retirer son '
      + 'marqueur de DECLARES, la dette est payee');
  }
});

console.log('\n  inventaire: ' + ecrits.size + ' champ(s) ecrit(s) · ' + lus.size + ' lu(s) par la notation · '
  + orphelins.length + ' orphelin(s) declare(s), dont '
  + Object.values(DECLARES).filter((r) => r.includes('CANDIDAT MESURE')).length + ' CANDIDAT(S) non note(s)');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
