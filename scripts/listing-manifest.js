#!/usr/bin/env node
'use strict';
/**
 * listing-manifest â€” the source of truth for any directory listing, GENERATED from a live probe.
 *
 * Why this is a script and not a document: a hand-written listing describes the code you remember, and the code
 * you remember is not what is deployed. Measured today, that gap was real â€” the hosted BIII endpoint answered
 * with 15 tools while its own repository had 27, because the last twelve were committed and never deployed.
 * Listing it from the repo would have published a true-on-paper, false-at-runtime claim, which is exactly the
 * failure this project spent the day removing from its own tooling.
 *
 * So every number here comes from asking the running server. Nothing is copied from a README, a memory, or a
 * previous listing. A server that does not answer is reported as NOT LISTABLE and no description is emitted for
 * it â€” refusing to advertise is the only honest option when the thing cannot be reached.
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
 * Our surfaces. `repo` is optional and only used for the drift check â€” the endpoint is always the authority,
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
 * How many tools a stdio server declares â€” asked of the MODULE, not of its text.
 *
 * The first version counted `name: 'â€¦'` with a regex and reported 28 where the module's own TOOLS array holds
 * 27: it was counting `name: 'biii'`, the server's own name in its serverInfo block, as a tool. That produced a
 * permanent phantom drift of 1 against a correctly deployed endpoint â€” and a check that is red forever is a
 * check everyone learns to skip, which is the exact failure this file was written to prevent. I had built the
 * thing I spent the day removing.
 *
 * A module that exports its tool list is the authority on its own length, and requiring it cannot miscount. The
 * regex survives only as a fallback for a file that exports nothing.
 */
/* ⚠️ LE DEFAUT QUE CETTE DOCSTRING DIT AVOIR CORRIGE ETAIT TOUJOURS ATTEIGNABLE — par le repli.
 * Mesure du 2026-07-29, meme fichier a 3 outils portant aussi un bloc `serverInfo = { name: … }`:
 *
 *   exporte TOOLS                        -> 3   correct
 *   sans module.exports (repli regex)    -> 4   la regex compte le `name:` de serverInfo
 *   exporte TOOLS mais JETTE au require  -> 4   repli SILENCIEUX vers la regex fautive
 *
 * Le troisieme est le vrai probleme: un fichier qui exporte parfaitement `TOOLS`, mais dont le
 * chargement echoue (dependance absente, effet de bord, erreur dans un module importe), retombait sans
 * un mot sur la methode que ce fichier declare imprecise — et rendait un nombre indiscernable d'un
 * nombre faisant autorite. Ce nombre alimente le controle de DERIVE, et une derive fantome est
 * exactement ce que cet en-tete decrit: « a check that is red forever is a check everyone learns to skip ».
 *
 * Deux corrections, pas une:
 *   - un `require` qui JETTE n'est plus un fichier « sans exports ». C'est un fichier ILLISIBLE, et il
 *     se dit tel quel au lieu d'etre approxime.
 *   - le nombre voyage avec SA METHODE. Un comptage regex reste possible (c'est la seule option pour un
 *     fichier qui n'exporte rien) mais il se declare approximatif, et l'appelant refuse d'en tirer une
 *     accusation de derive.
 */
function toolsInSource(file) {
  let m = null, erreurChargement = null;
  try { m = require(path.resolve(file)); }
  catch (e) { erreurChargement = (e && e.message) || String(e); }

  if (m && Array.isArray(m.TOOLS)) return { count: m.TOOLS.length, method: 'module', exact: true, reason: null };

  if (erreurChargement) {
    return { count: null, method: 'unreadable', exact: false,
      reason: 'the module could not be loaded (' + erreurChargement.slice(0, 120) + '), so its tool count is UNKNOWN — '
        + 'not approximated, because an approximation here would read as a deploy drift that is not there' };
  }
  try {
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const x of src.matchAll(/\{\s*name:\s*'([a-z0-9_]+)'/gi)) names.add(x[1]);
    return { count: names.size || null, method: 'regex', exact: false,
      reason: 'counted by text scan because the module exports no TOOLS — APPROXIMATE: it also matches any '
        + 'other `name:` literal, which is how a phantom drift of 1 was once produced' };
  } catch (e) {
    return { count: null, method: 'unreadable', exact: false, reason: 'the file could not be read: ' + ((e && e.message) || e) };
  }
}

/**
 * Does every npm package a server.json DECLARES actually exist?
 *
 * Added because one of ours did not. `biii/server.json` declared `biii-mcp@0.1.0` and registry.npmjs.org returns
 * 404 for it â€” submitted as written, the registry entry would have pointed at nothing, and every reader who ran
 * the suggested `npx biii-mcp` would have hit the same wall. A manifest can be schema-valid and still describe
 * software that cannot be installed.
 *
 * Fixing the one instance was not enough: the check belongs here so the next phantom is caught by a machine
 * rather than by someone noticing. It resolves the name against the real registry â€” the one place that can
 * answer â€” and never against a memory of what was published.
 */
/* âš ï¸ Â« PAS PUBLIE Â» ET Â« PAS PU VERIFIER Â» RENDAIENT LE MEME `ok:false`. Mesure du 2026-07-29:
 *
 *     paquet publie          -> ok:false? non, ok:true, 200
 *     paquet inexistant      -> ok:false, 404
 *     registre INJOIGNABLE   -> ok:false, "getaddrinfo ENOTFOUND"      <- meme reponse
 *
 * Le consommateur en tirait `PHANTOM â€¦ this manifest points at nothing` â€” une affirmation categorique
 * produite par une panne DNS. Et l'en-tete de la section promet Â« resolved against registry.npmjs.org,
 * not remembered Â», ce qui rend le faux plus credible; la fin du script precise que ces chiffres sont
 * ceux qu'une annonce a le droit de citer. Ce depot s'est deja trompe une fois sur un etat de
 * publication (toshi-companion annonce publie alors qu'il rendait E404) â€” dans l'autre sens.
 *
 * Trois etats, donc. Et un DELAI: sans lui, `Promise.all` plus bas peut attendre indefiniment, ce qui
 * n'est pas un resultat non plus. Seul un 404 signifie Â« ce paquet n'est pas la Â»; un 429 ou un 5xx
 * disent seulement que le registre n'a pas voulu repondre maintenant. */
function npmExists(name, { get = require('node:https').get, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const fini = (state, status) => resolve({ name, state, ok: state === 'published', status });
    const req = get('https://registry.npmjs.org/' + encodeURIComponent(name), { timeout: timeoutMs }, (res) => {
      res.resume();
      const c = res.statusCode;
      fini(c === 200 ? 'published' : c === 404 ? 'absent' : 'unchecked', c);
    });
    req.on('timeout', () => { req.destroy(); fini('unchecked', 'timeout after ' + timeoutMs + 'ms'); });
    req.on('error', (e) => fini('unchecked', e.message));
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

if (require.main === module) (async () => {
  const rows = [];
  for (const s of SURFACES) {
    let r = null;
    try { r = await vetAgent({ url: s.url }); } catch (e) { r = { verdict: 'unreachable', reason: e.message }; }
    const live = (r.surface && r.surface.toolCount) || 0;
    /* Le comptage voyage avec sa methode. Un chiffre APPROXIMATIF ne doit pas fonder une accusation de
     * derive: c'est ainsi qu'on obtient un controle rouge en permanence, que tout le monde apprend a
     * sauter. Il est imprime quand meme — cache, il redeviendrait un angle mort. */
    const source = s.repo ? toolsInSource(s.repo) : null;
    const inRepo = source && source.exact ? source.count : null;
    rows.push({
      name: s.name, url: s.url, what: s.what,
      verdict: r.verdict, liveTools: live,
      repoTools: inRepo,
      sourceCount: source,   // count + method + exact + reason — l'appelant doit pouvoir juger la qualite du chiffre
      drift: inRepo != null && live > 0 && inRepo !== live ? inRepo - live : 0,
      listable: r.verdict !== 'unreachable' && live > 0,
      // Carried through so a listing never quietly omits it: a surface that can move value must say so.
      paymentSurface: r.surface && r.surface.movesValue ? r.surface.movesValue.map((x) => x.name) : [],
      gatedPayment: r.gatedPayment || null,
    });
  }

  const listable = rows.filter((x) => x.listable);
  const drifted = rows.filter((x) => x.drift !== 0);

  console.log('MCP LISTING MANIFEST â€” every number below was measured just now, not remembered.\n');
  for (const x of rows) {
    console.log((x.listable ? '  LISTABLE  ' : '  NOT LISTABLE  ') + x.name);
    console.log('      ' + x.url);
    console.log('      ' + x.liveTools + ' tools live Â· verdict ' + x.verdict +
      (x.repoTools != null ? ' Â· ' + x.repoTools + ' in source' : ''));
    if (x.drift > 0) console.log('      âš ï¸ DEPLOY DRIFT: source has ' + x.drift + ' more tool(s) than the endpoint serves. Deploy before listing, or the listing describes code nobody can reach.');
    if (x.drift < 0) console.log('      âš ï¸ DRIFT: the endpoint serves ' + (-x.drift) + ' more than this source file declares â€” the deployed build is not this file.');
    if (x.paymentSurface.length) console.log('      âš ï¸ payment surface an agent can fire alone: ' + x.paymentSurface.join(', '));
    if (x.gatedPayment) for (const g of x.gatedPayment) console.log('      Â· ' + g);
    /* Un comptage NON EXACT se dit, sans compter comme une derive. Le taire ferait un angle mort;
     * l'appeler « derive » ferait un rouge permanent — les deux fautes que ce fichier combat. */
    if (x.sourceCount && !x.sourceCount.exact) {
      console.log('      i SOURCE COUNT NOT EXACT (' + x.sourceCount.method + '): ' + x.sourceCount.reason);
      console.log('        no drift is claimed here — an approximate count cannot accuse a deployment.');
    }
    if (x.listable) console.log('      "' + x.what + '"');
    console.log('');
  }

  // Phantom packages: schema-valid manifests describing software nobody can install.
  const declared = declaredPackages(path.join(__dirname, '..', '..'));
  const checked = await Promise.all(declared.map((d) => npmExists(d.pkg)));
  /* Un paquet FANTOME est un paquet dont le registre a dit qu'il n'existe pas â€” un 404, rien d'autre.
   * Un paquet non verifie n'en est pas un: le compter la ferait accuser un paquet bien vivant sur une
   * panne reseau. Les deux comptes sont donc separes, et le second se dit. */
  const phantoms = declared.filter((d, i) => checked[i].state === 'absent');
  const unchecked = declared.filter((d, i) => checked[i].state === 'unchecked');
  if (declared.length) {
    console.log('DECLARED NPM PACKAGES (resolved against registry.npmjs.org, not remembered)');
    for (const [i, d] of declared.entries()) {
      const s = checked[i].state;
      const etiq = s === 'published' ? 'EXISTS   ' : s === 'absent' ? 'PHANTOM  ' : 'UNCHECKED';
      const suffixe = s === 'published' ? ''
        : s === 'absent' ? '   <-- HTTP 404: the registry says this manifest points at nothing'
          : '   <-- ' + checked[i].status + ': the registry could not be reached, so NOTHING is known about this package â€” it is not a phantom, it is unverified';
      console.log('  ' + etiq + d.pkg.padEnd(24) + ' declared by ' + d.repo + '/server.json' + suffixe);
    }
    console.log('');
  }

  console.log('SUMMARY');
  console.log('  listable now      : ' + listable.length + '/' + rows.length);
  console.log('  blocked by drift  : ' + drifted.length + (drifted.length ? '  (' + drifted.map((d) => d.name).join(', ') + ')' : ''));
  console.log('  phantom packages  : ' + phantoms.length + (phantoms.length ? '  (' + phantoms.map((p) => p.pkg).join(', ') + ')' : ''));
  /* Un zero de fantomes ne vaut que si TOUT a ete verifie. Sans cette ligne, Â« phantom packages: 0 Â»
   * sort identique qu'on ait tout controle ou que le registre ait ete injoignable pour chacun. */
  if (unchecked.length) {
    console.log('  UNCHECKED         : ' + unchecked.length + '  (' + unchecked.map((p) => p.pkg).join(', ') + ')');
    console.log('                      the registry did not answer for these, so the phantom count above is a FLOOR â€” not a clean bill.');
  }
  console.log('  total live tools  : ' + listable.reduce((a, b) => a + b.liveTools, 0));
  console.log('');
  console.log('  A listing may state ONLY the live numbers above. If a directory asks for a tool count, use');
  console.log('  liveTools â€” not the repo count, and not the README. Re-run this before every submission.');
  // Non-zero on EITHER fault, so a submission script stops. Drift means deploy first; a phantom package means
  // publish first or drop the claim. Both produce a listing that is true on paper and false in practice.
  /* âš ï¸ ET UN TROISIEME CODE, POUR LE CAS QUI N'EN AVAIT PAS. Un paquet NON VERIFIE ne doit ni passer pour
   * un fantome (on accuserait un paquet vivant sur une panne reseau) ni pour un succes (on certifierait
   * ce qu'on n'a pas regarde). Ce script existe pour dire ce qu'une annonce a le droit d'affirmer: il ne
   * peut pas certifier ce qu'il n'a pas pu lire. Code distinct, pour que l'appelant sache lequel des deux
   * il regarde â€” un 2 se corrige en publiant, un 3 se corrige en relancant. */
  process.exit(drifted.length || phantoms.length ? 2 : unchecked.length ? 3 : 0);
})();

module.exports = { npmExists, declaredPackages, toolsInSource };
