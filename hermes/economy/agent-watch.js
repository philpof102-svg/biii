'use strict';
/**
 * agent-watch.js — watch the PUBLIC agent surface change, not just measure it once.
 * ================================================================================
 * The one-off survey answered "what do public MCP servers expose today". The more useful question is the one
 * that made the wallet guard worth reading: what CHANGED. A server that has always taken an amount is a
 * standing fact its users already accepted; a server that added a key-requesting tool in an update is an
 * event, and nobody is watching for it. The registry publishes versions, not diffs.
 *
 * It also fixes the survey's real weakness. `wantsSecret` — the branch that matters most — has never fired on
 * live input, and a 30-server sample from one page will probably never meet it. Covering the registry
 * continuously and remembering what each server looked like is how a rare case eventually walks past.
 *
 * ROTATES ON PURPOSE. A slice per run, advancing through the registry, so full coverage accumulates without
 * anyone's endpoint being hit every thirty minutes. Introspection only: initialize and tools/list, exactly
 * what any MCP client sends on connect, and no tool is ever called. Measuring strangers rudely would be its
 * own dishonesty.
 *
 * $0: keyless, no LLM, read-only.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { vetAgent } = require('../../lib/agent-vet');

const STATE = path.join(__dirname, '..', '..', 'data', 'agent-watch', 'registry.json');
const PER_RUN = Number(process.env.AGENT_WATCH_N || 20);   // endpoints introspected per run
const PAGES = Number(process.env.AGENT_WATCH_PAGES || 3);  // registry pages fetched per run
const PACE_MS = 700;

const get = (url) => new Promise((resolve) => {
  https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { servers: {}, offset: 0 }; } };

/** Every distinct HTTP endpoint the registry knows about, deduplicated (it lists each published version). */
async function listEndpoints() {
  const seen = new Map();
  let cursor = null;
  for (let p = 0; p < PAGES; p++) {
    const url = 'https://registry.modelcontextprotocol.io/v0/servers?limit=100' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const j = await get(url);
    for (const e of ((j && j.servers) || [])) {
      const s = e && e.server;
      if (!s) continue;
      const remote = (s.remotes || []).find((r) => /http/i.test(r.type || '') && /^https:\/\//.test(r.url || ''));
      if (remote && !seen.has(remote.url)) seen.set(remote.url, { name: s.name, url: remote.url });
    }
    cursor = j && j.metadata && (j.metadata.nextCursor || j.metadata.next_cursor);
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...seen.values()];
}

/** A stable description of what a server can do, so a change in it is detectable without storing everything. */
function fingerprint(r) {
  const s = r.surface;
  return {
    verdict: r.verdict,
    tools: s ? s.toolCount : null,
    names: s ? [...s.readOnly, ...s.movesValue.map((x) => x.name), ...s.namedButNoSurface.map((x) => x.name),
      ...s.wantsSecret.map((x) => x.name)].sort().join(',') : null,
    movesValue: s ? s.movesValue.map((x) => x.name).sort() : [],
    wantsSecret: s ? s.wantsSecret.map((x) => x.name).sort() : [],
  };
}

(async () => {
  const state = readState();
  const all = await listEndpoints();
  if (!all.length) { console.log('⚠️ agent-watch: the registry did not answer — nothing was checked, which is not the same as nothing changed.'); return; }

  // Rotate: take a slice starting where the last run stopped, wrapping around.
  const start = (state.offset || 0) % all.length;
  const slice = [];
  for (let i = 0; i < Math.min(PER_RUN, all.length); i++) slice.push(all[(start + i) % all.length]);

  const alerts = [], quiet = [];
  let blind = 0;

  for (const e of slice) {
    let r;
    try { r = await vetAgent({ url: e.url }); } catch { r = null; }
    await new Promise((s) => setTimeout(s, PACE_MS));
    if (!r) { blind++; continue; }

    const now = fingerprint(r);
    const prev = state.servers[e.url];

    if (!prev) {
      // New to us. Only worth a line if it carries something a caller should know before connecting.
      if (now.wantsSecret.length) alerts.push('🚨 NEW to the registry and it asks for key material: ' + e.name + ' — ' + now.wantsSecret.join(', ') + '  ' + e.url);
      else if (now.movesValue.length) alerts.push('⚠️  new: ' + e.name + ' exposes a payment surface (' + now.movesValue.join(', ') + ')  ' + e.url);
      else quiet.push('first look: ' + e.name + ' [' + now.verdict + (now.tools != null ? ', ' + now.tools + ' tools' : '') + ']');
    } else {
      // The whole point: a change, not a state.
      if (now.wantsSecret.length && !prev.wantsSecret.length)
        alerts.push('🚨 ' + e.name + ' NOW ASKS FOR KEY MATERIAL (' + now.wantsSecret.join(', ') + ') — it did not before.  ' + e.url);
      const gainedValue = now.movesValue.filter((n) => !(prev.movesValue || []).includes(n));
      if (gainedValue.length)
        alerts.push('⚠️  ' + e.name + ' added a payment surface: ' + gainedValue.join(', ') + '  ' + e.url);
      if (prev.verdict === 'answers' && now.verdict === 'unreachable')
        alerts.push('🕳️ ' + e.name + ' answered before and is dark now.  ' + e.url);
      if (now.names && prev.names && now.names !== prev.names && !gainedValue.length && !now.wantsSecret.length)
        quiet.push(e.name + ' changed its tool set (' + (prev.tools || 0) + ' → ' + (now.tools || 0) + ') with nothing dangerous added');
    }
    state.servers[e.url] = { ...now, name: e.name, lastSeen: new Date().toISOString() };
  }

  state.offset = (start + slice.length) % all.length;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

  const known = Object.keys(state.servers).length;
  console.log(alerts.length
    ? '🚨 agent-watch: ' + alerts.length + ' change(s) worth knowing across ' + slice.length + ' agents checked this run.'
    : '✓ agent-watch: nothing dangerous appeared in ' + slice.length + ' agents this run' + (blind ? ' (' + blind + ' could not be reached, so silence is partial)' : '') + '.');
  for (const a of alerts) console.log('  ' + a);
  console.log('  coverage: ' + known + ' of ' + all.length + ' registered endpoints seen at least once; next run resumes at #' + state.offset);
  for (const q of quiet.slice(0, 6)) console.log('  · ' + q);
})();
