'use strict';
/**
 * stale-downgrade-covers-every-verdict — la degradation par peremption doit couvrir TOUS les verdicts
 * rassurants que le producteur peut rendre, pas les deux qu'on avait en tete le jour ou on l'a ecrite.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER EMPECHE D'ARRIVER. `funder-history.js` degrade en `unknown_stale` sur une
 * condition ECRITE A LA MAIN:
 *
 *     if (stale && (base.verdict === 'funder_clean_so_far' || base.verdict === 'funder_unseen'))
 *
 * Le producteur, `funder-registry.js:assess()`, en rend QUATRE. Les quatre sont traites correctement
 * aujourd'hui — verifie: `funder_has_killed` reste debout quand la base est vieille (un kill observe
 * ne se dé-observe pas, le supprimer echouerait OUVERT), et `funder_untraceable` dit deja de lui-meme
 * « That is NOT a clearance », donc le degrader n'ajouterait rien.
 *
 * Le risque n'est donc pas l'etat present, c'est le SUIVANT. Une liste de cas ecrite dans un `||`
 * n'apprend rien quand un cinquieme verdict apparait: il tombe sur le `return` final et sort SERVI
 * TEL QUEL sur une base perimee. C'est le motif « un nouvel etat a besoin de sa branche », et sa forme
 * la plus chere est precisement celle-ci — l'etat neuf tombe du cote rassurant.
 *
 * Ce gate ne re-teste pas les quatre cas connus: test/funder-history.test.js le fait deja, par leur
 * nom, y compris `funder_untraceable` et le maintien de `funder_has_killed`. Il teste la PROPRIETE que
 * ce test-la ne peut pas tenir: que l'ensemble PRODUIT soit entierement couvert par l'ensemble TRAITE.
 *
 * Portee: lecture de SOURCE. Il prouve qu'un verdict est CLASSE, jamais qu'il est bien classe — le
 * jugement reste humain, ce que la liste EXEMPTES ci-dessous rend explicite au lieu de tacite.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n      ' + (e && e.message)); } };

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
/* ⚠️ Commentaires retires AVANT de compter: ce fichier-ci cite des noms de verdicts dans sa propre
 * prose, et les fichiers lus en citent aussi dans la leur. Une gate qui analyse du texte doit separer
 * le code de la prose, sinon elle se nourrit de ses propres explications. */
const codeSeul = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const registre = codeSeul(lire('funder-registry.js'));
const histoire = codeSeul(lire('funder-history.js'));

/* Les verdicts que le PRODUCTEUR peut rendre. */
const produits = [...new Set((registre.match(/verdict:\s*'([a-z_]+)'/g) || [])
  .map((m) => m.replace(/verdict:\s*'/, '').replace(/'$/, '')))].sort();

/* Ceux que la degradation nomme explicitement. */
const degrades = [...new Set((histoire.match(/base\.verdict === '([a-z_]+)'/g) || [])
  .map((m) => m.replace(/base\.verdict === '/, '').replace(/'$/, '')))].sort();

/* ⚖️ EXEMPTES — et chacun porte SA raison, pour qu'ajouter un nom ici soit un acte, pas un reflexe.
 * Un verdict n'entre ici que s'il ne peut pas etre lu comme rassurant. */
const EXEMPTES = {
  funder_has_killed: 'un kill deja observe ne se dé-observe pas: le degrader ferait DISPARAITRE une '
    + 'charge, ce qui echouerait OUVERT. Il doit rester debout sur une base perimee.',
  funder_untraceable: 'ne dit rien du payeur et le dit explicitement — « That is NOT a clearance ». '
    + 'Le degrader remplacerait un non-dit par un autre non-dit.',
};

console.log('BIII — la degradation par peremption couvre-t-elle tous les verdicts ?');
console.log('  produits par assess() : ' + produits.join(', '));
console.log('  degrades si perimes   : ' + degrades.join(', '));
console.log('  exemptes avec raison  : ' + Object.keys(EXEMPTES).sort().join(', '));

t('la lecture de source a bien trouve les deux ensembles — sinon ce test ne dit RIEN', () => {
  assert.ok(produits.length >= 4, 'au moins 4 verdicts produits (trouve ' + produits.length + ')');
  assert.ok(degrades.length >= 2, 'au moins 2 verdicts degrades (trouve ' + degrades.length + ')');
});

t('CHAQUE verdict produit est soit DEGRADE, soit EXEMPTE AVEC UNE RAISON', () => {
  const orphelins = produits.filter((v) => !degrades.includes(v) && !EXEMPTES[v]);
  assert.deepStrictEqual(orphelins, [],
    'verdict(s) non classe(s): ' + orphelins.join(', ') + '. Un verdict qui n est ni degrade ni exempte '
    + 'tombe sur le return final et sort SERVI TEL QUEL sur une base perimee. Le classer ici est le geste '
    + 'qui manque — et s il est rassurant, c est la condition de funder-history.js qu il faut etendre.');
});

/* ⚠️ CONTRE-BORNE. Sans elle, ce gate serait satisfait par quelqu'un qui declare TOUT exempte, ce qui
 * detruirait la degradation en la faisant passer pour couverte. */
t('la degradation nomme TOUJOURS les deux verdicts rassurants connus — on ne peut pas la vider', () => {
  for (const v of ['funder_clean_so_far', 'funder_unseen']) {
    assert.ok(degrades.includes(v), v + ' doit rester dans la condition de degradation de funder-history.js');
    assert.ok(!EXEMPTES[v], v + ' est rassurant: il ne peut PAS etre exempte');
  }
});

t('aucun EXEMPTE ne designe un verdict que le producteur ne rend plus — la liste ne fossilise pas', () => {
  const morts = Object.keys(EXEMPTES).filter((v) => !produits.includes(v));
  assert.deepStrictEqual(morts, [],
    'exemption(s) sans verdict correspondant: ' + morts.join(', ') + '. Une exemption qui ne protege plus '
    + 'rien donne l illusion d une couverture reflechie.');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
