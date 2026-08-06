'use strict';
// handleRpc — the JSON-RPC dispatch shared by BOTH the stdio MCP server and the hosted /mcp HTTP route.
// No test named it before 2026-08-06, which is how the defects below survived on two public surfaces.
// Run: node test/mcp-dispatch.test.js
//
// NOTHING HERE NAMES A REAL TOOL on a reachable path: every tools/call case is refused before callTool
// would touch the network, so no assertion depends on an oracle answering. A test that flickers with the
// network trains everyone to ignore red.
const assert = require('node:assert');
const { handleRpc } = require('../bin/biii-mcp');
let pass = 0, fail = 0;
const t = (n, fn) => { const p = Promise.resolve().then(fn)
  .then(() => { pass++; console.log('  ✓ ' + n); })
  .catch((e) => { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); }); TESTS.push(p); return p; };
const TESTS = [];
const rpc = (m) => handleRpc(m);

// ── the reassuring bound: what worked must keep working ────────────────────────────────────────────
t('initialize still answers with the tools capability', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.strictEqual(r.id, 1);
  assert.deepStrictEqual(r.result.capabilities, { tools: {} });
  assert.strictEqual(r.error, undefined);
});
t('tools/list still answers with the tool set', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.strictEqual(Array.isArray(r.result.tools), true);
  assert.strictEqual(r.result.tools.length > 0, true);
});
t('id: 0 is a real id, not a falsy one', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert.strictEqual(r.id, 0);
  assert.strictEqual(r.result.tools.length > 0, true);
});
t('ping answers with an empty result — required by the spec', async () => {
  // It used to work only by FALLING THROUGH to the catch-all that answered `result: {}` to anything.
  // Refusing unknown methods would have silently broken it, so it is now handled on purpose.
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepStrictEqual(r, { jsonrpc: '2.0', id: 3, result: {} });
});

// ── an unimplemented method is ABSENT, not EMPTY ───────────────────────────────────────────────────
// Measured 2026-08-06 before the fix: prompts/list, resources/list and pure nonsense were ALL answered
// {"jsonrpc":"2.0","id":N,"result":{}} — a success. A client asking what prompts this server offers was
// told "none" when the truth is that prompts were never implemented.
t('an unimplemented method is refused, not answered with an empty success', async () => {
  for (const method of ['prompts/list', 'resources/list', 'completion/complete', 'wharrgarbl']) {
    const r = await rpc({ jsonrpc: '2.0', id: 9, method });
    assert.strictEqual(r.result, undefined, `${method} reported SUCCESS for something never implemented`);
    assert.strictEqual(r.error.code, -32601, `${method} should be Method not found`);
    assert.ok(r.error.message.includes(method), 'the refusal must name the method it refused');
  }
});
t('the refusal says absent, and does not imply the feature is merely empty', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 10, method: 'prompts/list' });
  assert.match(r.error.message, /not implemented|absent/);
  assert.doesNotMatch(JSON.stringify(r), /"result"/, 'a refusal must not also carry a result');
});

// ── tools/call: validate the envelope BEFORE saying anything about a tool ──────────────────────────
// Measured 2026-08-06 before the fix: {method:'tools/call'} with NO params made params.name throw a
// TypeError, which fell to the generic branch and answered
//   -32000  tool "undefined" failed — it exists and was reached
// No name was supplied, so nothing existed and nothing was reached. The branch written to STOP a false
// attribution was making one.
t('tools/call with no params is Invalid params, not a failed tool', async () => {
  for (const m of [{ jsonrpc: '2.0', id: 11, method: 'tools/call' },
                   { jsonrpc: '2.0', id: 12, method: 'tools/call', params: {} },
                   { jsonrpc: '2.0', id: 13, method: 'tools/call', params: 'hi' },
                   { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: '' } },
                   { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 42 } }]) {
    const r = await rpc(m);
    assert.strictEqual(r.error.code, -32602, 'a missing tool name is Invalid params: ' + JSON.stringify(m.params));
  }
});
// ⚠️ One mutation SURVIVES this file and it is not a gap in these cases: loosening the params type check
// to `params || null` changes no outcome, since a primitive's `.name` and an array's `.name` are both
// undefined and the string check refuses them anyway. Diagnosed 2026-08-06 and noted at the source too —
// do not "cover" it with a case that only re-tests the string check.
t('a missing tool name never CLAIMS the tool exists or was reached', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 16, method: 'tools/call' });
  const msg = r.error.message;
  assert.doesNotMatch(msg, /exists and was reached/, 'asserted existence for a tool that was never named');
  assert.doesNotMatch(msg, /check arguments/, 'the retired false attribution came back');
  assert.doesNotMatch(msg, /"undefined"/, 'quoted the absent name back as if it were a tool');
});
t('a tool that genuinely does not exist is still Method not found', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'no_such_tool' } });
  assert.strictEqual(r.error.code, -32601);
  assert.match(r.error.message, /unknown tool "no_such_tool"/);
});

// ── notification vs request: three states, not two ─────────────────────────────────────────────────
// `id == null` flattened "no id member" (a notification) into "id: null" (a legal request). Measured
// before the fix: id:null + tools/list was ANSWERED, id:null + an unknown method was DROPPED — the same
// caller treated as a request or a notification depending on which branch it hit.
t('a notification is never answered, whatever the method', async () => {
  for (const method of ['tools/list', 'initialize', 'ping', 'notifications/initialized', 'wharrgarbl']) {
    assert.strictEqual(await rpc({ jsonrpc: '2.0', method }), null, `answered a notification: ${method}`);
  }
  assert.strictEqual(await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'nope' } }), null);
});
t('a notification NEVER produces a reply carrying no id (invalid JSON-RPC)', async () => {
  const r = await rpc({ jsonrpc: '2.0', method: 'tools/list' });
  assert.strictEqual(r, null, 'a bodied reply with a dropped id went back to a notification');
});
t('id: null is a REQUEST and gets an answer', async () => {
  const ok = await rpc({ jsonrpc: '2.0', id: null, method: 'tools/list' });
  assert.strictEqual(ok.result.tools.length > 0, true);
  const bad = await rpc({ jsonrpc: '2.0', id: null, method: 'wharrgarbl' });
  assert.strictEqual(bad === null, false, 'id:null was silently dropped as if it were a notification');
  assert.strictEqual(bad.error.code, -32601);
});
t('a non-object message yields nothing to send back', async () => {
  for (const m of [null, 'hi', 42, [], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]]) {
    assert.strictEqual(await rpc(m), null, 'non-object should produce no response: ' + JSON.stringify(m));
  }
});

Promise.all(TESTS).then(() => {
  console.log(`\nmcp-dispatch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
