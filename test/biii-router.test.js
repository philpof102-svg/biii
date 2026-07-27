#!/usr/bin/env node
'use strict';
/**
 * biii-router — « faut-il router un paiement vers ce beneficiaire ? »
 *
 * ⚠️ D'ABORD, L'ETAT REEL, parce qu'il change ce que ces tests valent: ce module est DORMANT. `shouldRoute`
 * est importe dans lib/server.js et jamais appele, et le balayage de fond est derriere BIII_ROUTER_ENABLED,
 * absente des variables de production (verifie via `railway variables` le 2026-07-27). Les fautes ci-dessous
 * n'ont donc trompe personne — elles attendaient le cablage que le fichier reclamait lui-meme.
 *
 * CE QUE L'EN-TETE DISAIT, ET QUI ETAIT LE PIEGE:
 *   « Integration: call shouldRoute(payeeAddress) before processing a BIII payment.
 *     If returns false, the address is not an active payee → reject or flag. »
 *
 * Suivre cette instruction refusait de payer:
 *   - TOUT LE MONDE avant le premier balayage (la table est vide, tout repond false);
 *   - tout commercant honnete sous 1000 $ de reglement QUOTIDIEN, c'est-a-dire la quasi-totalite.
 * Et le `false` ne distinguait pas « mesure sous le seuil » (une observation sur le beneficiaire) de
 * « jamais balaye » (une lacune de NOTRE cote) — la meme confusion que le sommet standing corrige ce
 * matin, deux etages plus haut dans le meme depot.
 *
 * Le volume de reglement mesure la LIQUIDITE, jamais l'honnetete: une fabrique a rugs bien financee
 * franchit le seuil, une boulangerie non.
 */
const assert = require('node:assert');
const { routeVerdict, shouldRoute, backgroundScan, startBackgroundScan, STALE_AFTER_MS, SCAN_INTERVAL_MS }
  = require('../lib/biii-router.js');
const { resetDailyVolumes } = require('../lib/usdc-filter.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GROS = '0x1111111111111111111111111111111111111111';
const PETIT = '0x2222222222222222222222222222222222222222';
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const log = (to, usd) => ({
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', blockNumber: '0x1',
  topics: [TOPIC, topicAddr(PETIT), topicAddr(to)],
  data: '0x' + BigInt(Math.round(usd * 1e6)).toString(16),
});
/** Un RPC qui repond eth_blockNumber puis eth_getLogs. */
const rpc = (logs, { echoue = false } = {}) => async (url, opts) => {
  const m = JSON.parse(opts.body).method;
  if (echoue) return { ok: false, status: 503, json: async () => ({}) };
  if (m === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ result: '0x2710' }) };
  return { ok: true, status: 200, json: async () => ({ result: logs }) };
};

console.log('biii-router: « pas encore regarde » n est pas « ce beneficiaire est douteux »');

/* ── les trois etats ─────────────────────────────────────────────────────────────────────────────── */

t('★ AVANT tout balayage: basis=unscanned, et la raison blame NOTRE cote', async () => {
  resetDailyVolumes();
  const v = routeVerdict(GROS);
  assert.strictEqual(v.route, false, 'fail-closed: on ne route pas sur une absence de donnee');
  assert.strictEqual(v.basis, 'unscanned');
  assert.match(v.reason, /gap on our side/i,
    'la raison doit designer notre lacune, pas une propriete du beneficiaire');
  assert.ok(!/threshold/i.test(v.reason), 'ne pas parler de seuil quand on n a rien mesure');
});

t('★ APRES balayage, sous le seuil: basis=measured, et ce n est PAS un verdict de securite', async () => {
  resetDailyVolumes();
  await backgroundScan({ fetchImpl: rpc([log(PETIT, 300)]) });
  const v = routeVerdict(PETIT);
  assert.strictEqual(v.route, false);
  assert.strictEqual(v.basis, 'measured', 'la, on a regarde — c est une observation');
  assert.match(v.reason, /NOT a safety verdict/i);
  assert.match(v.reason, /honest small merchant never reaches/i,
    'le lecteur doit savoir que « false » est l etat NORMAL d un petit commercant honnete');
});

t('★ les deux « false » ne se lisent PAS pareil — c etait toute la faute', async () => {
  resetDailyVolumes();
  const avant = routeVerdict(PETIT);
  await backgroundScan({ fetchImpl: rpc([log(PETIT, 300)]) });
  const apres = routeVerdict(PETIT);
  assert.strictEqual(avant.route, apres.route, 'meme decision…');
  assert.notStrictEqual(avant.basis, apres.basis, '…mais deux bases opposees');
  assert.notStrictEqual(avant.reason, apres.reason, 'et deux raisons distinctes, jamais un texte commun');
});

t('au-dessus du seuil: route=true, avec le volume mesure', async () => {
  resetDailyVolumes();
  await backgroundScan({ fetchImpl: rpc([log(GROS, 5000)]) });
  const v = routeVerdict(GROS);
  assert.strictEqual(v.route, true);
  assert.strictEqual(v.basis, 'measured');
  assert.ok(v.volumeUsd >= 1000, 'volume vu: ' + v.volumeUsd);
});

t('shouldRoute reste un booleen fail-closed, et suit routeVerdict', async () => {
  resetDailyVolumes();
  assert.strictEqual(shouldRoute(GROS), false, 'inconnu = on ne route pas');
  await backgroundScan({ fetchImpl: rpc([log(GROS, 5000)]) });
  assert.strictEqual(shouldRoute(GROS), true);
  assert.strictEqual(shouldRoute(PETIT), false);
});

t('une entree qui n est pas une adresse ne dit rien du beneficiaire', async () => {
  for (const mauvais of [null, undefined, 42, {}, '']) {
    const v = routeVerdict(mauvais);
    assert.strictEqual(v.route, false, JSON.stringify(mauvais));
    assert.strictEqual(v.basis, 'unscanned', 'rien n a ete cherche, donc rien n a ete mesure');
  }
});

/* ── la fraicheur ────────────────────────────────────────────────────────────────────────────────── */

t('★ des chiffres PERIMES redeviennent une lacune, pas une observation', async () => {
  /* `lastScan` n avance que sur un succes — deja juste. Mais apres un premier succes suivi d echecs, le
   * vieil horodatage restait et les volumes ressortaient en « measured ». Le reste du depot fait voyager
   * la fraicheur (asOf/ageDays/stale); ici elle n existait pas. */
  resetDailyVolumes();
  await backgroundScan({ fetchImpl: rpc([log(GROS, 5000)]) });
  const frais = routeVerdict(GROS);
  assert.strictEqual(frais.route, true, 'frais juste apres le balayage');

  const plusTard = routeVerdict(GROS, { now: Date.now() + STALE_AFTER_MS + 60000 });
  assert.strictEqual(plusTard.route, false, 'perime: on ne route plus sur du vieux');
  assert.strictEqual(plusTard.basis, 'unscanned', 'et ce n est plus presente comme une observation');
  assert.match(plusTard.reason, /stale past/i);
});

t('juste avant la peremption, la donnee vaut encore', async () => {
  resetDailyVolumes();
  await backgroundScan({ fetchImpl: rpc([log(GROS, 5000)]) });
  const v = routeVerdict(GROS, { now: Date.now() + STALE_AFTER_MS - 60000 });
  assert.strictEqual(v.route, true, 'la borne ne doit pas mordre trop tot');
  assert.strictEqual(v.basis, 'measured');
});

t('le delai de peremption est PUBLIE, pour qu il soit contestable', async () => {
  assert.strictEqual(STALE_AFTER_MS, 2 * SCAN_INTERVAL_MS, 'deux intervalles rates');
  assert.ok(STALE_AFTER_MS > 0);
});

/* ── le balayage de fond ─────────────────────────────────────────────────────────────────────────── */

t('un balayage qui ECHOUE ne produit pas une observation', async () => {
  /* On verifie la PROPRIETE, pas le libelle: selon ce qui precede dans le processus, la raison peut etre
   * « jamais balaye » ou « table videe depuis le dernier balayage ». Les deux disent la meme chose au
   * lecteur — la lacune est de notre cote — et ma premiere version exigeait la premiere formulation, ce
   * qui rendait le test faux des que la seconde, plus precise, s appliquait. Un test doit epingler ce
   * qu il defend, pas la phrase qui l exprimait le jour ou il a ete ecrit. */
  resetDailyVolumes();
  await backgroundScan({ fetchImpl: rpc([], { echoue: true }) });
  const v = routeVerdict(GROS);
  assert.strictEqual(v.route, false);
  assert.strictEqual(v.basis, 'unscanned', 'un echec ne devient jamais une mesure');
  assert.ok(!/threshold/i.test(v.reason), 'et il ne parle pas d un seuil qu on n a pas pu appliquer');
});

t('backgroundScan avale ses erreurs au lieu de tuer le serveur', async () => {
  /* C est un travail de fond: jeter ici arreterait le processus. L erreur est journalisee, et son EFFET
   * est visible dans routeVerdict — pas seulement dans un log que personne ne lit. */
  resetDailyVolumes();
  await assert.doesNotReject(() => backgroundScan({ fetchImpl: rpc([], { echoue: true }) }));
});

t('deux balayages simultanes ne se chevauchent pas', async () => {
  resetDailyVolumes();
  let appels = 0;
  const lent = async (url, opts) => {
    appels++;
    await new Promise((r) => setTimeout(r, 30));
    return rpc([log(GROS, 5000)])(url, opts);
  };
  const [a, b] = [backgroundScan({ fetchImpl: lent }), backgroundScan({ fetchImpl: lent })];
  await Promise.all([a, b]);
  assert.ok(appels <= 2, 'le second appel doit sortir tout de suite, pas relancer un balayage complet');
});

t('startBackgroundScan REND son minuteur, et il est unref', async () => {
  /* Sans le handle, le minuteur ne peut plus etre arrete: un test ne se termine jamais et un balayage
   * continue apres un arret propre du serveur. */
  const timer = startBackgroundScan({ fetchImpl: rpc([]), intervalMs: 60000 });
  assert.ok(timer, 'un handle doit revenir');
  assert.strictEqual(typeof timer.unref, 'function');
  clearInterval(timer);
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
