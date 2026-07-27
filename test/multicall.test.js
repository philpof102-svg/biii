#!/usr/bin/env node
'use strict';
/**
 * multicall — the layer UNDER the approval sweep, at 13 % coverage until today.
 *
 * WHY THIS ONE AND NOT ANOTHER
 * `approvals.js` was hardened this morning around one rule: an unanswered allowance is NOT a revoked one.
 * But those tests inject their dependencies, so they never exercised the real batch layer — and the null
 * they rely on is produced HERE. A fail-open in this file would defeat that guard from underneath while
 * every approvals test still passed. That is the shape of composition bug that survives a green suite.
 *
 * The property this file must hold, stated in its own source at the batch loop:
 *   "A failed BATCH yields nulls, never zeros — the caller must be able to tell 'unread' from 'empty'."
 *
 * AND WHY THE DECODER DESERVES REAL SCRUTINY
 * The ABI encoding here is hand-rolled because this codebase takes no dependencies. Its own header records
 * the trap: "the first hand-rolled attempt returned 770 bytes of plausible-looking data, which proves only
 * that the node answered something." A decoder that returns a well-shaped wrong answer is worse than one
 * that throws. So the tests below BUILD spec-correct responses independently and check the decoder reads
 * them back — rather than round-tripping this module's own encoder against itself, which would agree with
 * its own mistakes.
 *
 * No network anywhere.
 */
const assert = require('node:assert');
const { multiCall, allowancesBatch, encodeAggregate3, decodeAggregate3, MULTICALL3 } = require('../lib/multicall.js');

let pass = 0, fail = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log('  ok   ' + name); })
  .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); });

const w = (n) => BigInt(n).toString(16).padStart(64, '0');

/**
 * Construit une reponse aggregate3 CONFORME A LA SPEC ABI, ecrite ici independamment du module teste.
 * Result[] = tableau dynamique de structs dynamiques (bool success, bytes returnData).
 */
function reponseAggregate3(resultats) {
  const structs = resultats.map(({ success, data }) => {
    const d = String(data || '0x').replace(/^0x/, '');
    const octets = d.length / 2;
    return w(success ? 1 : 0) + w(64) + w(octets) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  });
  let curseur = 32 * structs.length;                       // apres la table des offsets
  const offsets = structs.map((s) => { const a = curseur; curseur += s.length / 2; return w(a); });
  return '0x' + w(32) + w(structs.length) + offsets.join('') + structs.join('');
}

const ADDR = '0x' + '11'.repeat(20);
const SPENDER = '0x' + '22'.repeat(20);
const TOKEN = '0x' + '33'.repeat(20);

(async () => {
  console.log('multicall: le decodeur lit une reponse construite selon la SPEC, pas selon son encodeur');

  await t('un lot de trois resultats se relit exactement', async () => {
    const hex = reponseAggregate3([
      { success: true, data: '0x' + w(1000) },
      { success: true, data: '0x' + w(0) },
      { success: false, data: '0x' },
    ]);
    const out = decodeAggregate3(hex, 3);
    assert.ok(out, 'le decodage doit reussir sur une reponse conforme');
    assert.equal(out.length, 3);
    assert.equal(out[0].success, true);
    assert.equal(BigInt(out[0].data), 1000n, 'la valeur doit ressortir intacte');
    assert.equal(BigInt(out[1].data), 0n, 'un ZERO lu est un zero, pas une absence');
    assert.equal(out[2].success, false);
    assert.equal(out[2].data, '0x', 'un revert rend des donnees vides');
  });

  await t("l'ORDRE est preserve — sinon une allowance serait attribuee a la mauvaise paire", async () => {
    /* Le pire bug silencieux possible ici: melanger les reponses. Chaque valeur est distincte pour que
     * toute permutation se voie. */
    const hex = reponseAggregate3([7, 42, 999, 1].map((v) => ({ success: true, data: '0x' + w(v) })));
    const out = decodeAggregate3(hex, 4);
    assert.deepStrictEqual(out.map((r) => Number(BigInt(r.data))), [7, 42, 999, 1]);
  });

  console.log('\nle decodeur REFUSE plutot que de deviner');

  await t('un nombre de resultats different de celui attendu est refuse', async () => {
    /* « Shape mismatch: refuse rather than guess ». Rendre 2 valeurs pour 3 questions et laisser
     * l appelant se debrouiller decalerait toutes les paires. */
    const hex = reponseAggregate3([{ success: true, data: '0x' + w(1) }, { success: true, data: '0x' + w(2) }]);
    assert.equal(decodeAggregate3(hex, 3), null, '2 rendus pour 3 attendus -> null');
    assert.equal(decodeAggregate3(hex, 1), null, '2 rendus pour 1 attendu -> null');
    assert.ok(decodeAggregate3(hex, 2), '2 pour 2 passe');
  });

  await t('une reponse tronquee est refusee, pas interpretee', async () => {
    for (const court of ['0x', '0x00', '0x' + w(32), '0x' + w(32) + w(1).slice(0, 40)]) {
      assert.equal(decodeAggregate3(court, 1), null, JSON.stringify(court.slice(0, 20)));
    }
  });

  await t('un lot VIDE se decode en tableau vide, et pas en null', async () => {
    // Zero question posee est une reponse valide: aucune, pas "illisible".
    const hex = reponseAggregate3([]);
    const out = decodeAggregate3(hex, 0);
    assert.ok(Array.isArray(out) && out.length === 0);
  });

  console.log("\nl'encodeur produit la forme attendue");

  await t('le selecteur et la tete du tableau sont ceux d aggregate3', async () => {
    const cd = encodeAggregate3([{ target: TOKEN, allowFailure: true, callData: '0xdd62ed3e' }]);
    assert.ok(cd.startsWith('0x82ad56cb'), 'selecteur aggregate3');
    const corps = cd.slice(10);
    assert.equal(BigInt('0x' + corps.slice(0, 64)), 32n, 'offset vers le tableau');
    assert.equal(BigInt('0x' + corps.slice(64, 128)), 1n, 'longueur du tableau');
  });

  await t('allowFailure est encode, et le passer a faux se voit dans le calldata', async () => {
    /* Il vaut TRUE en production: un seul appel qui reverte ne doit pas empoisonner ses voisins. Si
     * quelqu un le passait a faux, une paire absurde ferait echouer le lot entier. */
    const vrai = encodeAggregate3([{ target: TOKEN, allowFailure: true, callData: '0x00' }]);
    const faux = encodeAggregate3([{ target: TOKEN, allowFailure: false, callData: '0x00' }]);
    assert.notEqual(vrai, faux, 'le drapeau doit reellement figurer dans l encodage');
  });

  await t('l adresse cible apparait dans le calldata, en minuscules et alignee', async () => {
    const cd = encodeAggregate3([{ target: '0xAbCdEf0123456789012345678901234567890123', allowFailure: true, callData: '0x00' }]);
    assert.ok(cd.toLowerCase().includes('abcdef0123456789012345678901234567890123'), 'la cible doit y etre');
  });

  console.log('\nLA propriete dont depend le fail-closed des approbations');

  await t('une chaine non cablee rend AUTANT DE NULLS que d appels — jamais un tableau vide', async () => {
    /* Si multiCall rendait [] au lieu de [null, null, null], l appelant zipperait des reponses absentes
     * avec ses paires et lirait "aucune allowance" pour toutes. C est exactement le fail-open que le
     * garde des approbations existe pour empecher. */
    const out = await multiCall('dogecoin', [
      { target: TOKEN, callData: '0x00' }, { target: TOKEN, callData: '0x00' }, { target: TOKEN, callData: '0x00' },
    ]);
    assert.equal(out.length, 3, 'la longueur doit correspondre a l entree');
    assert.deepStrictEqual(out, [null, null, null], 'des nulls, jamais des zeros ni un tableau court');
  });

  await t('aucun appel demande rend un tableau vide, sans toucher au reseau', async () => {
    assert.deepStrictEqual(await multiCall('base', []), []);
  });

  console.log('\nallowancesBatch: TROIS sortes de retour, jamais deux');

  await t('BigInt = reponse, null = NON LU, false = revert — et elles ne se confondent pas', async () => {
    /* Replier null et false ensemble « a fait qu un seul evenement Approval bidon gardait tout le
     * balayage sous "complet" » — c est ecrit dans la source du module. */
    const paires = [{ token: TOKEN, spender: SPENDER }];
    const res = await allowancesBatch('dogecoin', ADDR, paires);   // chaine non cablee -> non lu
    assert.deepStrictEqual(res, [null], 'chaine inconnue = NON LU, pas zero, pas false');
  });

  await t('les trois sortes sont distinguables par un appelant (typeof)', async () => {
    /* Un appelant ecrit `if (a === null)` puis `if (a === false)` puis traite le BigInt. Ces trois tests
     * doivent etre mutuellement exclusifs, sinon la logique d approvals se decale. */
    const nonLu = null, reverte = false, reponse = 5n;
    assert.equal(nonLu === null, true);
    assert.equal(reverte === null, false, 'false ne doit pas passer pour null');
    assert.equal(reponse === false, false);
    assert.equal(typeof reponse, 'bigint');
    assert.notEqual(typeof reverte, 'bigint', 'un revert n est pas une valeur');
  });

  await t('★ un appel REUSSI dont la donnee est illisible est NON LU, pas un revert', async () => {
    /* LE QUATRIEME CAS, longtemps range avec le mauvais. `success` vrai et `data` non vide: l appel a
     * abouti, mais son retour ne se decode pas. Ce n est pas un revert — c est une reponse qu on n a pas
     * su lire. L ancienne ligne rendait `false`, c est-a-dire « repondu definitivement: aucune
     * allocation ».
     *
     * La consequence traversait TROIS modules, et c est pour ca qu aucun test ne la voyait:
     *   multicall   : illisible -> false
     *   approvals   : ne compte comme `unchecked` que les null  -> complete: true
     *   wallet-watch: remplace sa reference des que complete    -> l allocation SORT de la memoire
     *   run suivant : « NEW approval … Someone granted it since » sur une allocation jamais lue.
     * La correction de wallet-watch du 2026-07-27 fermait la QUEUE de cette chaine; la tete etait ici,
     * dans le fichier dont l en-tete annonce justement qu un fail-open y « defeat that guard from
     * underneath while every approvals test still passed ». Le motif etait juste, le cas manquait. */
    const map = (r) => {
      if (!r) return null;
      if (!r.success || r.data === '0x') return false;
      try { return BigInt(r.data); } catch { return null; }
    };
    assert.strictEqual(map(null), null, 'pas de reponse = non lu');
    assert.strictEqual(map({ success: false, data: '0x' }), false, 'revert = reponse definitive');
    assert.strictEqual(map({ success: true, data: '0x' }), false, 'retour vide = pas de fonction a lire');
    assert.strictEqual(map({ success: true, data: '0xzz' }), null,
      'succes + donnee illisible = NON LU, surtout pas « pas d allocation »');
    assert.strictEqual(map({ success: true, data: '0x64' }), 100n);
  });

  await t('la source elle-meme applique bien cette regle', async () => {
    /* Le cas ci-dessus reproduit la logique; celui-ci verifie qu elle est bien DANS le module — sinon on
     * teste une copie et le fichier peut deriver sans qu un test rougisse. */
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'multicall.js'), 'utf8');
    assert.match(src, /catch \{ return null; \}/,
      'le catch de decodage doit rendre null (non lu), pas false (revert)');
    assert.ok(!/try \{ return BigInt\(r\.data\); \} catch \{ return false; \}/.test(src),
      'l ancienne forme ne doit pas revenir');
    /* ET LA DIRECTION INVERSE. Ajoute apres une mutation qui ne mordait pas: transformer les VRAIS
     * reverts en « non lu » passait tous les tests. Ce serait une sur-correction couteuse — le balayage
     * ne serait plus JAMAIS complet, wallet-watch ne remplacerait plus jamais sa reference, et une
     * allocation revoquee resterait « connue » pour toujours. Un fail-closed pousse trop loin cesse
     * d informer: il faut que les deux bornes soient tenues, pas seulement celle qui rassure. */
    assert.match(src, /if \(!r\.success \|\| r\.data === '0x'\) return false;/,
      'un revert reel reste une reponse DEFINITIVE (false), sinon le balayage n est jamais complet');
    assert.match(src, /if \(!r\) return null;/, 'aucune reponse reste NON LU');
  });

  await t('zero paire demandee ne fait aucun appel et rend un tableau vide', async () => {
    assert.deepStrictEqual(await allowancesBatch('base', ADDR, []), []);
  });

  console.log('\nla constante qui ancre tout');

  await t('Multicall3 est a son adresse canonique, la meme sur toutes les chaines', async () => {
    assert.equal(MULTICALL3, '0xcA11bde05977b3631167028862bE2a173976CA11');
    assert.match(MULTICALL3, /^0x[0-9a-fA-F]{40}$/);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
