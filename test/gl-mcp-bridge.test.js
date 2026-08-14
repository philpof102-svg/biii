#!/usr/bin/env node
'use strict';
/**
 * Le pont vers gitlawb doit dire la VERITE a son superviseur — et son propre chemin d'erreur doit
 * etre atteignable.
 * ==============================================================================================
 * `hermes/gl-mcp-bridge.js` traduit le cadrage LSP de `gl mcp serve` vers le stdio MCP standard.
 * Rien ne le testait. Deux defauts, de natures differentes, et le test les separe.
 *
 * ⛔ 1. MESURE ICI. `spawn` ne se contente pas d'EMETTRE `error`: sur Windows il LEVE de facon
 * synchrone quand la cible est un `.cmd` (mitigation CVE-2024-27980). Le `gl.on('error')` du fichier
 * ne voyait donc rien, et le pont mourait sur une stack trace Node brute avec un exit 1 — au lieu du
 * 127 et du message « cannot spawn gl » qu'il a prevus. Ce n'est pas theorique: le shim npm d'un CLI
 * s'appelle `gl.cmd` sur Windows, et c'est le chemin qu'on configure naturellement.
 *
 * 📖 2. LU, NON MESURE SUR CETTE PLATEFORME. La sortie etait `code == null ? 0 : code`. Or `code`
 * vaut null EXACTEMENT quand l'enfant a ete tue par un SIGNAL — donc une mort violente de `gl` etait
 * rapportee comme une fin NORMALE. Mesure du 2026-08-15 sur win32: un enfant tue rend
 * `code=1, signal=null`, donc la branche n'y est JAMAIS prise et je n'ai pas pu la reproduire. Elle
 * l'est sur POSIX, ou tourne Hermes. Le correctif est un raisonnement, et il est ecrit comme tel.
 *
 * ⚖️ BORNES. Aucun `gl` reel n'est lance et rien ne parle a gitlawb: le faux serveur est un fichier
 * nomme `mcp` depose dans un dossier temporaire, avec `GL_BIN=node` — exactement la forme d'appel du
 * pont, `spawn(GL_BIN, ['mcp','serve'])`. Le cas `.cmd` ne se reproduit que sur win32; ailleurs il
 * est SAUTE et le dit.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const ta = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('gl-mcp-bridge — le pont vers gitlawb:');

const { exitCodeFor } = require('../hermes/gl-mcp-bridge.js');
const PONT = path.join(__dirname, '..', 'hermes', 'gl-mcp-bridge.js');

t('★ une mort par SIGNAL n est pas une fin normale', () => {
  assert.notStrictEqual(exitCodeFor(null, 'SIGKILL'), 0,
    'rendre 0 dirait a un superviseur que le serveur MCP s est arrete proprement');
  assert.strictEqual(exitCodeFor(null, 'SIGKILL'), 128 + os.constants.signals.SIGKILL);
  assert.strictEqual(exitCodeFor(null, 'SIGSEGV'), 128 + os.constants.signals.SIGSEGV);
});

t('un code de sortie reel est transmis tel quel', () => {
  /* Cas oppose: sans lui, une fonction qui rendrait TOUJOURS un echec passerait le test precedent. */
  assert.strictEqual(exitCodeFor(0, null), 0, 'une fin normale reste une fin normale');
  assert.strictEqual(exitCodeFor(3, null), 3);
  assert.strictEqual(exitCodeFor(127, null), 127);
});

t('ni code ni signal ⇒ pas un succes', () => {
  assert.notStrictEqual(exitCodeFor(null, null), 0, 'ne pas savoir n est pas reussir');
});

/* ── bout en bout: un faux `gl` qui parle le cadrage Content-Length ──────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-pont-'));
fs.writeFileSync(path.join(TMP, 'mcp'), `
'use strict';
const MODE = process.env.FAUX_GL_MODE || 'echo';
if (MODE.startsWith('exit:')) process.exit(Number(MODE.slice(5)) || 0);
let buf = Buffer.alloc(0);
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const fin = buf.indexOf('\\r\\n\\r\\n');
    if (fin < 0) break;
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, fin).toString('utf8'));
    if (!m) { buf = buf.slice(fin + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < fin + 4 + len) break;
    const corps = buf.slice(fin + 4, fin + 4 + len).toString('utf8');
    buf = buf.slice(fin + 4 + len);
    let recu; try { recu = JSON.parse(corps); } catch { recu = {}; }
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: recu.id, result: { vu: recu.method, octets: len } }), 'utf8');
    process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n');
    process.stdout.write(b);
  }
});
setTimeout(() => {}, 1 << 30);
`);

function lancer(env, action, cwd = TMP) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PONT], {
      cwd, env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c.toString('utf8'); });
    p.stderr.on('data', (c) => { err += c.toString('utf8'); });
    p.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    if (action) action(p);
    setTimeout(() => { try { p.kill(); } catch { /* deja fini */ } }, 8000);
  });
}

(async () => {
  await ta('le cadrage fait l aller-retour, et rend UNE ligne', async () => {
    const r = await lancer({ GL_BIN: process.execPath, FAUX_GL_MODE: 'echo' }, (p) => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      setTimeout(() => { try { p.kill(); } catch { /* deja fini */ } }, 1200);
    });
    assert.ok(r.out, 'le client doit recevoir une reponse — stderr: ' + r.err.slice(0, 120));
    assert.strictEqual(r.out.split('\n').length, 1, 'le stdio MCP standard est delimite par ligne');
    const j = JSON.parse(r.out);
    assert.strictEqual(j.result.vu, 'tools/list');
    assert.strictEqual(j.result.octets, Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), 'utf8'),
      'Content-Length doit etre une longueur en OCTETS, pas en caracteres');
  });

  await ta('le code de sortie de `gl` traverse le pont', async () => {
    assert.strictEqual((await lancer({ GL_BIN: process.execPath, FAUX_GL_MODE: 'exit:3' })).code, 3);
    assert.strictEqual((await lancer({ GL_BIN: process.execPath, FAUX_GL_MODE: 'exit:0' })).code, 0);
  });

  await ta('un GL_BIN introuvable rend 127 avec le message du pont', async () => {
    const r = await lancer({ GL_BIN: 'binaire-qui-n-existe-pas-xyz' });
    assert.strictEqual(r.code, 127);
    assert.match(r.err, /cannot spawn gl/);
  });

  if (process.platform === 'win32') {
    await ta('★ un GL_BIN `.cmd` prend le chemin d erreur du pont, pas une stack trace', async () => {
      const CMD = path.join(TMP, 'faux-gl.cmd');
      fs.writeFileSync(CMD, '@echo off\r\nexit /b 0\r\n');
      const r = await lancer({ GL_BIN: CMD });
      assert.strictEqual(r.code, 127, 'spawn LEVE ici; sans try/catch le pont mourait en exit 1');
      assert.match(r.err, /cannot spawn gl/, 'et le message doit etre le sien, pas une stack Node');
      assert.doesNotMatch(r.err, /at ChildProcess/, 'aucune stack trace ne doit atteindre l utilisateur');
    });
  } else {
    console.log('  ⚠ SAUTE (non compte): le cas `.cmd` ne se reproduit que sur win32.');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* le menage ne decide de rien */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
