#!/usr/bin/env node
'use strict';
/**
 * holders-health — la couche 2 du verdict meme: la distribution des porteurs est-elle saine.
 *
 * ⚠️ CE FICHIER NE TESTAIT RIEN JUSQU'AU 2026-07-27, ET LE MODULE ETAIT FAUX DEPUIS AUSSI LONGTEMPS.
 * La version precedente appelait computeHealthMetrics puis checkHoldersHealth, imprimait les resultats
 * avec console.log, affichait « ✓ holders-health tests passed » et sortait 0. Zero assertion. Le module
 * qu'il ne verifiait pas contenait ceci:
 *
 *     const totalSupply        = sorted.reduce(...);                    // somme du TOP 10
 *     const top10Concentration = Number(sorted.reduce(...) * 100n / totalSupply);
 *
 * Le meme total au numerateur et au denominateur: la concentration valait 100 pour toute distribution.
 * Mesure avant correction — 1 baleine: 100. Deux porteurs egaux: 100. CINQ CENTS porteurs identiques,
 * la distribution la plus plate possible: 100. Un signal a variance nulle, qui n'observait rien.
 *
 * Consequence en aval, et c'est la qu'elle fait mal: rugScore ajoute 50 au-dessus de 80 et 30 au-dessus
 * de 60, donc il valait au moins 80 partout, donc `healthy = rugScore < 50 && ...` etait TOUJOURS faux.
 * Et lib/meme.js attache ce bloc au resultat de till_vet_meme pour tout token Base. On expediait donc
 * `healthy:false, score:100, top10Concentration:100` a des appelants, sur des tokens parfaitement
 * distribues: un chiffre jamais mesure, porte en affirmation NEGATIVE sur des tiers.
 *
 * Le test le plus important ci-dessous est donc celui qui exige que la concentration VARIE. Une valeur
 * constante passe toutes les assertions ecrites sur un seul cas — il en faut plusieurs, opposes.
 */
const assert = require('node:assert');
const { computeHealthMetrics, fetchTransfers, checkHoldersHealth } = require('../lib/holders-health.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

const ZERO = '0x0000000000000000000000000000000000000000';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const adr = (n) => '0x' + String(n).padStart(40, '0');
/** Une emission: le zero address vers un porteur. C'est ainsi qu'un token distribue ses jetons. */
const mint = (to, v) => ({ from: ZERO, to, value: BigInt(v), blockNumber: 1 });
const envoi = (from, to, v) => ({ from, to, value: BigInt(v), blockNumber: 1 });
const plats = (n, chacun) => Array.from({ length: n }, (_, i) => mint(adr(i + 1), chacun));

const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const faitRpc = (parMethode) => async (url, opts) => {
  const corps = JSON.parse(opts.body);
  const rep = parMethode[corps.method];
  if (typeof rep === 'function') return rep(corps);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: corps.id, result: rep }) };
};

console.log('holders-health: un score qui ne varie pas n est pas une mesure');

/* ── LA REGRESSION PRINCIPALE ────────────────────────────────────────────────────────────────────── */

t('la concentration VARIE selon la distribution — c est la regression a empecher', () => {
  /* LE test du fichier. Chacune des assertions ci-dessous, prise SEULE, passait aussi avec l ancien code
   * constant a 100 (pour la baleine, c est la bonne reponse). Il faut des cas OPPOSES pour qu une
   * constante soit demasquee: c est exactement pour cette raison qu un cas unique ne suffisait pas. */
  const baleine = computeHealthMetrics([mint(adr(1), 1000000)]);
  const plat = computeHealthMetrics(plats(500, 100));
  assert.strictEqual(baleine.top10Concentration, 100, 'un porteur unique EST le top 10');
  assert.ok(plat.top10Concentration < 10,
    '500 porteurs identiques: le top 10 en detient 2 %, vu ' + plat.top10Concentration);
  assert.notStrictEqual(baleine.top10Concentration, plat.top10Concentration,
    'deux distributions opposees DOIVENT donner deux valeurs — sinon la metrique est une constante');
});

t('le denominateur est le total des soldes positifs, pas la somme du top 10', () => {
  /* La faute exacte. 20 porteurs egaux: le top 10 en detient la moitie. Si le denominateur redevient la
   * somme du top 10, on relit 100. */
  const m = computeHealthMetrics(plats(20, 1000));
  assert.strictEqual(m.top10Concentration, 50, '10 sur 20 porteurs egaux = 50 %, vu ' + m.top10Concentration);
});

t('les pourcentages du top 10 se rapportent au total observe, et somment a la concentration', () => {
  const m = computeHealthMetrics(plats(20, 1000));
  const somme = m.top10Holders.reduce((s, h) => s + h.percent, 0);
  assert.strictEqual(m.top10Holders.length, 10);
  assert.strictEqual(somme, m.top10Concentration,
    'la somme des parts du top 10 EST la concentration du top 10, sinon l une des deux ment');
});

t('rugScore couvre reellement son intervalle — il valait 80 ou 100 partout', () => {
  const scores = [
    computeHealthMetrics(plats(500, 100)).rugScore,          // plat, beaucoup de porteurs
    computeHealthMetrics(plats(60, 100)).rugScore,           // plat, peu de porteurs
    computeHealthMetrics([mint(adr(1), 1000)]).rugScore,     // baleine
  ];
  assert.deepStrictEqual(scores, [0, 20, 100],
    'plat/peu-de-porteurs/baleine doivent donner trois scores distincts, vus: ' + JSON.stringify(scores));
});

/* ── la comptabilite des soldes ──────────────────────────────────────────────────────────────────── */

t('une EMISSION ne met pas l adresse zero en solde negatif', () => {
  /* Sans l exclusion du zero address, le mint creerait un « porteur » a solde tres negatif, qui ne
   * remonterait pas dans le top 10 mais fausserait tout total incluant les negatifs. */
  const m = computeHealthMetrics([mint(adr(1), 1000)]);
  assert.strictEqual(m.top10Holders.length, 1, 'un seul porteur');
  assert.strictEqual(m.top10Holders[0].address, adr(1));
  assert.ok(!m.top10Holders.some((h) => h.address === ZERO), 'le zero address n est jamais un porteur');
});

t('un BURN ne credite pas l adresse zero', () => {
  const m = computeHealthMetrics([mint(adr(1), 1000), envoi(adr(1), ZERO, 1000)]);
  assert.ok(!m.top10Holders.some((h) => h.address === ZERO), 'bruler n est pas detenir');
  assert.strictEqual(m.top10Concentration, 0, 'plus aucun solde positif');
});

t('les adresses sont comptees sans tenir compte de la CASSE', () => {
  /* Les logs RPC rendent du minuscule, mais une fixture ou un appelant peut fournir du checksumme. Deux
   * casses de la meme adresse comptees separement inventeraient un porteur et diviseraient son solde. */
  const A = '0xAbC0000000000000000000000000000000000dEf';
  const m = computeHealthMetrics([mint(A, 600), mint(A.toLowerCase(), 400)]);
  assert.strictEqual(m.holderCount, 1, 'une seule adresse, pas deux');
  assert.strictEqual(m.top10Holders.length, 1);
  assert.strictEqual(m.top10Holders[0].balance, '1000', 'les deux receptions se cumulent');
});

t('un solde devenu nul ou negatif sort du classement', () => {
  /* Une adresse qui a tout renvoye n est plus porteuse. La compter gonflerait artificiellement le
   * denominateur et ferait paraitre le token plus distribue qu il ne l est. */
  const m = computeHealthMetrics([mint(adr(1), 1000), mint(adr(2), 1000), envoi(adr(1), adr(2), 1000)]);
  assert.strictEqual(m.top10Holders.length, 1, 'seul le destinataire detient encore');
  assert.strictEqual(m.top10Holders[0].address, adr(2));
  assert.strictEqual(m.top10Holders[0].balance, '2000');
});

t('le classement est correct meme sur des soldes a 18 decimales', () => {
  /* ⚠️ CORRECTION DE MA PROPRE JUSTIFICATION. J'ai d'abord ecrit ici que le comparateur d'origine
   * — `Number(b[1] - a[1])` — se trompait sur des soldes a 18 decimales, parce que la difference depasse
   * Number.MAX_SAFE_INTEGER. C'est FAUX, et c'est la mutation qui me l'a appris: la remettre en place ne
   * fait pas rougir ce test. Verifie ensuite sur des contre-exemples construits exprès (ecart de 1 sur
   * 10^30, sur 10^60, et un ecart de 10^400): zero echec. La soustraction se fait en BigInt EXACT et
   * seul son resultat est converti; une difference non nulle ne peut pas devenir 0, et le signe survit
   * meme a Infinity — or un comparateur n'a besoin que du signe.
   *
   * Le passage a une comparaison BigInt directe est donc une clarification, PAS une correction de bug.
   * Ce test reste utile — il epingle l'ordre decroissant, que rien d'autre ne verifie — mais il ne peut
   * pas se reclamer d'une faute qui n'a jamais existe. Une mutation qui ne mord pas parce que le code
   * d'origine etait deja juste est une information, pas un trou. */
  const enorme = 10n ** 30n;
  const m = computeHealthMetrics([
    mint(adr(1), enorme + 1n), mint(adr(2), enorme + 3n), mint(adr(3), enorme + 2n),
  ]);
  assert.deepStrictEqual(m.top10Holders.map((h) => h.address), [adr(2), adr(3), adr(1)],
    'ordre decroissant exact malgre des ecarts sous le seuil de precision des flottants');
});

t('une liste vide rend des zeros, sans exception', () => {
  const m = computeHealthMetrics([]);
  assert.strictEqual(m.top10Concentration, 0);
  assert.strictEqual(m.holderCount, 0);
  assert.deepStrictEqual(m.top10Holders, []);
});

t('les chiffres sont accompagnes de ce qu ils NE sont pas', () => {
  /* Des soldes reconstruits sur une fenetre de blocs ne sont pas des positions on-chain, et
   * `holderCount` n est pas le nombre de detenteurs. Un appelant ne doit pas avoir a lire le module
   * pour l apprendre — c est la meme regle que partout ici: le chiffre voyage avec sa limite. */
  const m = computeHealthMetrics(plats(3, 10));
  assert.match(m.disclosure, /window/i, 'la fenetre de blocs doit etre dite');
  assert.match(m.disclosure, /RECEIVED during the window/i, 'ce que holderCount compte vraiment');
});

/* ── fetchTransfers: ce qu on demande a la chaine ────────────────────────────────────────────────── */

t('fetchTransfers demande les Transfer DU token vise, pas d un autre', async () => {
  let vu = null;
  const f = async (url, opts) => {
    vu = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ result: [] }) };
  };
  await fetchTransfers('0xTOKEN', { fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(vu.method, 'eth_getLogs');
  assert.strictEqual(vu.params[0].address, '0xTOKEN', 'le filtre d adresse porte le token demande');
  assert.deepStrictEqual(vu.params[0].topics, [TOPIC], 'Transfer, pas Approval');
});

t('fetchTransfers decode from/to/value depuis les topics et data', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ result: [
    { topics: [TOPIC, topicAddr(adr(1)), topicAddr(adr(2))], data: '0x3e8', blockNumber: '0x5' },
  ] }) });
  const [tx] = await fetchTransfers('0xTOKEN', { fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(tx.from, adr(1));
  assert.strictEqual(tx.to, adr(2));
  assert.strictEqual(tx.value, 1000n, '0x3e8 = 1000');
  assert.strictEqual(tx.blockNumber, 5);
});

t('fetchTransfers JETTE sur erreur HTTP — jamais une liste vide silencieuse', async () => {
  /* Rendre [] sur une panne ferait lire « aucun transfert, token mort » la ou il faut lire « je n ai pas
   * pu regarder ». Et [] descend en concentration 0 / rugScore bas: la panne se lirait comme une bonne
   * nouvelle. C est le pire sens possible pour un fail-open. */
  const f = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchTransfers('0xT', { fromBlock: '0x1', toBlock: '0x2', fetchImpl: f }), /503/);
});

t('fetchTransfers JETTE sur une erreur JSON-RPC rendue dans un 200', async () => {
  const f = async () => ({ ok: true, status: 200,
    json: async () => ({ error: { code: -32005, message: 'query timeout exceeded' } }) });
  await assert.rejects(() => fetchTransfers('0xT', { fromBlock: '0x1', toBlock: '0x2', fetchImpl: f }),
    /query timeout/);
});

/* ── checkHoldersHealth: le verdict expedie a till_vet_meme ──────────────────────────────────────── */

t('healthy:true est ATTEIGNABLE — il etait constamment faux', async () => {
  /* La consequence la plus visible du bug. Aucun token, si bien distribue soit-il, ne pouvait obtenir
   * healthy:true. Le verdict ne portait aucune information. */
  const f = faitRpc({
    eth_blockNumber: '0x2710',
    eth_getLogs: async () => ({ ok: true, status: 200, json: async () => ({ result:
      plats(200, 100).map((tx) => ({ topics: [TOPIC, topicAddr(ZERO), topicAddr(tx.to)],
        data: '0x' + tx.value.toString(16), blockNumber: '0x1' })) }) }),
  });
  const r = await checkHoldersHealth('0xTOKEN', { fetchImpl: f });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.healthy, true, '200 porteurs a parts egales est une distribution saine');
  assert.strictEqual(r.score, 0);
});

t('une baleine reste healthy:false — la correction ne desarme pas la detection', async () => {
  const f = faitRpc({
    eth_blockNumber: '0x2710',
    eth_getLogs: async () => ({ ok: true, status: 200, json: async () => ({ result: [
      { topics: [TOPIC, topicAddr(ZERO), topicAddr(adr(1))], data: '0xf4240', blockNumber: '0x1' },
    ] }) }),
  });
  const r = await checkHoldersHealth('0xTOKEN', { fetchImpl: f });
  assert.strictEqual(r.healthy, false);
  assert.strictEqual(r.score, 100, 'concentration maximale et presque aucun porteur');
});

t('une panne RPC rend FAIL-CLOSED: healthy false, score 100, et le motif', async () => {
  /* Ici l enveloppe try/catch est correcte et doit le rester: une lecture ratee ne devient jamais un
   * bon score. Le motif remonte pour que l appelant distingue « analyse: risque » de « pas analyse ». */
  const f = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await checkHoldersHealth('0xTOKEN', { fetchImpl: f });
  assert.strictEqual(r.healthy, false);
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.metrics, null, 'aucune metrique inventee a partir d une lecture ratee');
  assert.match(r.error, /500/, 'le motif de l echec doit etre lisible');
});

t('un eth_blockNumber en erreur ne se poursuit pas sur une plage inventee', async () => {
  const f = faitRpc({ eth_blockNumber: async () => ({ ok: true, status: 200,
    json: async () => ({ error: { message: 'node syncing' } }) }) });
  const r = await checkHoldersHealth('0xTOKEN', { fetchImpl: f });
  assert.strictEqual(r.healthy, false);
  assert.match(r.error, /syncing/);
});

(async () => {
  for (const [nom, fn] of files) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== files.length) {
    console.log('✗ ' + files.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
