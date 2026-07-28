'use strict';
/* LA BRANCHE QUI N'AVAIT JAMAIS TIRÉ.
 * ===================================
 * `lib/agent-vet.js` dit lui-même, en tête: « `wantsSecret` — la branche qui compte le plus — n'a jamais
 * tiré sur une entrée réelle ». Au 2026-07-28, après 79 endpoints publics recensés, elle affichait 0.
 *
 * Un 0 sorti d'une branche jamais empruntée n'est pas une mesure. Il couvre deux états opposés — « aucun
 * serveur public ne demande de clé » et « le détecteur ne marche pas » — et rien dans le dépôt ne
 * permettait de les distinguer. C'est la règle « sortie constante = l'instrument, pas le sujet »,
 * appliquée à notre propre garde le plus important.
 *
 * Ce fichier monte un VRAI serveur MCP local et fait passer `vetAgent` par le protocole complet
 * (initialize → tools/list → auditTools → verdict). Pas de fixture faite main: le producteur est traversé
 * de bout en bout, parce qu'un test qui FABRIQUE son entrée ne prouve pas qu'elle existe.
 *
 * Run: node test/agent-vet-secret-branch.test.js
 */
const assert = require('node:assert');
const http = require('node:http');
const { vetAgent, auditTools } = require('../lib/agent-vet');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const outil = (name, props, required) => ({ name, description: 'fixture', inputSchema: { type: 'object', properties: props, required } });

/** Un vrai serveur MCP: initialize + tools/list, exactement ce que `introspectHttp` envoie. */
function serveur(tools) {
  const s = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => (b += c));
    q.on('end', () => {
      let m = null; try { m = JSON.parse(b).method; } catch {}
      const result = m === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        : { tools };
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ s, url: 'http://127.0.0.1:' + s.address().port + '/mcp' })));
}

(async () => {
  console.log('agent-vet — la branche « demande du matériel de clé », prouvée de bout en bout:');

  /* ── LE PORT, d'abord: sans lui rien de ce qui suit ne peut tourner ──────────────────────────────
   * `https.request({hostname, path, method})` sans `port` part sur 443. Une URL portant un port
   * explicite était sondée ailleurs, et le verdict rendu décrivait un AUTRE service — un fait attribué
   * au mauvais endpoint est pire qu'une absence de fait. Ce test EST la preuve du correctif: il ne peut
   * pas passer si le port est jeté. */
  await t('★ un endpoint sur un port non standard est bien celui qu on sonde', async () => {
    const { s, url } = await serveur([outil('get_balance', { address: { type: 'string' } })]);
    try {
      const r = await vetAgent({ url });
      assert.notStrictEqual(r.verdict, 'unreachable', 'un port jeté ferait échouer la connexion et se lirait « absent »');
      assert.ok(r.surface, 'la surface doit avoir été lue');
    } finally { s.close(); }
  });

  await t('★ LA BRANCHE TIRE: un outil dont le SCHÉMA demande une clé privée ⇒ refuse', async () => {
    const { s, url } = await serveur([
      outil('get_balance', { address: { type: 'string' } }),
      outil('import_wallet', { private_key: { type: 'string' }, label: { type: 'string' } }, ['private_key']),
    ]);
    try {
      const r = await vetAgent({ url });
      assert.strictEqual(r.verdict, 'refuse', 'c est le verdict le plus dur du module, et il n avait jamais été atteint en vrai');
      assert.strictEqual(r.surface.wantsSecret.length, 1);
      assert.strictEqual(r.surface.wantsSecret[0].name, 'import_wallet');
      assert.match(r.reason, /asks for key material/i);
      assert.match(r.reason, /import_wallet/, 'la raison doit NOMMER l outil: « quelque chose est dangereux » ne se répare pas');
    } finally { s.close(); }
  });

  await t('★ le refus PRIME sur une surface de paiement (l ordre des branches est intentionnel)', async () => {
    const { s, url } = await serveur([
      outil('send_payment', { to: { type: 'string' }, amount: { type: 'number' } }, ['to', 'amount']),
      outil('import_wallet', { seed_phrase: { type: 'string' } }, ['seed_phrase']),
    ]);
    try {
      const r = await vetAgent({ url });
      assert.strictEqual(r.verdict, 'refuse', 'demander la clé est pire qu exposer un paiement: le pire doit gagner');
      assert.strictEqual(r.surface.movesValue.length, 1, 'et le paiement reste rapporté, pas écrasé');
    } finally { s.close(); }
  });

  await t('LES DEUX BORNES: un serveur en lecture seule n est pas accusé', async () => {
    const { s, url } = await serveur([
      outil('get_balance', { address: { type: 'string' } }),
      outil('list_tokens', { chain: { type: 'string' } }),
    ]);
    try {
      const r = await vetAgent({ url });
      assert.notStrictEqual(r.verdict, 'refuse');
      assert.strictEqual(r.surface.wantsSecret.length, 0);
      assert.strictEqual(r.surface.movesValue.length, 0);
    } finally { s.close(); }
  });

  await t('LES DEUX BORNES: un outil de SÉCURITÉ dont le nom parle de seed phrase n est pas accusé', async () => {
    /* Le module explique pourquoi il ne scanne pas les descriptions: son propre fichier parle de « private
     * key » sans en demander, et les bons outils de sécurité aussi. La même prudence doit tenir face à un
     * NOM. Un détecteur de fuite qui se ferait refuser serait un faux positif sur exactement le voisin
     * qu on veut voir exister. */
    const { s, url } = await serveur([outil('scan_text_for_seed_phrase', { text: { type: 'string' } }, ['text'])]);
    try {
      const r = await vetAgent({ url });
      assert.strictEqual(r.surface.wantsSecret.length, 0, 'il prend du TEXTE, pas une clé');
      assert.notStrictEqual(r.verdict, 'refuse');
    } finally { s.close(); }
  });

  /* ── CE QUE LA MESURE A RÉVÉLÉ, et que je n aurais pas vu en lisant ────────────────────────────────
   * Le motif secret n est testé QUE sur les noms de champs du schéma (`fields.join(' ')`), jamais sur le
   * nom de l outil. Un outil qui s appelle `import_private_key` et prend `{ value }` n est donc pas
   * classé `wantsSecret`. Le cas suivant ÉPINGLE le comportement réel plutôt que celui que j espérais:
   * c est un trou connu et borné, pas une régression silencieuse. Le corriger demanderait de distinguer
   * `import_private_key` de `check_private_key_leak` sur le seul nom — décision de conception, pas
   * correctif mécanique, et elle appartient à Phil. */
  await t('TROU CONNU, épinglé: le nom de l outil n est PAS scanné, seul son schéma l est', async () => {
    const s1 = auditTools([outil('import_private_key', { value: { type: 'string' } }, ['value'])]);
    assert.strictEqual(s1.wantsSecret.length, 0, 'comportement RÉEL — si ce cas passe à 1, le trou a été fermé, mets à jour ce test');
    assert.deepStrictEqual(s1.readOnly, ['import_private_key'], 'il atterrit en lecture seule');
    /* Le témoin: le MÊME outil, avec le secret dans le schéma, EST attrapé. Sans ce contrôle, un
     * détecteur totalement mort passerait aussi le cas ci-dessus. */
    const s2 = auditTools([outil('import_private_key', { private_key: { type: 'string' } }, ['private_key'])]);
    assert.strictEqual(s2.wantsSecret.length, 1, 'témoin d instrument: le détecteur est bien vivant');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
