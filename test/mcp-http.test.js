'use strict';
// BIII /mcp — MCP over Streamable HTTP. The SAME dispatch + tools as the stdio bin/biii-mcp.js, served
// over HTTP so any MCP client (openhuman, Claude Desktop, a router) points at the URL with ZERO install.
const http = require('node:http');
const assert = require('node:assert');
const { build } = require('../lib/server');

const M = '0x' + '11'.repeat(20);
function rpc(s, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const a = s.address();
    const r = http.request({ host: '127.0.0.1', port: a.port, method: 'POST', path: '/mcp',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.write(data); r.end();
  });
}
const getStatus = (s, path) => new Promise((resolve) => { const a = s.address(); http.get({ host: '127.0.0.1', port: a.port, path }, (res) => { res.resume(); resolve(res.statusCode); }); });

(async () => {
  console.log('BIII /mcp — MCP over Streamable HTTP (zero-install, same tools as stdio):');
  const s = build({ merchant: M });
  await new Promise((r) => s.listen(0, r));
  let n = 0, f = 0;
  const t = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); n++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); f++; } };

  await t('initialize → serverInfo biii', async () => {
    const r = await rpc(s, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.status, 200); assert.equal(r.body.result.serverInfo.name, 'biii');
    assert.ok(r.body.result.capabilities.tools, 'advertises tools capability');
  });
  await t('tools/list → the till_* toolset', async () => {
    const r = await rpc(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(r.body.result.tools.length >= 10, 'at least 10 tools');
    assert.ok(r.body.result.tools.some((x) => x.name === 'till_vet_asset'), 'vet-asset is exposed');
  });
  await t('tools/call runs a tool (till_floor, offline/deterministic)', async () => {
    const r = await rpc(s, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'till_floor', arguments: {} } });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body.result.content[0].text);
    assert.ok(out && typeof out === 'object', 'a JSON verdict comes back through the content channel');
  });
  await t('a notification (no id) → 202, empty body', async () => {
    const r = await rpc(s, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(r.status, 202); assert.equal(r.body, null);
  });
  await t('GET /mcp → 405 (no server→client SSE offered)', async () => {
    assert.equal(await getStatus(s, '/mcp'), 405);
  });
  await t('a FAILING tool gives a generic error — no raw e.message leak (CWE-209)', async () => {
    /* The CWE-209 property, tested where it actually applies: a tool that EXISTS and throws. Its raw
     * message can carry internal detail — paths, upstream errors, state — and none of that may reach the
     * JSON-RPC reply. The detail belongs in the server log.
     *
     * This assertion used to be made against 'does-not-exist', i.e. the one case where the raw text holds
     * no internal detail at all: 'unknown tool <name>' echoes back the caller's OWN input plus a public
     * fact (tools/list is unauthenticated by design). Enforcing the rule there bought no safety and cost a
     * wrong answer — see the next test. */
    const r = await rpc(s, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'till_create_charge', arguments: {} } });
    assert.ok(r.body.error, 'a JSON-RPC error is returned');
    assert.strictEqual(r.body.error.code, -32000, 'a tool that exists and fails keeps the generic code');
    assert.match(r.body.error.message, /failed/, 'stable category');
    assert.ok(!/at \/|\bError:|node_modules|stack/i.test(r.body.error.message),
      'no path, no stack, no upstream error text in the reply');
  });
  await t('an UNKNOWN tool is -32601, not a failure — measured by a third party before it was fixed', async () => {
    /* On 2026-07-27 the usage counter recorded a call to `__verifymcp_auth_probe_<hex>__`: an external
     * conformance probe asking what this server does with a tool that does not exist. We answered
     * '-32000 tool "…" failed — check arguments', sending the caller to debug parameters for a name that
     * was never implemented. An unknown tool is not a failed one, and the two need different actions:
     * re-read tools/list, versus fix the call. */
    const r = await rpc(s, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'does-not-exist' } });
    assert.ok(r.body.error, 'a JSON-RPC error is returned');
    assert.strictEqual(r.body.error.code, -32601, 'JSON-RPC "method not found", not a generic failure');
    assert.match(r.body.error.message, /does not exist on this server/i, 'it must say the tool is absent');
    assert.match(r.body.error.message, /tools\/list/, 'and point at where the real set is');
    assert.ok(!/check arguments/i.test(r.body.error.message),
      'never send someone to debug arguments for a tool that was never implemented');
  });

  await t('★ un outil qui LÈVE n\'accuse plus l\'appelant — la panne amont et l\'erreur d\'entrée sont indiscernables ici', async () => {
    /* « check arguments » n'est pas vague, c'est une ATTRIBUTION — et elle était fausse la moitié du temps.
     * CWE-209 demande de ne pas divulguer le DÉTAIL interne ; il ne demande pas de désigner un coupable.
     * Mesuré le 2026-07-30, arguments VALIDES et BASE_RPC_URL mort :
     *   TypeError: fetch failed  ->  «tool "till_check_payment" failed — check arguments»
     * Sur l'outil qui répond « ai-je été payé ? », un marchand dont le nœud est tombé s'entendait dire que
     * ses données de paiement étaient fausses. Les deux causes appellent des actions OPPOSÉES : changer la
     * requête, ou réessayer plus tard. Le catch générique ne peut pas les distinguer — donc il ne doit
     * trancher NI dans un sens NI dans l'autre. (Le cas voisin, l'outil inconnu, garde son -32601 : lui,
     * on sait.) */
    /* ⚠️ CE CAS PILOTAIT `arguments: {}` — un RACCOURCI, pas le scénario que son propre commentaire
     * décrit. Depuis que `till_check_payment` valide ses entrées (2026-07-30), `{}` rend un REFUS propre
     * et ne lève plus : le véhicule du test avait disparu, pas son sujet. On le rend fidèle au défaut
     * documenté — ARGUMENTS VALIDES + nœud mort — ce qui est aussi le seul montage où la confusion
     * mesurée peut se produire. Un test dont l'instrument diverge de ce qu'il prétend mesurer finit par
     * garder autre chose que ce qu'on croit. */
    const rpcAvant = process.env.BASE_RPC_URL;
    process.env.BASE_RPC_URL = 'http://127.0.0.1:1';        // port mort: la lecture chaîne LÈVERA
    let r;
    try {
      r = await rpc(s, { jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'till_check_payment', arguments: { to: '0x' + '1'.repeat(40), amountMicro: '1500000' } } });
    } finally {
      if (rpcAvant === undefined) delete process.env.BASE_RPC_URL; else process.env.BASE_RPC_URL = rpcAvant;
    }
    assert.ok(r.body.error, 'un outil qui lève doit rendre une erreur JSON-RPC');
    assert.strictEqual(r.body.error.code, -32000, 'l\'outil EXISTE: -32000, pas -32601');
    assert.ok(!/check arguments/i.test(r.body.error.message),
      'ne jamais attribuer la faute a l\'appelant quand on ne sait pas de quel cote elle est');
    assert.match(r.body.error.message, /may be the arguments OR an upstream/i,
      'les DEUX hypotheses doivent rester ouvertes, sinon on accuse');
    assert.match(r.body.error.message, /server log/i, 'et dire ou vit le detail');
    // CWE-209 tient toujours: rien d'interne ne sort.
    assert.ok(!/\\|\/Users\/|at [A-Za-z]+ \(|TypeError|ECONNREFUSED/.test(r.body.error.message),
      'aucun chemin, aucune trace, aucun texte d\'erreur amont dans la reponse');
  });

  s.close();
  console.log(`\n${n} passed · ${f} failed`);
  if (f) process.exit(1);
})();
