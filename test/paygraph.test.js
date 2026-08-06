#!/usr/bin/env node
'use strict';
/**
 * paygraph — le detecteur attrape-t-il les fraudes qu'on lui construit expres ?
 *
 * POURQUOI DES GRAPHES SYNTHETIQUES
 * Sur des donnees reelles on ne connait pas la verite terrain: un paiement suspect peut etre un vrai
 * service. Ici on FABRIQUE le lavage et le Sybil, donc on sait exactement ce qui doit tomber. Un detecteur
 * qui ne tombe pas sur un cas construit pour lui ne tombera jamais sur un vrai.
 *
 * ET POURQUOI CE TEST NE COUTE RIEN
 * Le vrai test de l'economie n'est pas de deplacer de l'argent — c'est de savoir si le detecteur distingue
 * un paiement porteur d'information d'un aller-retour. Ca se prouve hors-ligne, sur des fixtures, sans
 * qu'un centime bouge. Le module ne signe rien et ne detient aucune cle.
 */
const assert = require('node:assert');
const P = require('../lib/paygraph.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const H = 3600 * 1000;
const acteur = (id, extra = {}) => ({ id, ...extra });

console.log('paygraph: un paiement qui revient n est pas une reputation');

t('le cas HONNETE compte: 3 acteurs independants, paiements a sens unique', () => {
  const actors = { a: acteur('a', { funder: '0xF1', host: 'h1' }), b: acteur('b', { funder: '0xF2', host: 'h2' }), c: acteur('c', { funder: '0xF3', host: 'h3' }) };
  const r = P.assess([
    { from: 'a', to: 'b', amount: 10, at: 0 },
    { from: 'a', to: 'c', amount: 5, at: 1 * H },
    { from: 'b', to: 'c', amount: 7, at: 2 * H },
  ], actors);
  assert.equal(r.counted.length, 3, 'les 3 aretes doivent compter');
  assert.equal(r.excluded.length, 0);
  assert.equal(r.reputation.c, 12, 'c a recu 5+7');
  assert.equal(r.reputation.b, 10);
  assert.equal(r.coverage, 1);
});

console.log('\nles trois fraudes, construites expres');

t('LAVAGE a 2: A paie B puis B rembourse A — la seconde arete ne compte pas', () => {
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([
    { from: 'a', to: 'b', amount: 100, at: 0 },
    { from: 'b', to: 'a', amount: 100, at: 1 * H },
  ], actors);
  const raisons = r.excluded.map((e) => e.reason);
  assert.ok(raisons.includes('reciprocity') || raisons.includes('cycle'),
    'le retour doit tomber (reciprocite ou cycle), vu: ' + JSON.stringify(raisons));
  assert.ok(r.counted.length <= 1, 'au plus UNE arete peut compter, vu ' + r.counted.length);
});

t('LAVAGE a 3: la boucle A->B->C->A est detectee comme cycle', () => {
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }), c: acteur('c', { funder: '0xF3' }) };
  const r = P.assess([
    { from: 'a', to: 'b', amount: 50, at: 0 },
    { from: 'b', to: 'c', amount: 50, at: 1 * H },
    { from: 'c', to: 'a', amount: 50, at: 2 * H },
  ], actors);
  assert.ok(r.cycles.length >= 1, 'au moins un cycle attendu, vu ' + r.cycles.length);
  assert.equal(r.counted.length, 0, 'aucune arete d un cycle pur ne doit compter');
  assert.deepStrictEqual(Object.keys(r.reputation), [], 'reputation nulle sur un carrousel');
});

t('SYBIL: dix agents du meme proprietaire, finances separement', () => {
  /* Le graphe de financeurs seul echoue ici — chaque wallet a son propre funder. C est le champ `owner`
   * (ou `host`) qui sauve la mise, et c est exactement ce que Honey a nomme le 2026-07-27:
   * « cluster par origine, pas par wallet ». */
  const actors = {}, pays = [];
  for (let i = 0; i < 10; i++) actors['s' + i] = acteur('s' + i, { funder: '0xF' + i, owner: 'mallory' });
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) if (i !== j) pays.push({ from: 's' + i, to: 's' + j, amount: 1, at: i * 1000 });
  const r = P.assess(pays, actors);
  assert.equal(r.counted.length, 0, '90 paiements intra-cluster, ZERO ne doit compter');
  assert.ok(r.excluded.every((e) => ['same_cluster', 'cycle', 'reciprocity'].includes(e.reason)));
  assert.equal(r.coverage, 0);
});

t('SYBIL PARTIEL: le cluster ne contamine pas les paiements venus du dehors', () => {
  const actors = {
    s0: acteur('s0', { funder: '0xA', owner: 'mallory' }),
    s1: acteur('s1', { funder: '0xB', owner: 'mallory' }),
    honest: acteur('honest', { funder: '0xZ', owner: 'alice' }),
  };
  const r = P.assess([
    { from: 's0', to: 's1', amount: 100, at: 0 },        // intra-cluster -> exclu
    { from: 'honest', to: 's1', amount: 3, at: 1 * H },  // externe -> compte
  ], actors);
  assert.equal(r.counted.length, 1, 'seul le paiement externe compte');
  assert.equal(r.reputation.s1, 3, 'la reputation de s1 vaut 3, pas 103');
  assert.equal(r.excluded[0].reason, 'same_cluster');
});

console.log('\nfail-closed: l inconnu ne compte pas comme bon');

t('un acteur SANS profil ne peut pas produire de reputation', () => {
  const r = P.assess([{ from: 'inconnu', to: 'b', amount: 999, at: 0 }], { b: acteur('b', { funder: '0xF2' }) });
  assert.equal(r.counted.length, 0);
  assert.equal(r.excluded[0].reason, 'unknown_actor');
  assert.equal(r.reputation.b, undefined, 'aucune reputation depuis un payeur non etabli');
});

t('un auto-paiement est refuse avant tout le reste', () => {
  const r = P.assess([{ from: 'a', to: 'a', amount: 1000, at: 0 }], { a: acteur('a') });
  assert.equal(r.counted.length, 0);
  assert.equal(r.excluded[0].reason, 'self_payment');
});

t('★ une entree vide rend NULL, pas 0 et pas 1 — trois etats, pas deux', () => {
  /* ⚠️ CE CAS ASSERTAIT `coverage === 0`, et son commentaire disait « couverture 0 sur vide, jamais 1 ».
   * L arbitrage etait entre DEUX valeurs et prenait la plus prudente, ce qui etait le bon reflexe sur une
   * liste trop courte: `0/0` n est pas zero, il est INDEFINI. Un `0` de couverture se lit « on a regarde
   * et on n a rien couvert »; sur une entree vide, il n y avait rien a couvrir. La distinction porte:
   * `provenShare: 0` accuse un acteur de n avoir rien prouve alors qu il n avait rien a prouver. */
  for (const vide of [[], null, undefined, 'pas un tableau']) {
    const r = P.assess(vide, {});
    assert.equal(r.counted.length, 0, JSON.stringify(vide));
    assert.strictEqual(r.coverage, null, 'rien a couvrir: null, ni 0 ni 1 — ' + JSON.stringify(vide));
    assert.strictEqual(r.coverageOf, 0, 'et le denominateur voyage avec, pour qu un null ne soit pas muet');
    assert.strictEqual(r.delivery.provenShare, null, 'aucune livraison a prouver n est pas une part nulle');
    assert.strictEqual(r.delivery.provenOf, 0);
  }
});

t('★ le cas OPPOSE: un denominateur NON vide rend un vrai chiffre, y compris un vrai zero', () => {
  /* Sans ce cas, un `null` cable en dur passerait exactement comme le correctif. */
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([{ from: 'a', to: 'b', amount: 40, at: 0 }], actors);
  assert.strictEqual(r.coverage, 1, 'une arete comptee sur une arete fournie: couverture pleine');
  assert.strictEqual(r.coverageOf, 1);
  assert.strictEqual(r.delivery.provenShare, 0, 'une arete comptee sans preuve de livraison: un VRAI zero');
  assert.strictEqual(r.delivery.provenOf, 1, 'et il repose sur un denominateur de 1, qui se lit');
});

console.log('\nla reciprocite a une FENETRE, sinon elle punit le commerce normal');

t('rendre la pareille APRES la fenetre reste de l information', () => {
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const tard = P.assess([
    { from: 'a', to: 'b', amount: 10, at: 0 },
    { from: 'b', to: 'a', amount: 10, at: 100 * H },     // trois jours plus tard
  ], actors, { reciprocityWindowMs: 24 * H, maxCycleLen: 1 });   // cycles desactives pour isoler la regle
  assert.equal(tard.counted.length, 2, 'deux echanges espaces sont deux services, pas un lavage');

  const vite = P.assess([
    { from: 'a', to: 'b', amount: 10, at: 0 },
    { from: 'b', to: 'a', amount: 10, at: 1 * H },
  ], actors, { reciprocityWindowMs: 24 * H, maxCycleLen: 1 });
  assert.equal(vite.counted.length, 1, 'un renvoi dans l heure ne compte pas');
});

console.log('\nlivraison: deux bornes, jamais une seule');

t('un paiement LIVRE compte dans les DEUX bornes', () => {
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([{ from: 'a', to: 'b', amount: 10, at: 0, deliveryVerdict: 'served' }], actors);
  assert.equal(r.reputationPaid.b, 10, 'borne haute');
  assert.equal(r.reputationServed.b, 10, 'borne basse — la livraison est prouvee');
  assert.equal(r.delivery.served, 1);
  assert.equal(r.delivery.provenShare, 1);
});

t('un paiement NON VERIFIABLE compte dans la haute, PAS dans la basse', () => {
  /* C est l etat de presque toute transaction d agent aujourd hui (cf. lib/delivery.js). L exclure
   * rendrait le systeme inutilisable au lancement; l inclure sans le dire ferait passer un paiement pour
   * une preuve de service. On le compte dans une borne et pas dans l autre, et l ecart est l information. */
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([{ from: 'a', to: 'b', amount: 40, at: 0 }], actors);   // aucun verdict fourni
  assert.equal(r.reputationPaid.b, 40, 'paye: 40');
  assert.equal(r.reputationServed.b, undefined, 'servi: rien de prouve');
  assert.equal(r.delivery.unverifiable, 1);
  assert.equal(r.delivery.provenShare, 0, 'part prouvee nulle, et elle doit se voir');
});

t('une SUBSTITUTION est retiree des DEUX bornes', () => {
  /* L acheteur a paye et recu autre chose que ce qui etait engage. Compter ca recompenserait la
   * substitution — c est le seul verdict de livraison qui retire activement une arete. */
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([{ from: 'a', to: 'b', amount: 999, at: 0, deliveryVerdict: 'substituted' }], actors);
  assert.equal(r.counted.length, 0, 'l arete ne compte plus du tout');
  assert.equal(r.reputationPaid.b, undefined, 'pas de reputation payee');
  assert.equal(r.reputationServed.b, undefined, 'ni servie');
  assert.equal(r.excluded.pop().reason, 'delivery_substituted');
});

t('l ecart entre les deux bornes est lisible sur un cas mixte', () => {
  const actors = {
    a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }),
    c: acteur('c', { funder: '0xF3' }), d: acteur('d', { funder: '0xF4' }),
  };
  const r = P.assess([
    { from: 'a', to: 'd', amount: 10, at: 0, deliveryVerdict: 'served' },
    { from: 'b', to: 'd', amount: 30, at: 1 * H },                          // non verifiable
    { from: 'c', to: 'd', amount: 50, at: 2 * H, deliveryVerdict: 'substituted' },
  ], actors);
  assert.equal(r.reputationPaid.d, 40, 'paye = 10 + 30 (la substitution est retiree)');
  assert.equal(r.reputationServed.d, 10, 'servi = 10 seulement');
  assert.equal(r.delivery.substituted, 1);
  assert.ok(r.delivery.provenShare > 0 && r.delivery.provenShare < 1, 'une part prouvee intermediaire');
});

t('`reputation` reste l alias de la borne HAUTE (compatibilite)', () => {
  const actors = { a: acteur('a', { funder: '0xF1' }), b: acteur('b', { funder: '0xF2' }) };
  const r = P.assess([{ from: 'a', to: 'b', amount: 7, at: 0 }], actors);
  assert.deepStrictEqual(r.reputation, r.reputationPaid, 'alias, pour ne pas casser un appelant existant');
});

console.log('\nla sortie se qualifie elle-meme');

t('la divulgation dit ce qu un paiement NE prouve PAS', () => {
  const r = P.assess([], {});
  assert.match(r.disclosure, /JAMAIS qu un service a ete rendu/i, 'paiement != livraison doit etre dit');
  assert.match(r.disclosure, /Aucun fonds n est deplace/i, 'la posture doit etre dans la sortie');
  assert.match(r.disclosure, /n est pas une accusation/i, 'une exclusion n accuse personne');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
