#!/usr/bin/env node
'use strict';
/**
 * approvals — trois issues, jamais deux.
 *
 * POURQUOI CE FICHIER
 * Couverture V8 du 2026-07-27: 17 % sur lib/approvals.js. C'est l'outil qui repond « quelles portes sont
 * encore ouvertes sur ce wallet », c'est-a-dire le vecteur de siphonnage qui ne demande AUCUNE cle. Et son
 * en-tete raconte deja le bug du premier jet: une reponse vide etait lue comme une allowance de zero, donc
 * l'outil annoncait quarante portes fermees apres en avoir verifie neuf. Un commentaire raconte; il ne
 * rougit pas. Ces tests rougissent.
 *
 * LA REGLE PROTEGEE ICI
 *   null   = la chaine n'a PAS repondu       -> unchecked, et `complete` DOIT tomber a false
 *   0n     = la chaine a repondu zero        -> revoked, la porte est fermee
 *   false  = l'appel a reverte               -> notApplicable, il n'y avait pas de porte
 * Confondre les deux premiers fait declarer un wallet propre pendant une panne RPC. C'est la meme faute
 * fail-open que ce depot passe son temps a trouver chez les autres.
 *
 * ZERO RESEAU: tout passe par la couture `deps`, avec des fixtures.
 */
const assert = require('node:assert');
const A = require('../lib/approvals.js');

let pass = 0, fail = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log('  ok   ' + name); })
  .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); });

const OWNER = '0x' + '1'.repeat(40);
const TOKEN = (n) => '0x' + String(n).repeat(40);
const SPENDER = (n) => '0x' + String(n).repeat(40);
const topicOf = (addr) => '0x' + '0'.repeat(24) + addr.replace(/^0x/, '');

/** Un journal Approval synthetique. Le module n'en tire que des CANDIDATS. */
const logsDe = (paires) => ({ result: paires.map(([token, spender]) => ({ address: token, topics: [A.APPROVAL_TOPIC, topicOf(OWNER), topicOf(spender)] })) });

/** deps par defaut: journal fourni, allowances fournies, aucun reseau, aucune attente. */
function deps({ logs, allowances, solo = () => null, meta = () => null }) {
  return {
    getLogs: async () => logs,
    allowances: async (chain, owner, cands) => cands.map((c, i) => allowances[i]),
    allowanceOne: async () => solo(),
    meta: async (url) => meta(url),
    sleep: async () => {},
  };
}

(async () => {
  console.log('approvals: non-lu, revoque et reverte sont TROIS choses');

  await t('une allowance NON LUE ne compte pas comme une porte fermee', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [null],          // la chaine n'a pas repondu
      solo: () => null,            // le rattrapage solo non plus
    }) });
    assert.equal(r.ok, true);
    assert.equal(r.unchecked, 1, 'doit etre comptee comme non lue');
    assert.equal(r.revoked, 0, 'et surtout PAS comme revoquee');
    assert.equal(r.complete, false, '`complete` doit tomber');
    assert.match(r.note, /INCOMPLETE/, 'la note doit le dire, pas seulement le champ');
  });

  await t('un ZERO confirme est une porte fermee, et le scan reste complet', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [0n],
    }) });
    assert.equal(r.revoked, 1);
    assert.equal(r.unchecked, 0);
    assert.equal(r.complete, true, 'un zero LU est une reponse, le scan est complet');
    assert.equal(r.live.length, 0, 'une porte fermee ne se liste pas');
    assert.doesNotMatch(r.note, /INCOMPLETE/);
  });

  await t('un REVERT est definitif: il n y avait pas de porte', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [false],
    }) });
    assert.equal(r.notApplicable, 1);
    assert.equal(r.revoked, 0, 'un revert n est pas une revocation');
    assert.equal(r.unchecked, 0, 'ni une lecture manquee');
    assert.equal(r.complete, true);
  });

  await t('les trois issues coexistent sans se contaminer', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)], [TOKEN(4), SPENDER(5)], [TOKEN(6), SPENDER(7)], [TOKEN(8), SPENDER(9)]]),
      allowances: [null, 0n, false, 5000n],
      solo: () => null,
    }) });
    assert.equal(r.scanned, 4);
    assert.equal(r.unchecked, 1, 'unchecked');
    assert.equal(r.revoked, 1, 'revoked');
    assert.equal(r.notApplicable, 1, 'notApplicable');
    assert.equal(r.live.length, 1, 'une seule porte reellement ouverte');
    assert.equal(r.complete, false, 'un seul non-lu suffit a rendre le scan incomplet');
  });

  await t('le rattrapage solo peut sauver un null du lot', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [null],
      solo: () => 42n,             // le lot n a pas repondu, l appel individuel si
    }) });
    assert.equal(r.unchecked, 0, 'le rattrapage a repondu, ce n est plus un non-lu');
    assert.equal(r.live.length, 1);
    assert.equal(r.complete, true);
  });

  console.log('\nce qui n est pas une porte');

  await t('une approbation a l ADRESSE ZERO n est pas une porte', async () => {
    // Les tokens de spam en emettent. Les porter jusqu au bout laissait le scan eternellement
    // "un cran sous complet", et un garde qui ne peut jamais dire "tout a ete vu" finit ignore.
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), '0x' + '0'.repeat(40)], [TOKEN(4), SPENDER(5)]]),
      allowances: [0n],
    }) });
    assert.equal(r.scanned, 1, 'un seul candidat: le zero est ecarte avant la verification');
    assert.equal(r.notApplicable, 1, 'compte comme sans objet');
    assert.equal(r.complete, true, 'et n empeche pas le scan d etre complet');
  });

  await t('la meme paire (token, spender) vue deux fois reste UNE porte', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)], [TOKEN(2), SPENDER(3)], [TOKEN(2), SPENDER(3)]]),
      allowances: [7n],
    }) });
    assert.equal(r.scanned, 1, 'le journal est une HISTOIRE: trois evenements, une permission');
  });

  await t('une chaine non cablee refuse au lieu de rendre un resultat vide', async () => {
    const r = await A.checkApprovals('dogecoin', OWNER, {});
    assert.equal(r.ok, false, 'doit refuser explicitement');
    assert.match(r.reason, /not wired/);
  });

  console.log('\nillimite: un cheque en blanc n est pas un gros nombre');

  await t('au-dessus de 10^30 l allowance est dite "unlimited", pas chiffree', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [2n ** 256n - 1n],
      meta: () => ({ symbol: 'USDC', decimals: 6 }),
    }) });
    assert.equal(r.live[0].unlimited, true);
    assert.equal(r.live[0].allowance, 'unlimited', 'afficher 1.15e71 enterrerait le point');
    assert.equal(r.unlimited, 1);
  });

  await t('juste SOUS le seuil reste un montant chiffre', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)]]),
      allowances: [A.EFFECTIVELY_UNLIMITED - 1n],
      meta: () => ({ symbol: 'X', decimals: 0 }),
    }) });
    assert.equal(r.live[0].unlimited, false, 'la borne est stricte: seuil-1 n est pas illimite');
    assert.notEqual(r.live[0].allowance, 'unlimited');
  });

  await t('le pire remonte en premier: illimite avant plafonne, non verifie avant verifie', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({
      logs: logsDe([[TOKEN(2), SPENDER(3)], [TOKEN(4), SPENDER(5)], [TOKEN(6), SPENDER(7)]]),
      allowances: [100n, 2n ** 255n, 200n],
      meta: (url) => (url.includes(SPENDER(7).slice(2)) ? { is_verified: true, name: 'Routeur connu' } : { symbol: 'T', decimals: 0 }),
    }) });
    assert.equal(r.live.length, 3);
    assert.equal(r.live[0].unlimited, true, 'l illimite passe devant');
    // parmi les plafonnes, le NON verifie doit preceder le verifie
    const plafonnes = r.live.slice(1);
    const iVerifie = plafonnes.findIndex((l) => l.spenderVerified);
    if (iVerifie !== -1) assert.equal(iVerifie, plafonnes.length - 1, 'le spender verifie doit finir dernier');
  });

  console.log('\nconstantes: verifiees, pas recitees');

  await t('APPROVAL_TOPIC est bien le topic0 de Approval(address,address,uint256)', async () => {
    const { createHash } = require('node:crypto');
    // keccak256 n est pas dans node:crypto — on verifie donc la FORME et la valeur figee, qui est aussi
    // celle presente dans le tarball publie et dans multicall.js. Une divergence entre les deux se verrait.
    assert.match(A.APPROVAL_TOPIC, /^0x[0-9a-f]{64}$/, 'forme d un topic0');
    assert.equal(A.APPROVAL_TOPIC, '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925');
    assert.notEqual(A.APPROVAL_TOPIC, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      'ce serait le topic de Transfer — les confondre listerait des paiements comme des permissions');
    assert.ok(typeof createHash === 'function');
  });

  await t('le seuil illimite vaut exactement 10^30', async () => {
    assert.equal(A.EFFECTIVELY_UNLIMITED, 10n ** 30n);
  });

  await t('la note dit toujours que l outil ne signe rien', async () => {
    const r = await A.checkApprovals('base', OWNER, { deps: deps({ logs: logsDe([]), allowances: [] }) });
    assert.match(r.note, /never signs/i, 'la posture read-only doit etre dans la sortie, pas seulement dans le README');
    assert.match(r.note, /STATE, not history/i);
  });

  /* ── liveAllowance: QUATRE SIGNIFICATIONS, PAS DEUX ───────────────────────────────────────────────
   * `checkApprovals` trie deja ses candidats sur trois valeurs — null (non verifie), 0n (revoque),
   * false (« rien ici », definitif). Le repli solo, lui, rendait `null` pour TOUT ce qui n'etait pas un
   * nombre: congestion et revert confondus, alors que le commentaire juste au-dessus du `return null`
   * affirmait la distinction (« a revert is a definitive answer, not congestion »).
   *
   * Rien n'etait cache — `unchecked` est plus prudent que `notApplicable` — mais ca DILUE le seul champ
   * qui dit « va regarder toi-meme ». Un lecteur qui voit « 12 non verifiees » dont 9 sont des
   * non-jetons cesse de lire la ligne, et la vraie lecture ratee s'y noie. Un signal bruyant est ignore
   * aussi surement qu'un signal absent.
   *
   * Cette fonction etait EXPORTEE et nommee dans aucun test, parce que `post` utilisait https.request en
   * dur: intestable sans reseau. Le joint `postImpl` est ce qui rend ces cas possibles. */
  const repond = (r) => async () => r;
  const lire = (impl, opts = {}) => A.liveAllowance(opts.chain || 'base', TOKEN(2), OWNER, TOKEN(3),
    { ...opts, postImpl: impl });

  await t('une allowance vivante rend un BigInt, et zero rend 0n (pas null)', async () => {
    assert.strictEqual(await lire(repond({ result: '0x' + '0'.repeat(63) + '5' })), 5n);
    /* ⚠️ strictEqual: `assert.equal(0n, null)` ne PASSE pas, mais `deepEqual([0n],[null])` si — et c'est
     * exactement la distinction a plusieurs etats que porte ce module. */
    assert.strictEqual(await lire(repond({ result: '0x' + '0'.repeat(64) })), 0n);
  });

  await t('un revert et une reponse vide sont DEFINITIFS (false), pas « non verifie »', async () => {
    assert.strictEqual(await lire(repond({ error: { message: 'execution reverted' } })), false);
    /* '0x' = aucune donnee de retour: il n'y a rien a cette adresse. multicall.js le traite deja comme
     * false; le repli solo re-essayait trois fois pour finir par rendre null. */
    assert.strictEqual(await lire(repond({ result: '0x' })), false);
  });

  await t('la congestion et une forme illisible restent NON VERIFIEES (null)', async () => {
    /* Le mot-cle rate/limit/busy/timeout est ce qui distingue « reessaie » de « c'est la reponse ». */
    assert.strictEqual(await lire(repond({ error: { message: 'rate limit exceeded' } }), { attempts: 2 }), null);
    assert.strictEqual(await lire(repond({ result: '0xzz' })), null);
    assert.strictEqual(await lire(repond(null), { attempts: 1 }), null, 'pas de reponse du tout');
    /* Une chaine non cablee n'est pas « rien ici »: on n'a pas regarde. */
    assert.strictEqual(await lire(repond({ result: '0x1' }), { chain: 'chaine-inexistante' }), null);
  });

  await t('les quatre significations sont DISTINCTES deux a deux', async () => {
    const vus = [await lire(repond({ result: '0x' + '0'.repeat(63) + '5' })),
      await lire(repond({ result: '0x' + '0'.repeat(64) })),
      await lire(repond({ result: '0x' })),
      await lire(repond({ result: '0xzz' }))];
    /* Sans ce cas, aplatir deux etats l'un sur l'autre laisserait les trois cas ci-dessus au vert tant
     * qu'ils ne se croisent pas. C'est la garde qui empeche le retour de la confusion. */
    assert.strictEqual(new Set(vus.map((v) => String(typeof v) + ':' + String(v))).size, 4,
      'quatre entrees opposees doivent donner quatre sorties distinguables, pas deux');
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════════
   * UNE QUESTION JAMAIS POSEE RENDUE COMME UNE REPONSE RASSURANTE.
   *
   * Mesure du 2026-07-29 sur le VRAI serveur MCP, `till_open_approvals` appele avec `{}` :
   *   { ok: true, chain: "base", scanned: 2, live: [], revoked: 0 }
   * « on a examine 2 portes, aucune n'est ouverte » — sans proprietaire. Sur l'outil dont le role est
   * de dire quelles portes de VOTRE wallet restent ouvertes, c'est un feu vert sur rien.
   *
   * Le cas vide est pire que l'absent: `pad('')` rend 64 zeros, soit L'ADRESSE ZERO — un wallet reel,
   * dont les approbations seraient presentees comme celles de l'appelant.
   * ══════════════════════════════════════════════════════════════════════════════════════════════ */
  const jamaisAppele = { getLogs: async () => { throw new Error('le reseau ne doit PAS etre touche'); },
    allowances: async () => { throw new Error('idem'); }, allowanceOne: async () => { throw new Error('idem'); },
    meta: async () => ({}), sleep: async () => {} };

  for (const [nom, owner] of [['absent', undefined], ['null', null], ['chaine vide', ''],
    ['espaces', '   '], ['tronque', '0x1234'], ['pas hex', '0x' + 'zz'.repeat(20)]]) {
    await t('★ owner ' + nom + ' : REFUS, et aucune requete brulee', async () => {
      const r = await A.checkApprovals('base', owner, { deps: jamaisAppele });
      assert.strictEqual(r.ok, false, 'ok:true se lirait « verifie »');
      assert.strictEqual(r.rejectedInput, true);
      assert.match(r.reason, /NOTHING WAS LOOKED UP/i, 'le refus doit DIRE que rien n a ete regarde');
      assert.strictEqual(r.live, undefined, 'surtout pas de liste vide a cote d un ok');
    });
  }

  await t('★ le refus mentionne l ADRESSE ZERO — le piege que la chaine vide tend', async () => {
    const r = await A.checkApprovals('base', '', { deps: jamaisAppele });
    assert.match(r.reason, /zero address/i,
      'sans cette phrase, personne ne comprend pourquoi un champ blanc est dangereux ici');
  });

  await t('★ LES DEUX BORNES: une adresse VALIDE passe toujours et rend son rapport', async () => {
    const r = await A.checkApprovals('base', '0x' + '11'.repeat(20), {
      deps: { getLogs: async () => ({ result: [] }), allowances: async () => ({}),
        allowanceOne: async () => null, meta: async () => ({}), sleep: async () => {} } });
    assert.strictEqual(r.ok, true, 'sans cette borne, « tout refuser » passerait les cas ci-dessus');
    assert.strictEqual(r.rejectedInput, undefined);
    assert.strictEqual(r.scanned, 0, 'et un scan REEL qui ne trouve rien reste un resultat');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
