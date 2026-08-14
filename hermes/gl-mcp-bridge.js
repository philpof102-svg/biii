#!/usr/bin/env node
'use strict';
/**
 * gl-mcp-bridge — stdio framing adapter for `gl mcp serve`.
 * ========================================================
 * `gl mcp serve` (gitlawb CLI ≥0.6.0) frames MCP messages LSP-style (`Content-Length:` headers).
 * The MCP stdio STANDARD — spoken by Hermes, Claude Code, Claude Desktop and the official SDKs — is
 * newline-delimited JSON. Point a client's stdio MCP server at THIS script instead of `gl` directly:
 *
 *   mcp_servers.gitlawb.command: node
 *   mcp_servers.gitlawb.args: [ /abs/gl-mcp-bridge.js ]
 *   mcp_servers.gitlawb.env: { GITLAWB_NODE: https://node.gitlawb.com, GL_BIN: /usr/local/bin/gl }
 *
 * It spawns `gl mcp serve`, translates newline-delimited (client) → Content-Length (gl) on the way in,
 * and Content-Length (gl) → newline-delimited (client) on the way out. stderr passes through.
 */
const { spawn } = require('node:child_process');
const os = require('node:os');

const GL_BIN = process.env.GL_BIN || 'gl';

/**
 * Le code de sortie que le pont rend a son superviseur.
 *
 * ⛔ C'ETAIT `code == null ? 0 : code`. Or `code` vaut null EXACTEMENT quand l'enfant a ete tue par
 * un SIGNAL (le nom est alors dans `signal`) — donc une mort violente de `gl` etait rapportee comme
 * une fin NORMALE. Un superviseur qui lit 0 conclut que le serveur MCP s'est arrete proprement.
 *
 * ⚖️ NON MESURE SUR CETTE PLATEFORME, et il faut le dire: sur win32, un enfant tue rend
 * `code=1, signal=null` (mesure du 2026-08-15), donc la branche n'y est jamais prise. Elle l'est sur
 * POSIX — la ou Hermes tourne. Le correctif est un raisonnement, pas une reproduction.
 */
function exitCodeFor(code, signal) {
  if (code != null) return code;
  if (signal) return 128 + (os.constants.signals[signal] || 0);   // convention shell: 128 + N
  return 1;                                                       // ni code ni signal ⇒ pas un succes
}

function main() {
  /* ⛔ `spawn` ne se contente pas d'EMETTRE `error`: sur Windows il LEVE de facon synchrone quand la
   * cible est un `.cmd` (mitigation CVE-2024-27980), et le handler ci-dessous ne voyait jamais rien.
   * Mesure du 2026-08-15: `GL_BIN` pointant un `.cmd` produisait une stack trace Node brute et un
   * exit 1, au lieu du 127 et du message que ce fichier a prevus. Or le shim npm d'un CLI s'appelle
   * `gl.cmd` sur Windows — c'est le chemin qu'un utilisateur configure naturellement. */
  let gl;
  try {
    gl = spawn(GL_BIN, ['mcp', 'serve'], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (e) {
    process.stderr.write('gl-mcp-bridge: cannot spawn gl (' + GL_BIN + '): ' + e.message + '\n');
    process.exit(127);
    return;
  }
  gl.on('error', (e) => { process.stderr.write('gl-mcp-bridge: cannot spawn gl: ' + e.message + '\n'); process.exit(127); });
  gl.on('exit', (code, signal) => {
    if (code == null && signal) {
      process.stderr.write('gl-mcp-bridge: gl was killed by ' + signal + ' — reporting failure, not a clean exit\n');
    }
    process.exit(exitCodeFor(code, signal));
  });

// ── client (newline-delimited) → gl (Content-Length) ──
let inBuf = '';
process.stdin.on('data', (chunk) => {
  inBuf += chunk.toString('utf8');
  let nl;
  while ((nl = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, nl).trim();
    inBuf = inBuf.slice(nl + 1);
    if (!line) continue;
    const body = Buffer.from(line, 'utf8');
    gl.stdin.write('Content-Length: ' + body.length + '\r\n\r\n');
    gl.stdin.write(body);
  }
});
process.stdin.on('end', () => { try { gl.stdin.end(); } catch { /* already closed */ } });

// ── gl (Content-Length) → client (newline-delimited) ──
let outBuf = Buffer.alloc(0);
gl.stdout.on('data', (chunk) => {
  outBuf = Buffer.concat([outBuf, chunk]);
  for (;;) {
    const headerEnd = outBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = outBuf.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { outBuf = outBuf.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (outBuf.length < start + len) break;                 // body not fully arrived yet
    const body = outBuf.slice(start, start + len).toString('utf8');
    outBuf = outBuf.slice(start + len);
    let line;
    try { line = JSON.stringify(JSON.parse(body)); }        // guarantee single-line, no embedded newlines
    catch { line = body.replace(/\r?\n/g, ' '); }
    process.stdout.write(line + '\n');
  }
});
}

/* Le cablage ne demarre que si ce fichier est LANCE. Sans cette garde, un simple `require` pour
 * tester `exitCodeFor` lancerait `gl mcp serve` — un test ne doit pas parler a gitlawb. */
if (require.main === module) main();

module.exports = { exitCodeFor };
