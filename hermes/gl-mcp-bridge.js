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

const GL_BIN = process.env.GL_BIN || 'gl';
const gl = spawn(GL_BIN, ['mcp', 'serve'], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
gl.on('error', (e) => { process.stderr.write('gl-mcp-bridge: cannot spawn gl: ' + e.message + '\n'); process.exit(127); });
gl.on('exit', (code) => process.exit(code == null ? 0 : code));

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
