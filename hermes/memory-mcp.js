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
 *
 * NOTE: wire this under a Hermes toolset key that is NOT "memory" — Hermes ships a built-in `memory`
 * toolset (add/replace/remove) that shadows an MCP server of the same key, so `-t memory` silently
 * selects the built-in and our search/read/index never appear. We register it as `recall`.
 */
const readline = require('node:readline');
const fs = require('node:fs'), path = require('node:path');

const ROOTS = (process.env.MEMORY_ROOTS
  ? process.env.MEMORY_ROOTS.split(':')
  : ['/mnt/d/memoire claude obsidian', '/mnt/c/Users/VolKov/.claude/projects/D--Users-VolKov-veilleIA-mainstreet/memory']
/* realpath des le depart: le verrou compare des chemins REELS, donc les racines doivent l'etre aussi,
 * sinon une racine atteinte via un lien ne correspondrait jamais a ce qu'on resout plus bas. */
).map((r) => { try { return fs.realpathSync(path.resolve(r)); } catch { return path.resolve(r); } })
 .filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });

/* ⚠️ Le separateur. Cette liste ne connaissait que « / », donc sur une racine Windows elle ne
 * filtrait RIEN. Mesure du 2026-08-15: `D:\...\.git\note.md` n'etait pas ignore. Le cout observe est
 * nul sur les donnees actuelles — 0 fichier .md dans .git/.obsidian/.trash du vault, et 0 dans le
 * node_modules d'un projet — donc ce n'est pas un incident, c'est un filtre qui ne filtre pas et
 * qu'on ne verrait qu'une fois une racine posee sur un arbre qui en contient. */
const SKIP = /(^|[\\/])(\.git|node_modules|\.obsidian|\.trash)([\\/]|$)/;
const PLAFOND_NOTES = 4000;
function mdFiles(max = PLAFOND_NOTES) {
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
/**
 * path-lock: only inside a configured root — et sur le FICHIER, pas sur le nom.
 *
 * ⛔ CE VERROU ETAIT LEXICAL. `path.resolve` ne suit aucun lien, donc il bornait la CHAINE et pas ce
 * qui serait reellement lu. Mesure du 2026-08-15, sur une racine bidon du scratchpad:
 *   note legitime dans la racine        -> lue          (temoin)
 *   chemin franchement hors racine      -> REFUSE       (temoin)
 *   lien SYMBOLIQUE dans la racine      -> LU           <<< le contenu hors racine est ressorti
 *   lien DUR dans la racine             -> LU
 * et `memory_search` a trouve le contenu hors racine (le lien dur est un fichier ordinaire pour le
 * parcours; le lien symbolique, lui, n'est pas indexe car `isFile()` est faux).
 *
 * Le vecteur realiste n'est pas exotique: le vault est un depot git qui se SYNCHRONISE, et git
 * transporte les liens symboliques dans un commit. Ce serveur est monte pour qu'un agent local
 * RAPPELLE de la memoire — il lit ce qu'on lui nomme.
 *
 * ⚖️ CE QUE CE CORRECTIF NE FERME PAS, et il faut le nommer: un LIEN DUR n'a pas de cible a resoudre
 * — c'est un second nom du meme fichier, et `realpath` rend ce nom-la. Le distinguer du fichier
 * lui-meme n'est pas possible par le chemin. Ce qui est ferme, c'est le lien symbolique.
 * ⚖️ Et un chemin INEXISTANT est desormais refuse plutot que lu puis rate: un verrou qui ne peut pas
 * verifier ou mene un chemin doit refuser.
 */
function safeResolve(rel) {
  const p = path.resolve(String(rel || ''));
  let reel;
  try { reel = fs.realpathSync(p); } catch { return null; }
  return ROOTS.some((r) => reel === r || reel.startsWith(r + path.sep)) ? reel : null;
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
    /* `noteCount` est un PLANCHER des qu'on touche le plafond: le parcours s'arrete a
     * PLAFOND_NOTES et rendait ce nombre comme s'il etait le total. Un chiffre borne qui ne dit pas
     * sa borne est le motif que ce depot poursuit partout — on le dit ici. */
    const auPlafond = files.length >= PLAFOND_NOTES;
    return {
      roots: ROOTS,
      noteCount: files.length,
      noteCountIsFloor: auPlafond,
      scanCap: PLAFOND_NOTES,
      index,
      note: 'READ-ONLY. Search with memory_search, read with memory_read.'
        + (auPlafond ? ' ⚠️ Le parcours a atteint son plafond de ' + PLAFOND_NOTES
          + ' notes: noteCount est un PLANCHER et memory_search ne voit pas tout.' : ''),
    };
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
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'recall', version: '0.1.0' } } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(callTool(params.name, params.arguments || {})) }] } });
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });
  } catch (e) { if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } }); }
});

module.exports = { callTool, TOOLS };
