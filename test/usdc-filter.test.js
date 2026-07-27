#!/usr/bin/env node
'use strict';
/**
 * usdc-filter — le filtre qui decide quelles adresses valent la peine d'etre routees.
 *
 * ⚠️ CE FICHIER NE TESTAIT RIEN JUSQU'AU 2026-07-27. Sa version precedente appelait trois fonctions,
 * imprimait leurs resultats avec console.log, puis affichait « ✓ usdc-filter tests passed » et sortait 0.
 * Aucune assertion. Il ne pouvait echouer que si un appel JETAIT — donc il serait reste vert si
 * scanTransfers avait rendu undefined, si isActivePayee avait toujours repondu true, ou si le filtre
 * d'adresse avait laisse passer n'importe quel token. Son attente etait meme ecrite EN COMMENTAIRE:
 *
 *     const isActive = isActivePayee('0x1234...');
 *     console.log('isActivePayee (1000 USDC):', isActive); // Should be false (< $1k)
 *
 * Une attente en commentaire ne se verifie pas, et une coche verte au-dessus de zero assertion est pire
 * qu'un fichier absent: elle occupe la place ou un vrai test aurait ete ecrit. Trouve par le compteur
 * d'agregat (`npm run test:total`), qui a signale 63 bilans pour 68 fichiers lances.
 *
 * Ce que le module fait vraiment: il lit les logs Transfer de l'USDC sur Base, cumule le volume QUOTIDIEN
 * recu par adresse, et ne considere « active » qu'au-dela de 1000 $. L'etat vit dans une Map de module,
 * donc chaque test repart de resetDailyVolumes().
 */
const assert = require('node:assert');
const {
  scanTransfers, isActivePayee, getActivePayees, resetDailyVolumes, dailyVolumes,
} = require('../lib/usdc-filter.js');
const { USDC_BASE } = require('../lib/till.js');

/* ORDONNANCEMENT EXPLICITE. Les cas sont EMPILES ici et executes en sequence tout en bas, chacun attendu.
 * Un harnais qui lance des cas asynchrones sans les attendre imprimerait « 0 failed » avant que la
 * moitie d'entre eux ait fini — un vert obtenu en ne regardant pas, precisement la faute que ce fichier
 * existe pour reparer. Empiler puis derouler rend la chose impossible plutot qu'improbable. */
let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);
const ta = t;

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PAYEE = '0x1234567890123456789012345678901234567890';
const AUTRE = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
/* ⚠️ PAYEE ne contient QUE DES CHIFFRES, donc `PAYEE.toUpperCase()` lui est identique. Une adresse qui
 * porte des lettres est indispensable pour tester quoi que ce soit sur la casse — le premier jet utilisait
 * PAYEE et le test passait meme apres avoir retire le `.toLowerCase()` du module: une fixture incapable
 * d'exprimer la propriete qu'elle affirmait couvrir. Trouve par mutation, pas par relecture. */
const AVEC_LETTRES = '0xAbC0000000000000000000000000000000000dEf';
/** Un topic d'adresse: 32 octets, l'adresse cadree a droite. C'est ce que le module tranche a slice(26). */
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
/** micro-USDC en hex — l'USDC a 6 decimales, donc 1000 $ = 1e9 micro. */
const dataUsd = (usd) => '0x' + BigInt(Math.round(usd * 1e6)).toString(16);
const log = (to, usd, extra = {}) => ({
  address: USDC_BASE, blockNumber: '0x1',
  topics: [TRANSFER_TOPIC, topicAddr(AUTRE), topicAddr(to)],
  data: dataUsd(usd), ...extra,
});
/** Un faux RPC qui rend les logs fournis, et retient ce qu'on lui a demande. */
const rpcAvec = (logs, { httpOk = true, rpcError = null } = {}) => {
  const vu = { corps: null };
  const f = async (url, opts) => {
    vu.corps = JSON.parse(opts.body);
    return {
      ok: httpOk, status: httpOk ? 200 : 503,
      json: async () => (rpcError ? { jsonrpc: '2.0', id: 1, error: rpcError } : { jsonrpc: '2.0', id: 1, result: logs }),
    };
  };
  return { f, vu };
};

console.log('usdc-filter: le seuil qui decide qui vaut la peine d etre route');

/* ── le couplage inter-fichiers qui casserait tout en silence ─────────────────────────────────────── */

t('USDC_BASE est en MINUSCULES, sinon le filtre d adresse ne laisse plus rien passer', () => {
  /* lib/usdc-filter.js ligne 52 compare `String(log.address).toLowerCase() !== USDC_BASE`. Le membre de
   * droite n'est PAS normalise. Si quelqu'un passe la constante en casse checksummee dans lib/till.js —
   * une modification parfaitement raisonnable, et invisible depuis ce fichier-ci — la comparaison devient
   * toujours vraie, chaque log est ignore, aucune adresse n'est jamais active, et RIEN ne le signale:
   * pas d'exception, pas de log, juste un filtre qui rend systematiquement false. */
  assert.strictEqual(USDC_BASE, USDC_BASE.toLowerCase(),
    'un USDC_BASE checksumme desactive silencieusement tout le comptage de volume');
});

/* ── ce qui est compte, et ce qui est refuse ─────────────────────────────────────────────────────── */

ta('un transfert USDC credite le DESTINATAIRE (topics[2]), jamais l emetteur', async () => {
  /* Se tromper de topic crediterait le payeur du volume de sa propre depense — et l adresse « active »
   * affichee serait celle de quelqu un d autre. */
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 2500)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), true, 'le destinataire est credite');
  assert.strictEqual(isActivePayee(AUTRE), false, 'l emetteur ne l est pas');
});

ta('un log d un AUTRE token est refuse, meme s il imite le topic Transfer', async () => {
  /* N importe qui peut deployer un contrat qui emet un Transfer nomant une adresse. Sans le filtre
   * d adresse, un token sans valeur fabriquerait du « volume USDC » a volonte. */
  resetDailyVolumes();
  const faux = { ...log(PAYEE, 999999), address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
  const { f } = rpcAvec([faux]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), false, 'un token arbitraire ne cree pas de volume USDC');
  assert.strictEqual(dailyVolumes.size, 0, 'et il ne laisse aucune entree derriere lui');
});

ta('un log malforme est saute, il n interrompt pas le lot', async () => {
  /* Un seul log bizarre ne doit pas faire perdre les autres: la boucle en traite des centaines. */
  resetDailyVolumes();
  const { f } = rpcAvec([
    { address: USDC_BASE, topics: [TRANSFER_TOPIC], data: '0x1' },     // pas assez de topics
    { address: USDC_BASE, topics: [TRANSFER_TOPIC, topicAddr(AUTRE), topicAddr(PAYEE)], data: 'pas du hex' },
    null,
    log(PAYEE, 1500),                                                   // celui-ci doit survivre
  ]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), true, 'le log valide du lot est bien compte');
});

ta('la requete demande bien les Transfer de l USDC, pas autre chose', async () => {
  /* Un mauvais topic irait chercher des Approval — des montants autorises, jamais deplaces — et le
   * « volume regle » serait une fiction. Personne ne le verrait: la forme des logs est identique. */
  resetDailyVolumes();
  const { f, vu } = rpcAvec([]);
  await scanTransfers({ fromBlock: '0x10', toBlock: '0x20', fetchImpl: f });
  assert.strictEqual(vu.corps.method, 'eth_getLogs');
  assert.strictEqual(vu.corps.params[0].address, USDC_BASE);
  assert.deepStrictEqual(vu.corps.params[0].topics, [TRANSFER_TOPIC]);
});

ta('un fromBlock en BigInt est converti en hex, pas envoye en decimal', async () => {
  resetDailyVolumes();
  const { f, vu } = rpcAvec([]);
  await scanTransfers({ fromBlock: 255n, toBlock: 256n, fetchImpl: f });
  assert.strictEqual(vu.corps.params[0].fromBlock, '0xff', 'un bloc en decimal serait lu comme un autre bloc');
  assert.strictEqual(vu.corps.params[0].toBlock, '0x100');
});

/* ── le seuil ────────────────────────────────────────────────────────────────────────────────────── */

ta('sous 1000 $ l adresse n est PAS active — l attente ecrite en commentaire, enfin verifiee', async () => {
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 999.99)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), false);
  assert.deepStrictEqual(getActivePayees(), [], 'et elle n apparait pas dans la liste');
});

ta('exactement 1000 $ suffit: le seuil est >=, pas >', async () => {
  /* Le commentaire du module dit « >$1k », le code dit `>= DAILY_VOLUME_THRESHOLD`. On epingle le CODE,
   * et on note l ecart plutot que de le supposer sans importance. */
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 1000)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), true, 'la borne est inclusive');
});

ta('le volume s ACCUMULE: deux virements sous le seuil peuvent le franchir ensemble', async () => {
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 600), log(PAYEE, 600)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), true, '600 + 600 franchit 1000');
  const actifs = getActivePayees();
  assert.strictEqual(actifs.length, 1);
  assert.ok(Math.abs(actifs[0].volume - 1200) < 1e-6, 'volume vu: ' + actifs[0].volume);
});

t('une adresse jamais vue est inactive, pas une erreur', () => {
  resetDailyVolumes();
  assert.strictEqual(isActivePayee('0x' + '9'.repeat(40)), false);
  assert.strictEqual(isActivePayee(undefined), false, 'une entree absente n est pas une exception');
});

ta('isActivePayee accepte une adresse en casse CHECKSUMMEE', async () => {
  /* Les portefeuilles et les explorateurs rendent des adresses en casse mixte. Une recherche sensible a
   * la casse repondrait « inactive » a une adresse pourtant connue — un faux negatif silencieux, et sur
   * un filtre de routage un faux negatif se traduit par un paiement qu on refuse d aider. */
  resetDailyVolumes();
  const { f } = rpcAvec([log(AVEC_LETTRES, 5000)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.notStrictEqual(AVEC_LETTRES, AVEC_LETTRES.toLowerCase(),
    'la fixture DOIT differer de sa forme minuscule, sinon ce test ne verifie rien');
  assert.strictEqual(isActivePayee(AVEC_LETTRES), true, 'la forme mixte doit retrouver l entree');
  assert.strictEqual(isActivePayee(AVEC_LETTRES.toLowerCase()), true, 'la forme minuscule aussi');
});

/* ── la fenetre de 24 h ──────────────────────────────────────────────────────────────────────────── */

ta('une entree de plus de 24 h est PURGEE et redevient inactive', async () => {
  /* « Volume quotidien » n a de sens que si le compteur oublie. Sans purge, une adresse active un jour
   * le resterait pour toujours, et le filtre finirait par tout laisser passer. */
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 5000)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(isActivePayee(PAYEE), true, 'active juste apres');

  dailyVolumes.get(PAYEE.toLowerCase()).lastUpdate = Date.now() - (25 * 60 * 60 * 1000);
  assert.strictEqual(isActivePayee(PAYEE), false, '25 h plus tard, plus active');
  assert.strictEqual(dailyVolumes.has(PAYEE.toLowerCase()), false, 'l entree perimee est bien supprimee');
});

ta('getActivePayees purge aussi les perimees au lieu de les lister', async () => {
  resetDailyVolumes();
  const { f } = rpcAvec([log(PAYEE, 5000), log(AUTRE, 8000)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(getActivePayees().length, 2);

  dailyVolumes.get(PAYEE.toLowerCase()).lastUpdate = Date.now() - (25 * 60 * 60 * 1000);
  const restants = getActivePayees();
  assert.strictEqual(restants.length, 1, 'la perimee ne doit plus etre listee');
  assert.strictEqual(restants[0].address, AUTRE.toLowerCase());
});

ta('resetDailyVolumes efface reellement tout', async () => {
  const { f } = rpcAvec([log(PAYEE, 5000)]);
  await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.ok(dailyVolumes.size > 0, 'il y a bien quelque chose a effacer');
  resetDailyVolumes();
  assert.strictEqual(dailyVolumes.size, 0);
  assert.strictEqual(isActivePayee(PAYEE), false);
});

/* ── les pannes ──────────────────────────────────────────────────────────────────────────────────── */

ta('un RPC en erreur HTTP JETTE — il ne rend pas silencieusement zero', async () => {
  /* Rendre 0 sur une panne reseau ferait lire « aucun transfert » la ou il faut lire « je n ai pas pu
   * regarder ». C est la meme distinction que le sommet standing du triangle de confiance. */
  resetDailyVolumes();
  const { f } = rpcAvec([], { httpOk: false });
  await assert.rejects(() => scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f }), /503/);
  assert.strictEqual(dailyVolumes.size, 0, 'et rien n est ecrit a partir d une reponse ratee');
});

ta('une erreur JSON-RPC dans un 200 JETTE aussi', async () => {
  /* Un 200 portant `{"error": ...}` est le cas le plus traitre: la couche HTTP est verte. */
  resetDailyVolumes();
  const { f } = rpcAvec([], { rpcError: { code: -32000, message: 'query returned more than 10000 results' } });
  await assert.rejects(() => scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f }),
    /10000 results/, 'le motif du refus doit remonter, pas etre aplati');
});

ta('un resultat vide rend 0 et ne cree aucune entree', async () => {
  resetDailyVolumes();
  const { f } = rpcAvec([]);
  const n = await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(n, 0);
  assert.strictEqual(dailyVolumes.size, 0);
});

ta('la valeur rendue compte les logs RECUS, pas les logs RETENUS — ecart assume', async () => {
  /* `return logs?.length || 0` compte ce que le RPC a livre, y compris ce que la boucle a saute. Un
   * appelant qui lit « 4 » croit a 4 transferts comptes alors qu un seul l a ete. On epingle le
   * comportement REEL plutot que celui qu on aurait souhaite: un test qui affirme l intention et non le
   * code laisse passer la difference exacte qu il pretend couvrir. */
  resetDailyVolumes();
  const { f } = rpcAvec([
    { address: USDC_BASE, topics: [TRANSFER_TOPIC], data: '0x1' },
    { address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', topics: [TRANSFER_TOPIC, topicAddr(AUTRE), topicAddr(PAYEE)], data: dataUsd(9) },
    null,
    log(PAYEE, 1500),
  ]);
  const n = await scanTransfers({ fromBlock: '0x1', toBlock: '0x2', fetchImpl: f });
  assert.strictEqual(n, 4, 'quatre logs livres');
  assert.strictEqual(getActivePayees().length, 1, 'un seul retenu — le chiffre rendu ne dit pas ca');
});

(async () => {
  for (const [nom, fn] of files) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  /* Le bilan au format que `npm run test:total` sait lire, imprime APRES la derniere assertion. Il porte
   * le nombre de cas EXECUTES: c'est ce chiffre, et non « 0 failed », qui distingue « verifie » de
   * « jamais atteint ». */
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  /* Un ecart entre cas empiles et cas deroules voudrait dire qu'on est sorti de la boucle en cours de
   * route — le bilan serait alors vrai sur ce qu'il a vu et faux sur ce qu'il pretend couvrir. */
  if (pass + fail !== files.length) {
    console.log('✗ ' + files.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
