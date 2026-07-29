'use strict';
/* agent-watch — le surveillant qui dit si un agent GAGNE la capacité de bouger de l'argent.
 *
 * ⚠️ POURQUOI CE FICHIER N'EXISTAIT PAS, ET CE QUE ÇA A COÛTÉ.
 * `hermes/economy/agent-watch.js` n'exportait RIEN: toute sa logique de jugement vivait dans une IIFE
 * lancée au chargement. Aucun test ne pouvait l'atteindre — et un défaut y a vécu jusqu'à représenter
 * 62 % de l'état stocké (49 entrées sur 79 dans data/agent-watch/registry.json au 2026-07-28):
 *
 *   {"verdict":"unreachable","tools":null,"names":null,"movesValue":[],"wantsSecret":[]}
 *
 * `tools` et `names` portaient bien `null` = pas lu. `movesValue` et `wantsSecret` — les deux seuls
 * champs qui portent le propos du surveillant — retombaient à `[]`, c'est-à-dire « vérifié: aucune
 * surface de paiement, aucune demande de clé ». Le verdict disait la vérité et les tableaux la
 * contredisaient DANS LE MÊME OBJET.
 *
 * Run: node test/agent-watch.test.js
 */
const assert = require('node:assert');
const { fingerprint, judgeChange, summarise } = require('../hermes/economy/agent-watch.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const E = { name: 'demo/mcp', url: 'https://demo.example/mcp' };
const surface = ({ moves = [], secret = [] } = {}) => ({
  toolCount: moves.length + secret.length + 1,
  readOnly: ['ping'],
  movesValue: moves.map((name) => ({ name })),
  namedButNoSurface: [],
  wantsSecret: secret.map((name) => ({ name })),
});
const LU_VIDE = fingerprint({ verdict: 'answers', surface: surface() });
const LU_PAIE = fingerprint({ verdict: 'answers', surface: surface({ moves: ['send'] }) });
const LU_CLE = fingerprint({ verdict: 'answers', surface: surface({ secret: ['import_private_key'] }) });
const PAS_LU = fingerprint({ verdict: 'unreachable', surface: null });

console.log('agent-watch — « il n a rien gagné de dangereux » ne doit pas sortir d une porte fermée:');

t('★ une surface NON LUE rend null sur les deux champs qui portent le propos', () => {
  assert.strictEqual(PAS_LU.movesValue, null, '[] se lirait « vérifié: aucune surface de paiement »');
  assert.strictEqual(PAS_LU.wantsSecret, null);
  /* Ces deux-là portaient DÉJÀ la distinction — c est le tell qui a fait trouver le défaut: l auteur
   * connaissait la forme et ne l avait appliquée qu à la moitié des champs. */
  assert.strictEqual(PAS_LU.tools, null);
  assert.strictEqual(PAS_LU.names, null);
});

t('LES DEUX BORNES: une surface LUE ET VIDE reste un tableau vide, pas null', () => {
  assert.deepStrictEqual(LU_VIDE.movesValue, [], 'lu-et-rien est une VRAIE mesure, elle doit rester lisible');
  assert.deepStrictEqual(LU_VIDE.wantsSecret, []);
  assert.strictEqual(typeof LU_VIDE.tools, 'number');
});

t('★ les trois états sont DISTINGUABLES (témoin d instrument)', () => {
  const sig = (f) => JSON.stringify([f.movesValue, f.wantsSecret, f.tools]);
  assert.strictEqual(new Set([sig(PAS_LU), sig(LU_VIDE), sig(LU_PAIE)]).size, 3);
  assert.deepStrictEqual(LU_PAIE.movesValue, ['send'], 'témoin: le cas à signal fort porte vraiment le signal');
});

t('★ une surface non lue est DITE non lue, et n est jamais classée « rien à signaler »', () => {
  const r = judgeChange(undefined, PAS_LU, E);
  assert.strictEqual(r.alerts.length, 0, 'on n accuse pas sur une lecture qui n a pas eu lieu');
  assert.match(r.quiet.join(' '), /NOT read/i);
  assert.match(r.quiet.join(' '), /not a clean read/i, 'le silence doit refuser de se lire comme rassurant');
});

t('★ après un passage NON LU, une surface de paiement retrouvée n est PAS un « ajout »', () => {
  /* C est l alerte fabriquée par notre propre panne: `gainedValue` valait TOUT au premier passage
   * réussi, et on annonçait « X added a payment surface » une semaine après une simple coupure. */
  const r = judgeChange(PAS_LU, LU_PAIE, E);
  assert.strictEqual(r.alerts.length, 0, 'un état n est pas un changement');
  assert.match(r.quiet.join(' '), /state, not a change/i);
});

t('mais une DEMANDE DE CLÉ après un passage non lu alerte quand même — en disant ce qu elle est', () => {
  /* L autre borne: ne rien dire du tout serait pire. On alerte, et on qualifie honnêtement. */
  const r = judgeChange(PAS_LU, LU_CLE, E);
  assert.match(r.alerts.join(' '), /asks for key material/i);
  assert.match(r.alerts.join(' '), /state, not a change/i);
});

t('LES DEUX BORNES: un VRAI ajout, entre deux lectures réussies, alerte toujours', () => {
  /* Le durcissement ne doit pas éteindre le signal qu on est venu chercher. */
  const r = judgeChange(LU_VIDE, LU_PAIE, E);
  assert.match(r.alerts.join(' '), /added a payment surface: send/);
});

t('LES DEUX BORNES: une VRAIE demande de clé nouvelle alerte toujours', () => {
  const r = judgeChange(LU_VIDE, LU_CLE, E);
  assert.match(r.alerts.join(' '), /NOW ASKS FOR KEY MATERIAL/);
});

t('un agent qui répondait et devient muet est signalé', () => {
  const muet = fingerprint({ verdict: 'unreachable', surface: surface() });
  assert.match(judgeChange(LU_VIDE, muet, E).alerts.join(' '), /is dark now/i);
});

t('aucun jugement ne JETTE, quel que soit le couple d états', () => {
  /* Le filet qui aurait attrapé le port cassé de master: chaque combinaison répond sans exception. */
  const etats = [undefined, PAS_LU, LU_VIDE, LU_PAIE, LU_CLE];
  for (const p of etats) for (const n of [PAS_LU, LU_VIDE, LU_PAIE, LU_CLE]) {
    const r = judgeChange(p, n, E);
    assert.ok(Array.isArray(r.alerts) && Array.isArray(r.quiet), 'prev=' + JSON.stringify(p) + ' now=' + JSON.stringify(n));
  }
});

/* ── LA LIGNE DE TITRE — trouvée en LANÇANT le script, pas en le lisant ────────────────────────────
 * Sortie réelle du 2026-07-28 sur deux agents inauditables:
 *   ✓ agent-watch: nothing dangerous appeared in 2 agents this run.
 *     coverage: 79 of 39 registered endpoints
 * Aucun test unitaire ne pouvait voir ça: il fallait exécuter. */
const S = (o) => summarise({ alerts: 0, checked: 2, blind: 0, unread: 0, known: 79, registryThisRun: 39, offset: 33, ...o });

t('★ un agent qui RÉPOND sans qu on ouvre sa surface rend le silence PARTIEL', () => {
  const l = S({ unread: 2 }).join(' ');
  assert.match(l, /PARTIAL/, '« blind » ne comptait que les injoignables: 2 inauditables passaient pour vérifiés');
  assert.match(l, /surface could not be opened/i);
  assert.match(l, /on the 0 surface\(s\) actually opened/, 'le titre doit compter les surfaces OUVERTES, pas les agents visités');
});

t('LES DEUX BORNES: un balayage réellement complet ne porte aucune réserve', () => {
  const l = S({ unread: 0, blind: 0 }).join(' ');
  assert.doesNotMatch(l, /PARTIAL/, 'une réserve permanente apprend à l ignorer');
  assert.match(l, /on the 2 surface\(s\) actually opened/);
});

t('injoignable et inauditable sont comptés SÉPARÉMENT', () => {
  const l = S({ blind: 1, unread: 1 }).join(' ');
  assert.match(l, /1 unreachable/);
  assert.match(l, /1 answered but their surface could not be opened/);
});

t('★ la couverture ne compare plus deux populations différentes', () => {
  const l = S().join(' ');
  assert.doesNotMatch(l, /79 of 39/, 'un ratio > 100 % venait de deux dénominateurs distincts');
  assert.match(l, /79 endpoint\(s\) seen at least once across all runs/);
  assert.match(l, /registry returned 39 this run/);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * listEndpoints — le DENOMINATEUR du recensement, et il pouvait se tronquer en silence.
 *
 * ⚠️ `((j && j.servers) || [])` absorbait l'echec d'une page; `cursor` se calculait ensuite sur le meme
 * `j` nul, valait donc `null`, et la boucle s'ARRETAIT. Un hoquet reseau sur la page 2 rendait la page 1
 * comme si c'etait tout le registre, sans que l'appelant puisse le savoir. Or c'est cette liste qui sert
 * de denominateur au recensement d'auditabilite : un denominateur tronque en silence donne un
 * pourcentage qui a l'air d'un resultat.
 *
 * ⚠️ HARNAIS: le `t()` de ce fichier est SYNCHRONE (`try { fn() }`). Un corps `async` y passerait
 * TOUJOURS, sans rien verifier — le piege deja paye une fois dans ce depot. Les cas asynchrones vivent
 * donc dans ce bloc dedie, qui attend vraiment, compte lui-meme, et decide seul du code de sortie.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const { listEndpoints } = require('../hermes/economy/agent-watch');

const page = (n, cursor) => ({
  servers: Array.from({ length: n }, (_, i) => ({
    server: { name: 'srv-' + cursor + '-' + i, remotes: [{ type: 'http', url: 'https://x' + cursor + '-' + i + '.test/mcp' }] },
  })),
  metadata: cursor ? { nextCursor: cursor } : {},
});

(async () => {
  const ta = async (n, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + n); }
    catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
  };
  console.log('\nlistEndpoints — une page non lue n est pas une page vide:');

  await ta('★ BORNE: deux pages lues rendent TOUS les endpoints, et se declarent completes', async () => {
    let appel = 0;
    const r = await listEndpoints({ get: async () => (++appel === 1 ? page(2, 'c1') : page(2, null)) });
    assert.equal(r.endpoints.length, 4, 'les deux pages doivent etre agregees');
    assert.equal(r.pagesRead, 2);
    assert.equal(r.complete, true, 'aucune page ratee, aucun plafond atteint');
    assert.equal(r.note, null);
  });

  await ta('★ une page qui ne repond pas NE se lit pas comme la fin de la liste', async () => {
    let appel = 0;
    const r = await listEndpoints({ get: async () => (++appel === 1 ? page(2, 'c1') : null) });
    assert.equal(r.endpoints.length, 2, 'la page 1 reste acquise');
    assert.equal(r.pagesFailed, 1, 'et l echec est COMPTE');
    assert.equal(r.complete, false, 'la liste ne peut pas se dire complete');
    assert.match(r.note, /FLOOR/, 'elle doit se declarer plancher, pas total');
  });

  await ta('★ une page a la FORME inattendue compte aussi comme non lue', async () => {
    const r = await listEndpoints({ get: async () => ({ servers: 'pas un tableau' }) });
    assert.equal(r.pagesFailed, 1);
    assert.equal(r.complete, false);
  });

  await ta('★ s arreter au PLAFOND de pages se dit, au lieu de passer pour une fin de liste', async () => {
    const r = await listEndpoints({ get: async () => page(1, 'encore') });  // un curseur a chaque page
    assert.equal(r.hitPageCap, true, 'le registre avait encore des pages');
    assert.equal(r.complete, false);
    assert.match(r.note, /cap/);
  });

  await ta('BORNE: un registre REELLEMENT vide est une reponse, pas un echec', async () => {
    const r = await listEndpoints({ get: async () => ({ servers: [], metadata: {} }) });
    assert.equal(r.endpoints.length, 0);
    assert.equal(r.pagesRead, 1, 'la page a bien ete lue');
    assert.equal(r.pagesFailed, 0);
    assert.equal(r.complete, true, 'lu et vide: c est complet');
  });

  await ta('BORNE: les doublons d URL sont fusionnes entre pages', async () => {
    let appel = 0;
    const meme = { servers: [{ server: { name: 'a', remotes: [{ type: 'http', url: 'https://meme.test/mcp' }] } }], metadata: { nextCursor: 'c' } };
    const r = await listEndpoints({ get: async () => (++appel === 1 ? meme : { ...meme, metadata: {} }) });
    assert.equal(r.endpoints.length, 1, 'la meme URL vue deux fois reste un endpoint');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
