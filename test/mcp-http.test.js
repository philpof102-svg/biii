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
  await t('a tools/call error is GENERIC — no raw e.message leak (CWE-209)', async () => {
    const r = await rpc(s, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'does-not-exist' } });
    assert.ok(r.body.error, 'a JSON-RPC error is returned');
    assert.match(r.body.error.message, /failed/, 'stable category');
    assert.ok(!/unknown tool/i.test(r.body.error.message), 'the internal throw text is NOT leaked');
  });

  s.close();
  console.log(`\n${n} passed · ${f} failed`);
  if (f) process.exit(1);
})();
