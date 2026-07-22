#!/usr/bin/env node
'use strict';
/**
 * memory-mcp — a READ-ONLY MCP over our second brain: the Obsidian vault + the mainstreet agent memory.
 * ====================================================================================================
 * So the local Hermes agent can RECALL our persistent memory (what we decided, learned, built) WITHOUT any
 * way to write, move, or corrupt it. Non-destructive by construction: only search / read / index tools,
 * path-locked to the configured roots. Zero deps (node built-ins). Same stdio shape as biii-mcp.
 *
 * Roots via MEMORY_ROOTS (colon-separated dirs); defaults to the Obsidian vault + the mainstreet memory dir.
 */
const readline = require('node:readline');
const fs = require('node:fs'), path = require('node:path');

const ROOTS = (process.env.MEMORY_ROOTS
  ? process.env.MEMORY_ROOTS.split(':')
  : ['/mnt/d/memoire claude obsidian', '/mnt/c/Users/VolKov/.claude/projects/D--Users-VolKov-veilleIA-mainstreet/memory']
).map((r) => path.resolve(r)).filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });

const SKIP = /(^|\/)(\.git|node_modules|\.obsidian|\.trash)(\/|$)/;
function mdFiles(max = 4000) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.md$/i.test(e.name) && out.length < max) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}
function safeResolve(rel) {                                   // path-lock: only inside a configured root
  const p = path.resolve(String(rel || ''));
  return ROOTS.some((r) => p === r || p.startsWith(r + path.sep)) ? p : null;
}

const TOOLS = [
  { name: 'memory_search', description: 'READ-ONLY: search our persistent memory (the Obsidian second-brain vault + the mainstreet agent memory) for a query; returns matching notes with the surrounding line. RECALL what we already know/decided before acting.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'text to find (case-insensitive substring)' }, limit: { type: 'number', description: 'max matches (default 20)' } }, required: ['query'] } },
  { name: 'memory_read', description: 'READ-ONLY: read one memory note by absolute path (must be inside a configured root). Full note after memory_search points you at it.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'absolute path of the .md note (from memory_search)' } }, required: ['file'] } },
  { name: 'memory_index', description: 'READ-ONLY: orient — the roots, the MEMORY.md index if present, and the note count.',
    inputSchema: { type: 'object', properties: {} } },
];

function callTool(name, a = {}) {
  if (name === 'memory_search') {
    const q = String(a.query || '').toLowerCase();
    if (!q) return { error: 'query required' };
    const limit = Math.min(Number(a.limit) || 20, 100);
    const hits = [];
    for (const f of mdFiles()) {
      let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) { hits.push({ file: f, line: i + 1, snippet: lines[i].trim().slice(0, 240) }); if (hits.length >= limit) break; }
      }
      if (hits.length >= limit) break;
    }
    return { query: a.query, matches: hits.length, hits, note: 'READ-ONLY recall from our second brain. Re-read with memory_read for full context.' };
  }
  if (name === 'memory_read') {
    const p = safeResolve(a.file);
    if (!p) return { error: 'path is outside the memory roots — refused (read-only, path-locked)' };
    try { const txt = fs.readFileSync(p, 'utf8'); return { file: p, bytes: txt.length, content: txt.slice(0, 20000) }; }
    catch (e) { return { error: 'read failed: ' + e.message }; }
  }
  if (name === 'memory_index') {
    const files = mdFiles();
    let index = null;
    for (const r of ROOTS) { const mi = path.join(r, 'MEMORY.md'); try { if (fs.statSync(mi).isFile()) { index = fs.readFileSync(mi, 'utf8').slice(0, 8000); break; } } catch { /* no index here */ } }
    return { roots: ROOTS, noteCount: files.length, index, note: 'READ-ONLY. Search with memory_search, read with memory_read.' };
  }
  throw new Error('unknown tool ' + name);
}

// ── minimal stdio MCP (same shape as biii-mcp: newline-delimited JSON-RPC) ──
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return;
  const { id, method, params } = m;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'memory', version: '0.1.0' } } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(callTool(params.name, params.arguments || {})) }] } });
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });
  } catch (e) { if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } }); }
});

module.exports = { callTool, TOOLS };
