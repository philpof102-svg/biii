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

/** Count tool definitions in a stdio server's source. Crude on purpose — it only has to detect DRIFT. */
function toolsInSource(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/\{\s*name:\s*'([a-z0-9_]+)'/gi)) names.add(m[1]);
    return names.size || null;
  } catch { return null; }
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

  console.log('SUMMARY');
  console.log('  listable now      : ' + listable.length + '/' + rows.length);
  console.log('  blocked by drift  : ' + drifted.length + (drifted.length ? '  (' + drifted.map((d) => d.name).join(', ') + ')' : ''));
  console.log('  total live tools  : ' + listable.reduce((a, b) => a + b.liveTools, 0));
  console.log('');
  console.log('  A listing may state ONLY the live numbers above. If a directory asks for a tool count, use');
  console.log('  liveTools — not the repo count, and not the README. Re-run this before every submission.');
  process.exit(drifted.length ? 2 : 0);   // non-zero on drift: a submission script must stop and deploy first
})();
