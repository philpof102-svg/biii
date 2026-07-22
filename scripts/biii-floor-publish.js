#!/usr/bin/env node
'use strict';
/**
 * biii-floor-publish — package the known-bad FLOOR into a publishable, self-verifying artifact and print
 * the gitlawb command to publish it. The point (Phil's decentralization question, closed): the shared
 * truth-data lives on a SOVEREIGN substrate (gitlawb, DID-signed, cross-relay) so every node pulls it +
 * re-verifies by hash — NOBODY depends on a central operator. This script builds the artifact and stops;
 * the actual `gl` publish is a HUMAN gesture (gitlawb registration needs an iCaptcha — never scripted).
 *
 *   node scripts/biii-floor-publish.js            # writes dist/floor/ + prints the gl command
 *
 * A consumer node then: fetch floor-artifact.json → screen.verifyFloor(it) → adopt ONLY if valid.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadScreen, floorFingerprint, floorProvenance, verifyFloor } = require('../lib/screen');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'known-bad.json');
const OUT_DIR = path.join(ROOT, 'dist', 'floor');

function build() {
  if (!fs.existsSync(SRC)) throw new Error('no data/known-bad.json — run scripts/biii-known-bad-ingest.js first');
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const screen = loadScreen(data);
  const prov = floorProvenance(screen);
  // the self-verifying artifact: content + its own fingerprint, so a puller checks the hash before trusting.
  const artifact = {
    kind: 'biii-known-bad-floor',
    v: 1,
    fingerprint: prov.fingerprint,
    count: prov.count,
    asOf: prov.asOf,
    sources: prov.sources,
    addresses: [...screen.set].sort(),
    reDerive: prov.reDerive,
    note: prov.note,
  };
  // sanity: the artifact must verify against itself before we ever offer it for publish (fail-closed).
  const check = verifyFloor(artifact);
  if (!check.valid) throw new Error('refusing to publish: artifact does not self-verify — ' + check.reason);
  return artifact;
}

const README = (a) => `# BIII known-bad FLOOR — self-verifying, publicly re-derivable

**Fingerprint:** \`${a.fingerprint}\`
**Count:** ${a.count} addresses · **as of:** ${a.asOf}
**Sources (public, open-licensed):** ${a.sources.join('; ')}

This is the objective known-bad floor a BIII / trust-core node screens against. It is **not an operator's
word**: the sources are public + open-licensed and the fingerprint is a deterministic content hash, so you
adopt it **trustlessly** —

1. Fetch \`floor-artifact.json\`.
2. \`const { verifyFloor } = require('biii/lib/screen'); verifyFloor(artifact)\` — it recomputes the hash over
   the content and refuses if it doesn't match \`fingerprint\`. **Never trust the source; verify the hash.**
3. For the strongest check, re-derive it yourself (\`${a.reDerive}\`) and confirm the same fingerprint.

Two nodes with the same fingerprint judge on the same floor — convergence on public data + a hash, never on
a central node.
`;

function main() {
  const artifact = build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'floor-artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), README(artifact));
  console.log('· floor artifact written → ' + path.relative(ROOT, OUT_DIR));
  console.log('· fingerprint: ' + artifact.fingerprint + '  (' + artifact.count + ' addresses, as of ' + artifact.asOf + ')');
  console.log('· self-verify: PASS (a puller running verifyFloor will accept it)');
  console.log('');
  console.log('To publish on gitlawb (HUMAN gesture — registration needs an iCaptcha, never scripted):');
  console.log('  wsl bash -lc \'export PATH="$(npm config get prefix)/bin:$PATH"; export GITLAWB_NODE=https://node.gitlawb.com; \\');
  console.log('    gl quickstart   # one-time: solves the iCaptcha, registers this DID \\');
  console.log('    && gl mirror <github-url-of-dist/floor> --repo biii-known-bad-floor\'');
  console.log('  (or push dist/floor to a github repo first, then gl mirror it.)');
  return artifact;
}

if (require.main === module) { try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); } }
module.exports = { build, README };
