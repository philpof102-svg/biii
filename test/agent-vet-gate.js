#!/usr/bin/env node
'use strict';
/**
 * The truth table for the one judgement in `vet_agent` that has an exploitable edge.
 *
 * A payment surface only counts against an agent if the AGENT can fire it. A tool that cannot move a cent
 * without a signature the caller has to produce is the agent-tool equivalent of a contract with ownership
 * renounced: the capability is there and nobody unattended can trigger it. `rugsignals.js` has applied that
 * rule to contracts since the first day of this repo; `vet_agent` did not, and returned `high_risk` on a live
 * endpoint whose tip tool requires an EIP-712 signature. The same principle, missed the second time it was
 * needed.
 *
 * The danger in fixing it is that a loose gate excuses every drainer on earth, so the three rows below marked
 * EVASION are the point of this file. They are attempts to walk through the gate, and they must all fail. No
 * network: these are schemas, and schemas are what the check reads.
 */
const { auditTools } = require('../lib/agent-vet');

const CASES = [
  // The real tool that exposed the false positive. Signature REQUIRED -> gated, must not escalate.
  ['real tool, signature required', 'callerSigned', {
    name: 'lawbor_m10_tip',
    inputSchema: { type: 'object',
      properties: { tipper: {}, tippee: {}, amountUsdcRaw: {}, nonce: {}, signature: {} },
      required: ['tipper', 'tippee', 'amountUsdcRaw', 'nonce', 'signature'] } }],

  // The thing the check exists for: a quantity, a recipient, and nothing standing in the way.
  ['bare drainer, no authorization at all', 'movesValue', {
    name: 'send_funds',
    inputSchema: { type: 'object', properties: { to: {}, amount: {} }, required: ['to', 'amount'] } }],

  // EVASION 1 — a signature field that is accepted but not demanded gates nothing. The tool can be called
  // without it, so the agent can still fire it alone. This is why the gate reads `required`, not `properties`.
  ['EVASION: signature present but optional', 'movesValue', {
    name: 'transfer_tokens',
    inputSchema: { type: 'object', properties: { to: {}, amount: {}, signature: {} }, required: ['to', 'amount'] } }],

  // EVASION 2 — an apiKey authorizes the AGENT, not the caller. It is a standing credential the agent already
  // holds, which is precisely the unattended case. Accepting it would make the gate a rubber stamp.
  ['EVASION: apiKey required (authorizes the agent, not the caller)', 'movesValue', {
    name: 'withdraw_balance',
    inputSchema: { type: 'object', properties: { amount: {}, apiKey: {} }, required: ['amount', 'apiKey'] } }],

  // EVASION 3 — no `required` array whatsoever. Absence of a demand is not a demand.
  ['EVASION: no required array at all', 'movesValue', {
    name: 'pay_invoice',
    inputSchema: { type: 'object', properties: { amount: {}, signature: {} } } }],

  // Regression: a message has a recipient exactly as a payment does. Only a quantity discriminates.
  ['message tool with a recipient is not a payment tool', 'namedButNoSurface', {
    name: 'lawbor_m1_send',
    inputSchema: { type: 'object', properties: { to: {}, body: {} }, required: ['to', 'body'] } }],

  // Regression: key material outranks everything, gate or no gate.
  ['key material still outranks the gate', 'wantsSecret', {
    name: 'import_wallet',
    inputSchema: { type: 'object', properties: { privateKey: {}, signature: {} }, required: ['privateKey', 'signature'] } }],

  // --- the witness category, found the same way: the check flagged a real settlement-recording tool --------

  // The real tool. It records a USDC transfer that already happened, by hash, and its own description says the
  // node moves no funds. A required hash is a backward reference and cannot be broadcast.
  ['real tool, records a settlement by txHash', 'witnessesPayment', {
    name: 'lawbor_settle',
    inputSchema: { type: 'object', properties: { to: {}, jobId: {}, txHash: {}, amountMicro: {} },
      required: ['to', 'jobId', 'txHash', 'amountMicro'] } }],

  // EVASION 4 — an optional hash proves nothing: the tool can be called without it.
  ['EVASION: txHash present but optional', 'movesValue', {
    name: 'settle_payment',
    inputSchema: { type: 'object', properties: { to: {}, amount: {}, txHash: {} }, required: ['to', 'amount'] } }],

  // EVASION 5 — the sharpest one. A raw signed transaction is FORWARD-acting: handing it to a server is how
  // funds move. It must never be read as a witness just because it contains the letters "tx". (It lands in
  // callerSigned, since the caller did sign it — but never in the witness bucket.)
  ['EVASION: signedTx is forward-acting, not a witness', 'callerSigned', {
    name: 'broadcast_transfer',
    inputSchema: { type: 'object', properties: { amount: {}, signedTx: {} }, required: ['amount', 'signedTx'] } }],

  // Both gates present: the signature is the stronger, more specific claim and wins.
  ['signature and txHash together report as caller-signed', 'callerSigned', {
    name: 'settle_signed',
    inputSchema: { type: 'object', properties: { amount: {}, txHash: {}, signature: {} },
      required: ['amount', 'txHash', 'signature'] } }],

  /* ══════════════════════════════════════════════════════════════════════════════════════════════
   * UN NOM QU'ON NE SAIT PAS LIRE N'EST PAS UN NOM LU ET JUGE INOFFENSIF.
   * `tokenize` filtre [^A-Za-z0-9]: un nom non-latin rend [] ou perd sa moitie porteuse de sens, aucun
   * VALUE_VERB ne peut matcher, et l'outil tombait dans `readOnly` — une AFFIRMATION.
   * Mesure du 2026-07-30: 送金 -> [] · перевод -> [] · 送金Amount -> ["amount"] (residu "送金").
   * 送金 signifie litteralement « envoyer de l'argent » et etait classe lecture seule.
   * ══════════════════════════════════════════════════════════════════════════════════════════════ */
  ['★ un nom entierement non-latin est INCLASSABLE, pas lecture seule', 'unclassifiable', {
    name: '送金',
    inputSchema: { type: 'object', properties: { to: {}, amount: {} }, required: ['to', 'amount'] } }],
  ['★ cyrillique aussi — ce n est pas propre au CJK', 'unclassifiable', {
    name: 'перевод',
    inputSchema: { type: 'object', properties: { amount: {} }, required: ['amount'] } }],
  /* Le cas PARTIEL: la moitie latine survit, la moitie porteuse du VERBE est effacee. Il retombait
   * dans readOnly — meme sur-affirmation, juste plus discrete, donc plus dure a contester. */
  ['★ nom PARTIELLEMENT illisible: le verbe a pu etre dans ce qui a saute', 'unclassifiable', {
    name: '送金Amount',
    inputSchema: { type: 'object', properties: { to: {}, amount: {} }, required: ['to', 'amount'] } }],

  /* LES BORNES D'ACCEPTATION — sans elles, « tout marquer inclassable » passerait les trois cas ci-dessus. */
  ['BORNE: un vrai lecture-seule latin RESTE lecture-seule', 'readOnly', {
    name: 'getBalance',
    inputSchema: { type: 'object', properties: { address: {} }, required: ['address'] } }],
  /* ⚠️ ASYMETRIE VOULUE: un verbe TROUVE est une preuve POSITIVE, et elle ne devient pas fausse parce
   * qu'une autre partie du nom est illisible. On ne bascule que sur l'ABSENCE de verbe. */
  ['BORNE: verbe trouve MALGRE un residu illisible -> le classement tient', 'movesValue', {
    name: 'tip_送金',
    inputSchema: { type: 'object', properties: { to: {}, amount: {} }, required: ['to', 'amount'] } }],
  /* Les separateurs usuels ne sont PAS des caracteres effaces: mesure, ils ne laissent aucun residu. */
  ['BORNE: un separateur ordinaire ne declenche rien', 'movesValue', {
    name: 'send_payment',
    inputSchema: { type: 'object', properties: { to: {}, amount: {} }, required: ['to', 'amount'] } }],
  /* ⚠️ LE CROISEMENT DES DEUX BORNES, ajoute apres qu'une mutation a SURVECU.
   * `send_payment` a un separateur mais AUSSI un verbe: il sort avant le test du residu.
   * `getBalance` n'a pas de verbe mais est en camelCase: aucun separateur.
   * Aucune des deux ne pouvait donc detecter « les separateurs comptent comme effaces ».
   * Il fallait leur INTERSECTION: pas de verbe ET un separateur. Deux bornes couvrant chacune une
   * moitie ne couvrent pas leur croisement — c'est la ou les mutations survivent. */
  ['BORNE (croisement): lecture-seule AVEC separateur reste lecture-seule', 'readOnly', {
    name: 'get_balance',
    inputSchema: { type: 'object', properties: { address: {} }, required: ['address'] } }],
];

/* ⚠️ CETTE LISTE ETAIT ECRITE A LA MAIN, ET ELLE A VIEILLI LE JOUR MEME.
 * Six seaux enumeres; `auditTools` en rend sept depuis l'ajout d'`unclassifiable`. Un outil qui y
 * atterrit rendait `undefined` sur le `.find()` ci-dessous, donc un cas ECHOUAIT sans que le message
 * dise pourquoi — et un cas ajoute pour un nouveau seau n'aurait jamais pu passer.
 * C'est la troisieme fois en une journee que le meme motif mord: hermes/economy/agent-watch.js listait
 * quatre seaux sur six (corrige 526f20e), et ce test en listait six sur sept.
 * On DERIVE: les seaux sont les champs-TABLEAU du retour, donc un huitieme sera pris tout seul.
 * L'ordre d'insertion de l'objet est conserve, donc le comportement des cas existants ne bouge pas. */
const bucketDe = (r) => Object.keys(r).find((b) => Array.isArray(r[b]) && r[b].length);
/* `lances` compte les cas REELLEMENT atteints — la mesure qui manquait quand un `process.exit` place
 * trop haut a rendu onze assertions inatteignables ici meme (voir la note plus bas). Le fichier imprimait
 * alors « all cases hold » et sortait 0: rien dans sa sortie ne pouvait reveler qu'il en avait saute la
 * moitie. Un compteur d'echecs seul ne distingue pas « aucun echec » de « aucun test ». */
let failed = 0, lances = 0;
for (const [label, expected, tool] of CASES) {
  const r = auditTools([tool]);
  const got = bucketDe(r);
  const ok = got === expected;
  lances++;
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (!ok) process.stdout.write(`       expected ${expected}, got ${got}\n`);
}
// Counted, not asserted. This line said "the 3 attempts" for two more rows than that, which is the same fault
// the verdict text in agent-vet.js had — a hardcoded summary drifting away from what it summarises.
const evasions = CASES.filter(([label]) => label.startsWith('EVASION')).length;
process.stdout.write('\n' + (failed
  ? `${failed} schema case(s) failed\n`
  : `the ${CASES.length} schema cases hold, including ${evasions} attempts to walk through the gate\n`));

// NO process.exit here. The browser rows below were first appended AFTER an exit that used to sit on this line,
// which made eleven new assertions unreachable while the run printed "all cases hold" and returned 0. A test
// placed after an exit is not a test, and it is indistinguishable from a passing one — the same shape as every
// other false all-clear this repository documents. The single exit lives at the very bottom of the file now.

// ── browser control: a payment surface by COMPOSITION, which no schema declares ────────────────────────────
//
// Added after pointing this checker at a real trending project that hands an agent the user's own Chrome
// profile — "your agent inherits your existing logins, cookies, extensions". Its six tools (snapshot, fill,
// click, wait, navigate, capture) all land in readOnly, correctly, because the two-condition rule requires a
// value VERB before it reads the schema and browser automation has none. The danger is not in a tool; it is in
// what the browser can REACH. An agent that can navigate and click inside a profile holding a wallet extension
// can drive the wallet, and no input schema will ever say so.
//
// The first version of the detector keyed on VERBS and fired on five of six honest tool sets — trading, files,
// database, terminal, CI — because `open` and `execute` are the most generic verbs in software. The rows below
// are those five, kept as the regression they earned. The tell is a PARAMETER: a selector or a coordinate
// exists only to address something rendered. The second version then MISSED our own Chrome MCP, whose action
// tools are named `computer` and `form_input`, because it still required the name to agree — a false negative,
// which on a security check is the worse direction. A DOM field now decides alone.
const { detectBrowserControl } = require('../lib/agent-vet');
const bc = (tools) => !!detectBrowserControl(tools);
const check = (label, got, want) => {
  const ok = got === want;
  lances++;
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (!ok) process.stdout.write(`       expected ${want}, got ${got}\n`);
};

process.stdout.write('\nbrowser control, keyed on schema fields rather than verbs:\n');
check('trading agent is not a browser',
  bc([{ name: 'open_position', inputSchema: { properties: { symbol: {}, size: {} } } },
      { name: 'execute_order', inputSchema: { properties: { orderId: {} } } }]), false);
check('file manager is not a browser',
  bc([{ name: 'open_file', inputSchema: { properties: { path: {} } } },
      { name: 'type_text', inputSchema: { properties: { path: {}, text: {} } } }]), false);
check('database client is not a browser',
  bc([{ name: 'open_connection', inputSchema: { properties: { dsn: {} } } },
      { name: 'execute_query', inputSchema: { properties: { sql: {} } } }]), false);
check('terminal is not a browser',
  bc([{ name: 'open_shell', inputSchema: { properties: { cwd: {} } } },
      { name: 'execute_command', inputSchema: { properties: { cmd: {} } } }]), false);
check('CI runner is not a browser',
  bc([{ name: 'open_pr', inputSchema: { properties: { repo: {} } } },
      { name: 'execute_workflow', inputSchema: { properties: { id: {} } } }]), false);
check('git ref is a branch, not a DOM handle',
  bc([{ name: 'checkout', inputSchema: { properties: { ref: {} } } },
      { name: 'diff', inputSchema: { properties: { ref: {} } } }]), false);

check('in-page tools with no schema at all ARE control',
  bc([{ name: 'snapshot' }, { name: 'fill' }, { name: 'click' }, { name: 'navigate' }]), true);
check('playwright-style names with selectors ARE control',
  bc([{ name: 'browser_navigate', inputSchema: { properties: { url: {} } } },
      { name: 'browser_click', inputSchema: { properties: { selector: {} } } }]), true);
check('a DOM field decides even when the NAME says nothing',
  bc([{ name: 'navigate', inputSchema: { properties: { url: {} } } },
      { name: 'computer', inputSchema: { properties: { ref: {}, coordinate: {} } } }]), true);

check('reading pages without acting is not control',
  bc([{ name: 'get_page_text', inputSchema: { properties: { url: {} } } },
      { name: 'snapshot', inputSchema: { properties: { url: {} } } }]), false);
check('navigating without acting is not control',
  bc([{ name: 'navigate', inputSchema: { properties: { url: {} } } }]), false);

/* ── LE CRIBLE A-T-IL SEULEMENT TOURNE ? ────────────────────────────────────────────────────────────
 * `lib/screen.js` refuse explicitement d'appeler son zero un verdict propre: quand aucune liste n'est
 * chargee il rend `{blocked:false, available:false}` avec la raison « screening UNAVAILABLE, not a clean
 * verdict ». La couche du dessous etait donc prudente — et `vetAgent` aplatissait les deux cas sur le
 * meme `knownBad: false`. Rien dans sa sortie ne disait si le crible avait tourne.
 *
 * Le cas dangereux n'est pas theorique: `vet.loadFloor()` rend `loadScreen(null)` quand
 * `data/known-bad.json` est absent ou corrompu — un objet TRUTHY dont `available` vaut false. C'est
 * exactement ce que le handler MCP passe. Donc au moment precis ou le plancher casse, le verdict devient
 * faussement rassurant, en silence.
 *
 * Les cas passent par vetAgent(), le vrai producteur — pas par des objets fabriques a la main. Trois
 * defauts « lecteur avant ecrivain » ont ete masques cette semaine par des fixtures ecrites a la main,
 * qui prouvent seulement que le lecteur sait lire ce que le test vient d'ecrire.
 *
 * Aucune URL n'est fournie: l'introspection reseau est alors sautee, ce qui garde ces cas hors-ligne et
 * deterministes. On mesure la frontiere screen -> payment, pas le HTTP. */
const { vetAgent } = require('../lib/agent-vet');
const { screenAddress, loadScreen } = require('../lib/screen');
const PAYE = '0x' + '1'.repeat(40);

(async () => {
  process.stdout.write('\nle crible known-bad: quatre etats, pas un booleen:\n');

  const plancherReel = require('../lib/vet').loadFloor();
  const cas = [
    ['crible cable + plancher charge -> clear', 'clear',
      { payTo: PAYE, knownBadScreen: plancherReel, screenFn: screenAddress }],
    /* Le cas de panne: plancher TRUTHY mais vide. Le crible est appele et repond « indisponible ». */
    ['plancher illisible -> unavailable', 'unavailable',
      { payTo: PAYE, knownBadScreen: loadScreen(null), screenFn: screenAddress }],
    ['aucun crible fourni -> not_run', 'not_run', { payTo: PAYE }],
  ];

  for (const [label, attendu, opts] of cas) {
    const r = await vetAgent(opts);
    check(label, r.payment && r.payment.screen, attendu);
  }

  /* Le plancher charge doit VRAIMENT contenir des adresses, sinon le premier cas dit « clear » pour une
   * raison qui n'est pas celle qu'on croit — et la garde se contenterait d'un crible vide. */
  check('le plancher du repo n\'est pas vide', screenAddress(PAYE, plancherReel).available, true);

  /* La disclosure accompagne les DEUX etats non-concluants, et seulement ceux-la: une note qui apparait
   * aussi sur `clear` serait du bruit, et du bruit sur une garde de securite finit desactive. */
  const nonCrible = await vetAgent({ payTo: PAYE });
  const crible = await vetAgent({ payTo: PAYE, knownBadScreen: plancherReel, screenFn: screenAddress });
  check('non-crible: la sortie le DIT', typeof nonCrible.unscreened === 'string', true);
  check('crible: pas de note parasite', crible.unscreened === undefined, true);

  /* ⚠️ Le verdict lui-meme ne bascule PAS. Un beneficiaire non crible n'est pas un mauvais beneficiaire,
   * et refuser ici rendrait vetAgent inutilisable sans plancher — le fail-closed pousse trop loin cesse
   * d'informer. La divulgation remplace le refus; c'est un choix, il est donc epingle. */
  check('non-crible n\'est PAS traite comme known-bad', nonCrible.payment.knownBad, false);

  /* ── UNE LISTE D'OUTILS NON LUE N'EST PAS UNE LISTE VIDE ──────────────────────────────────────────
   *
   * Mesure du 2026-07-28: `tools/list` qui meurt et `tools/list` qui rend `[]` sortaient du MEME verdict
   * 'answers' avec la MEME phrase, octet pour octet — « exposes 0 tool(s). None asks for key material...
   * No tool names a value-moving action at all. » Trois affirmations sur des outils jamais vus.
   *
   * Le transport est stubbe, pas la logique: les cas passent par `vetAgent()`, le vrai producteur, qui
   * fait reellement tourner introspectHttp -> auditTools -> assemblage du verdict. Un objet `{tools:null}`
   * ecrit a la main n'aurait prouve que ma propre capacite a ecrire `null`.
   *
   * ⚠️ Le stub appelle `cb(res)` AVANT d'emettre sur `res`. Premier jet: les evenements partaient d'abord,
   * le consommateur attachait ses listeners apres, et la promesse ne se resolvait jamais — la sonde
   * n'affichait RIEN. Une sortie vide etait l'instrument, pas le sujet. */
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const vraiRequest = https.request;
  const stubTransport = ({ initStatus = 200, listDies = false, tools = [] }) => {
    https.request = (opts, cb) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = (data) => {
        const rpc = JSON.parse(data);
        if (rpc.method === 'tools/list' && listDies) { setImmediate(() => req.emit('error', new Error('socket hang up'))); return; }
        const res = new EventEmitter();
        res.statusCode = rpc.method === 'initialize' ? initStatus : 200;
        setImmediate(() => {
          cb(res);                                    // listeners attaches ICI...
          setImmediate(() => {                        // ... les evenements seulement ensuite
            res.emit('data', rpc.method === 'initialize'
              ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'stub', version: '1' } } })
              : JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }));
            res.emit('end');
          });
        });
      };
      return req;
    };
  };
  const URL_STUB = 'https://stub.invalid/mcp';
  try {
    process.stdout.write('\nsurface non lue vs surface vide — la porte doit DISTINGUER:\n');

    stubTransport({ listDies: true });
    const nonLu = await vetAgent({ url: URL_STUB });
    stubTransport({ tools: [] });
    const vide = await vetAgent({ url: URL_STUB });
    /* Un outil qui n'expose AUCUNE surface de paiement: la liste est lue, non vide, et le verdict passant
     * reste passant. C'est la borne rassurante — sans elle, un fail-closed trop large passerait ce test. */
    stubTransport({ tools: [{ name: 'get_price', description: 'read a price', inputSchema: { properties: { symbol: { type: 'string' } } } }] });
    const lu = await vetAgent({ url: URL_STUB });
    stubTransport({ initStatus: 401 });
    const gate = await vetAgent({ url: URL_STUB });

    check('tools/list mort -> unauditable, PAS le verdict passant', nonLu.verdict, 'unauditable');
    check('liste vide LUE -> reste answers', vide.verdict, 'answers');
    check('liste non vide LUE -> reste answers', lu.verdict, 'answers');
    check('le compte d\'outils lu est reel, pas un zero par defaut', lu.surface.toolCount, 1);

    /* Le coeur du defaut: les deux phrases etaient identiques. Elles doivent maintenant differer. */
    check('non lu et vide ne disent PLUS la meme phrase', nonLu.reason === vide.reason, false);
    check('« exposes 0 tool(s) » ne s\'ecrit que si on a compte', nonLu.reason.includes('exposes 0 tool(s)'), false);
    check('rien n\'affirme sur les outils non lus', nonLu.reason.includes('None asks for key material'), false);
    check('la sortie NOMME la lecture ratee', nonLu.reason.includes('COULD NOT BE READ'), true);
    check('la surface non lue reste null, jamais un objet vide', nonLu.surface, null);
    /* Le cas vide, lui, doit continuer d'AFFIRMER — il a le droit, il a lu. */
    check('la liste vide, elle, affirme legitimement', vide.reason.includes('None asks for key material'), true);

    /* DEUX causes d'`unauditable` (gate 401 / liste illisible) partagent le verdict mais pas la raison:
     * un verdict qui fusionne deux pannes distinctes redevient un signal a variance nulle. */
    check('401 -> unauditable aussi', gate.verdict, 'unauditable');
    check('mais la raison distingue les deux causes', gate.reason === nonLu.reason, false);
  } finally {
    https.request = vraiRequest;
  }

  /* Le bilan porte le NOMBRE de cas atteints, pas seulement le nombre d'echecs: c'est ce chiffre qui aurait
   * signale les onze assertions sautees, et c'est lui que l'agregateur (`npm run test:total`) additionne. */
  process.stdout.write(`\n${lances - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  /* Sans ce filet, une promesse rejetee tuerait le processus AVANT le bilan — et l'agregateur compte les
   * bilans. Un fichier sans bilan doit crier, pas disparaitre. */
  process.stdout.write(`  FAIL harnais async: ${e && e.message}\n`);
  process.stdout.write(`\n${lances - failed} passed, ${failed + 1} failed\n`);
  process.exit(1);
});
