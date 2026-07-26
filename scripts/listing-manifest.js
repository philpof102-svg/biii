#!/usr/bin/env node
'use strict';
/**
 * listing-manifest — the source of truth for any directory listing, GENERATED from a live probe.
 *
 * Why this is a script and not a document: a hand-written listing describes the code you remember, and the code
 * you remember is not what is deployed. Measured today, that gap was real — the hosted BIII endpoint answered
 * with 15 tools while its own repository had 27, because the last twelve were committed and never deployed.
 * Listing it from the repo would have published a true-on-paper, false-at-runtime claim, which is exactly the
 * failure this project spent the day removing from its own tooling.
 *
 * So every number here comes from asking the running server. Nothing is copied from a README, a memory, or a
 * previous listing. A server that does not answer is reported as NOT LISTABLE and no description is emitted for
 * it — refusing to advertise is the only honest option when the thing cannot be reached.
 *
 * It also flags DEPLOY DRIFT: when a local repository is known for an endpoint, the tool count it exposes is
 * compared with the tool count in its source. A drift is not a failure to list, it is a reason to deploy first.
 *
 * Read-only. No network writes, no submissions. It prints what a listing may truthfully say; a human submits.
 */
const path = require('node:path');
const fs = require('node:fs');
const { vetAgent } = require('../lib/agent-vet');

/**
 * Our surfaces. `repo` is optional and only used for the drift check — the endpoint is always the authority,
 * because the endpoint is what a user of a directory listing will actually reach.
 */
const SURFACES = [
  { name: 'MainStreet', url: 'https://avisradar-production.up.railway.app/mcp',
    what: 'Is this address safe to pay? Counterparty judgement from a settlement index, fail-closed.' },
  { name: 'BIII', url: 'https://biii-production.up.railway.app/mcp',
    repo: path.join(__dirname, '..', 'bin', 'biii-mcp.js'),
    what: 'A non-custodial trust register: in-person charges, Web2 invoices and agent payments. Holds no key.' },
  { name: 'LAWBOR node', url: 'https://lawbor-node-production.up.railway.app/mcp',
    what: 'Reputation between bots, conserved and bounded by this node\'s own irrecoverable spend.' },
  { name: 'xsignal', url: 'https://xsignal-production.up.railway.app/mcp',
    what: 'An x402 ingredient service whose intent tool ABSTAINS rather than guessing.' },
  { name: 'fleet-mcp', url: 'https://fleet-mcp-production-56fd.up.railway.app/mcp',
    what: 'The agent fleet surface.' },
  { name: 'RugRace', url: 'https://rugrace-production.up.railway.app/mcp',
    what: 'An honest-rug game, on-chain verifiable.' },
  { name: 'AgentGames', url: 'https://agentgames-production-1c0f.up.railway.app/mcp',
    what: 'MCP-native remixable on-chain games on Base.' },
  { name: 'XMoment', url: 'https://momentmint-production.up.railway.app/mcp',
    what: 'Coin a viral post in one tap.' },
];

/**
 * How many tools a stdio server declares — asked of the MODULE, not of its text.
 *
 * The first version counted `name: '…'` with a regex and reported 28 where the module's own TOOLS array holds
 * 27: it was counting `name: 'biii'`, the server's own name in its serverInfo block, as a tool. That produced a
 * permanent phantom drift of 1 against a correctly deployed endpoint — and a check that is red forever is a
 * check everyone learns to skip, which is the exact failure this file was written to prevent. I had built the
 * thing I spent the day removing.
 *
 * A module that exports its tool list is the authority on its own length, and requiring it cannot miscount. The
 * regex survives only as a fallback for a file that exports nothing.
 */
function toolsInSource(file) {
  try {
    const m = require(path.resolve(file));
    if (m && Array.isArray(m.TOOLS)) return m.TOOLS.length;
  } catch { /* not requireable, or exports no TOOLS: fall through to the text scan */ }
  try {
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/\{\s*name:\s*'([a-z0-9_]+)'/gi)) names.add(m[1]);
    return names.size || null;
  } catch { return null; }
}

/**
 * Does every npm package a server.json DECLARES actually exist?
 *
 * Added because one of ours did not. `biii/server.json` declared `biii-mcp@0.1.0` and registry.npmjs.org returns
 * 404 for it — submitted as written, the registry entry would have pointed at nothing, and every reader who ran
 * the suggested `npx biii-mcp` would have hit the same wall. A manifest can be schema-valid and still describe
 * software that cannot be installed.
 *
 * Fixing the one instance was not enough: the check belongs here so the next phantom is caught by a machine
 * rather than by someone noticing. It resolves the name against the real registry — the one place that can
 * answer — and never against a memory of what was published.
 */
function npmExists(name) {
  return new Promise((resolve) => {
    require('node:https').get('https://registry.npmjs.org/' + encodeURIComponent(name), (res) => {
      res.resume();
      resolve({ name, ok: res.statusCode === 200, status: res.statusCode });
    }).on('error', (e) => resolve({ name, ok: false, status: e.message }));
  });
}

/** Read every package identifier declared across our server.json manifests. */
function declaredPackages(root) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const d of dirs) {
    const f = path.join(root, d, 'server.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const p of (j.packages || [])) {
      if (p.registryType === 'npm' && p.identifier) out.push({ repo: d, manifest: j.name, pkg: p.identifier, version: p.version || null });
    }
  }
  return out;
}

(async () => {
  const rows = [];
  for (const s of SURFACES) {
    let r = null;
    try { r = await vetAgent({ url: s.url }); } catch (e) { r = { verdict: 'unreachable', reason: e.message }; }
    const live = (r.surface && r.surface.toolCount) || 0;
    const inRepo = s.repo ? toolsInSource(s.repo) : null;
    rows.push({
      name: s.name, url: s.url, what: s.what,
      verdict: r.verdict, liveTools: live,
      repoTools: inRepo,
      drift: inRepo != null && live > 0 && inRepo !== live ? inRepo - live : 0,
      listable: r.verdict !== 'unreachable' && live > 0,
      // Carried through so a listing never quietly omits it: a surface that can move value must say so.
      paymentSurface: r.surface && r.surface.movesValue ? r.surface.movesValue.map((x) => x.name) : [],
      gatedPayment: r.gatedPayment || null,
    });
  }

  const listable = rows.filter((x) => x.listable);
  const drifted = rows.filter((x) => x.drift !== 0);

  console.log('MCP LISTING MANIFEST — every number below was measured just now, not remembered.\n');
  for (const x of rows) {
    console.log((x.listable ? '  LISTABLE  ' : '  NOT LISTABLE  ') + x.name);
    console.log('      ' + x.url);
    console.log('      ' + x.liveTools + ' tools live · verdict ' + x.verdict +
      (x.repoTools != null ? ' · ' + x.repoTools + ' in source' : ''));
    if (x.drift > 0) console.log('      ⚠️ DEPLOY DRIFT: source has ' + x.drift + ' more tool(s) than the endpoint serves. Deploy before listing, or the listing describes code nobody can reach.');
    if (x.drift < 0) console.log('      ⚠️ DRIFT: the endpoint serves ' + (-x.drift) + ' more than this source file declares — the deployed build is not this file.');
    if (x.paymentSurface.length) console.log('      ⚠️ payment surface an agent can fire alone: ' + x.paymentSurface.join(', '));
    if (x.gatedPayment) for (const g of x.gatedPayment) console.log('      · ' + g);
    if (x.listable) console.log('      "' + x.what + '"');
    console.log('');
  }

  // Phantom packages: schema-valid manifests describing software nobody can install.
  const declared = declaredPackages(path.join(__dirname, '..', '..'));
  const checked = await Promise.all(declared.map((d) => npmExists(d.pkg)));
  const phantoms = declared.filter((d, i) => !checked[i].ok);
  if (declared.length) {
    console.log('DECLARED NPM PACKAGES (resolved against registry.npmjs.org, not remembered)');
    for (const [i, d] of declared.entries()) {
      console.log('  ' + (checked[i].ok ? 'EXISTS  ' : 'PHANTOM ') + d.pkg.padEnd(24) + ' declared by ' + d.repo + '/server.json' +
        (checked[i].ok ? '' : '   <-- HTTP ' + checked[i].status + ': this manifest points at nothing'));
    }
    console.log('');
  }

  console.log('SUMMARY');
  console.log('  listable now      : ' + listable.length + '/' + rows.length);
  console.log('  blocked by drift  : ' + drifted.length + (drifted.length ? '  (' + drifted.map((d) => d.name).join(', ') + ')' : ''));
  console.log('  phantom packages  : ' + phantoms.length + (phantoms.length ? '  (' + phantoms.map((p) => p.pkg).join(', ') + ')' : ''));
  console.log('  total live tools  : ' + listable.reduce((a, b) => a + b.liveTools, 0));
  console.log('');
  console.log('  A listing may state ONLY the live numbers above. If a directory asks for a tool count, use');
  console.log('  liveTools — not the repo count, and not the README. Re-run this before every submission.');
  // Non-zero on EITHER fault, so a submission script stops. Drift means deploy first; a phantom package means
  // publish first or drop the claim. Both produce a listing that is true on paper and false in practice.
  process.exit(drifted.length || phantoms.length ? 2 : 0);
})();
