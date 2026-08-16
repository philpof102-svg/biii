'use strict';
/**
 * BIII server — the thin HTTP surface the merchant PWA (and any client) talks to.
 * ==============================================================================
 * Non-custodial by construction: the merchant address is configured by the operator
 * (BIII_MERCHANT), the server holds no key and moves no funds. It only: mints a charge +
 * EIP-681 URI, and reports what the CHAIN says about a charge (lib/chain + lib/till verify).
 *
 *   GET  /                      → health (merchant configured?, chain reachable is lazy)
 *   POST /charge {amountUsd,label} → { charge, chargeId, paymentURI }  (create a payment request; the chargeId
 *        is the server-owned handle that binds this charge — poll /status and /receipt with it)
 *   GET  /status?chargeId=… → { verdict, fact }                    (has the chain paid THIS charge? chargeId
 *        REQUIRED — the server owns the freshness window + the one-transfer-one-charge guard, so a prior/
 *        unrelated transfer can never satisfy an unbound query. Unknown/expired chargeId ⇒ not paid.)
 *   GET  /receipt?chargeId=…&name= → { receipt } | { error }       (receipt for a paid, server-known charge)
 *   GET  /trust?address=0x…[&resourceUrl=] → { vet }               (LOCAL safe-to-pay verdict — one fetch,
 *        no MCP: the known-bad screen + this node's trust-core classifier + floor provenance, fail-closed.
 *        Pure-local (no chain, no oracle call) so any web app can embed it as a pre-payment check.)
 *   GET  /asset?token=0x…[&claimedIssuer=&claimedSymbol=] → { verdict }  (is a TOKENIZED-ASSET contract the
 *        GENUINE issuer's or an impersonator? genuine/impersonation/unsafe/unknown, fail-closed — a pre-trade
 *        authenticity check any web page can embed and re-verify on-chain.)
 *   GET  /parse-qr?text=… → { parsed }                             (P2P: validate a SCANNED QR into a Base
 *        USDC payment target — fail-closed. Two people with the app scan each other and pay wallet-to-wallet.)
 *   GET  /receive?address=0x…[&amountUsd=] → { paymentURI }         (P2P: the QR a user shows to receive USDC.)
 *   GET  /verify?txHash=0x… → { proof }                            (ACCOUNTING: retrieve a tx by hash and
 *        confirm it's a real confirmed USDC-on-Base payment — from/to/amount, straight from the chain. Prove
 *        a receipt is real for the merchant's books, even off-crypto. Fail-closed.)
 *   GET  /radar → { radar }                                         (the trust-radar brief: issuer-verified
 *        coverage by chain/issuer + floor freshness, and the rolling history of /asset + /trust checks this
 *        node served — flags first. The brief + its history live on the server, no external delivery.)
 * CORS-open for reads so a static PWA on any origin can poll; loopback-safe otherwise.
 * Run: BIII_MERCHANT=0x… node lib/server.js   (PORT default 4700)
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./till');
const { findPayment, verifyTxHash } = require('./chain');
const { vetLocal, loadFloor } = require('./vet');
const { screenMeta } = require('./screen');   // floor freshness for the /radar coverage brief
const { assessAsset, assetVertex } = require('./asset');
const { vetMeme } = require('./meme');
const { parsePaymentQR, receiveURI } = require('./qrpay');   // P2P: validate a scanned QR / build a receive QR
/* La facture Web2 sur le MEME registre non-custodial. Ce module est deja servi aux AGENTS par
 * `till_create_invoice` / `till_check_invoice`; les deux routes ci-dessous lui donnent une porte
 * HUMAINE — elles ne RECOPIENT rien, elles l'appellent. Un second calcul de total ou d'echeance
 * divergerait le jour ou l'un des deux serait corrige (canonical-helper-weaker-copy, motif n°1 ici). */
const INV = require('./invoice');
const { loadAssetRegistry } = require('./asset-registry');   // issuer-verified (green) merged over aggregator (teal)
const { DISCLAIMER } = require('./disclaimer');
const { buildOpenApi, challenge402, priceMicro } = require('./openapi');   // AgentCash/x402 discovery + paid verdicts
const { settleOnce } = require('./x402-settle');   // single-use + freshness: one payment = one verdict (anti-replay)
const { rateLimit } = require('./ratelimit');   // per-IP cap so a caller can't hammer the RPC-calling routes into a DoS
const { handleRpc: mcpHandleRpc } = require('../bin/biii-mcp');   // the SAME MCP dispatch the stdio server uses, served over HTTP at /mcp
const { shouldRoute, startBackgroundScan } = require('./biii-router');   // BIII safe-to-pay router (USDC filter)
const USAGE = require('./usage');   // does anyone actually call this? tool NAMES only, our own probes excluded
const RADAR = require('./radar-tick');   // le collecteur, la ou la machine ne s eteint pas — inerte sans son env

const PORT = Number(process.env.PORT) || 4700;
const MERCHANT = (process.env.BIII_MERCHANT || '').toLowerCase();

// Serve the merchant PWA SAME-ORIGIN so the phone app and its API share one URL (open the server URL
// on the phone → the till loads and polls itself; no hardcoded host, no cross-origin config).
const WEB_DIR = path.join(__dirname, '..', 'web');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/qrcode.min.js': 'qrcode.min.js', '/manifest.json': 'manifest.json',
  '/embed.js': 'embed.js', '/embed-demo.html': 'embed-demo.html', '/radar.html': 'radar.html', '/p2p.html': 'p2p.html', '/vet-meme.html': 'vet-meme.html',
  '/facture.html': 'facture.html',
  '/brand/biii-icon.svg': 'brand/biii-icon.svg', '/brand/biii-icon-maskable.svg': 'brand/biii-icon-maskable.svg',
  '/brand/biii-wordmark.svg': 'brand/biii-wordmark.svg', '/brand/biii-wordmark-dark.svg': 'brand/biii-wordmark-dark.svg',
  '/brand/biii-lockup-black.svg': 'brand/biii-lockup-black.svg', '/brand/biii-og.svg': 'brand/biii-og.svg' };
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
};
// raw request body (JSON-RPC may be a single object OR a batch array — readBody would lose that), 1MB cap.
const readRaw = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(b)); req.on('error', () => resolve(''));
});
// oops — log the real error SERVER-SIDE, return only a stable category to the caller.
// Raw e.message can carry infra detail (RPC URLs, file paths, library internals) — never leak it (CWE-209).
//
// ⚠️ SAUF UN CAS, ET IL COUTAIT LE PARCOURS COMMERCANT. Mesure du 2026-08-15, cinq POST /charge avec
// `amountUsd` valant 0, -5, "abc", 999999999999 et 4.5555555: CINQ causes distinctes, UNE SEULE phrase
// rendue — « could not create the charge — check amount/label » — qui nommait `amount` (le champ
// s'appelle `amountUsd`) et `label` (en cause dans aucun des cinq). Un commercant devant sa caisse
// n'avait aucun moyen de savoir lequel de ses cinq gestes etait refuse, ni quoi corriger.
//
// La regle CWE-209 vise les internes: URLs RPC, chemins de fichiers, traces de bibliotheque. Un refus de
// VALIDATION ne parle que de ce que l'appelant vient d'envoyer — le lui rendre ne divulgue rien qu'il ne
// sache deja. `lib/till.js` marque cette classe A LA SOURCE avec `.caller = true` (voir `refus()` la-bas):
// un CONTRAT, pas une reconnaissance du texte du message, qui aurait lache au premier reformulage.
// Tout ce qui n'est pas explicitement marque reste couvert par la categorie stable — fail-closed.
const oops = (res, code, category, e) => {
  try { console.error('[biii]', category, '·', (e && (e.stack || e.message)) || e); } catch { /* logging must never throw */ }
  // `=== true` et pas la verite tout court: un objet quelconque portant un `caller` ne franchit pas la porte.
  const duCaller = e && e.caller === true && typeof e.message === 'string' && e.message;
  return json(res, code, { error: duCaller ? e.message.slice(0, 200) : category });
};
const readBody = (req) => new Promise((resolve) => {
  let b = '', over = false;                              // resolve() is idempotent — first settle wins
  req.on('data', (c) => { b += c; if (b.length > 4096 && !over) { over = true; req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  req.on('close', () => resolve({}));                    // destroyed/aborted (e.g. oversized) → settle so the
  req.on('error', () => resolve({}));                    // awaiting handler can't hang and leak forever
});

/** Build the server. deps.findPayment / deps.merchant / deps.knownBad / deps.trustCore injectable for tests (no network). */
function build(deps = {}) {
  const find = deps.findPayment || findPayment;
  const merchant = (deps.merchant || MERCHANT || '').toLowerCase();
  const knownBad = deps.knownBad || loadFloor();          // the floor is loaded ONCE; /trust reads are pure-local
  const trustCore = 'trustCore' in deps ? deps.trustCore : undefined;   // undefined ⇒ lib/vet resolves it itself
  const assetReg = 'assetRegistry' in deps ? deps.assetRegistry : loadAssetRegistry();   // {entries, source} for /asset
  /* ⛔ L'ETAT DU COLLECTEUR, PARCE QUE LES LOGS NE SORTENT PAS DU CONTENEUR. `radar-tick` disait deja
   * s'il tournait — par `console.log`. De l'exterieur, `/health` rendait `ok:true` et `/radar` la
   * couverture du registre: RIEN sur la collecte. Mesure du 2026-08-11: 111,3 h de silence en 9 trous,
   * tous « la machine dort », et personne ne pouvait constater si le collecteur SERVEUR prenait le
   * relais. Injectable pour les tests; `null` quand ce processus n'a pas demarre de radar — un etat
   * DIFFERENT de « inactif », et qui ne doit pas se lire comme lui. */
  const radarEtat = 'radarEtat' in deps ? deps.radarEtat : (globalThis.__biiiRadarEtat || null);

  // TRUST RADAR — a rolling, in-memory log of the /asset + /trust checks this node served, so the server
  // itself keeps the "brief" history (no Telegram, no external delivery — the history lives here). Capped;
  // per-instance; addresses are public data. deps.radarStore injectable for tests.
  const RADAR_MAX = 300;
  const radar = deps.radarStore || [];
  const logCheck = (rec) => { radar.push({ t: Date.now(), ...rec }); if (radar.length > RADAR_MAX) radar.splice(0, radar.length - RADAR_MAX); };
  // issuer-verified coverage for the radar brief (which issuers/chains this node can authenticate).
  /* ⚠️ QUATRE CAUSES D'ECHEC RENDAIENT TOUTES `[]` — donc « ce noeud authentifie 0 emetteur ».
   * Fichier absent · JSON illisible (`catch {}`) · cle `entries` manquante · `entries: null`. Mesure du
   * 2026-07-28: le fichier reel du depot porte **183 entrees sur 11 chaines**, et les quatre echecs
   * rendent 0. `/radar` — surface PUBLIQUE — publie `issuerVerified: <longueur>` et `chains:
   * <distincts>`: la couverture passait de 183 a 0 sans un mot, et un lecteur en concluait que ce noeud
   * n'authentifie rien.
   *
   * On garde un TABLEAU pour les consommateurs existants (la boucle du /radar), et on retient A COTE
   * pourquoi il est vide. Un zero explique est une mesure; un zero muet est une affirmation. */
  const chargerEmetteurs = () => {
    if (deps.issuerVerified) return { entries: deps.issuerVerified, read: true, why: null };
    /* `issuerVerifiedPath` existe pour que les chemins d'ECHEC soient testables sans deplacer un fichier
     * reel: passer `deps.issuerVerified` court-circuite tout le chargeur, donc la branche « non lu »
     * serait inatteignable depuis un test — et une branche inatteignable est une branche non prouvee. */
    const p = deps.issuerVerifiedPath || path.join(__dirname, '..', 'data', 'issuer-verified.json');
    let brut;
    try { if (!fs.existsSync(p)) return { entries: [], read: false, why: 'no issuer-verified.json on this node' }; }
    catch (e) { return { entries: [], read: false, why: 'could not test for issuer-verified.json (' + (e && e.code || '?') + ')' }; }
    try { brut = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return { entries: [], read: false, why: 'issuer-verified.json exists but is unreadable (' + (e && e.name || 'error') + ')' }; }
    /* ⚠️ CE GARDE EST LOAD-BEARING, et pas seulement pour la divulgation: sans lui, `entries` vaut
     * `undefined` et la boucle du /radar jette `is not iterable` — le handler meurt au lieu de repondre.
     * Mesure faite en le retirant volontairement. */
    if (!Array.isArray(brut && brut.entries)) {
      return { entries: [], read: false, why: 'issuer-verified.json parsed but carries no `entries` array' };
    }
    return { entries: brut.entries, read: true, why: null };
  };
  const issuerSource = chargerEmetteurs();
  const issuerVerified = issuerSource.entries;

  // When a merchant is configured, it is FIXED: a caller can't redirect a charge/verdict/receipt to another
  // address (the single-merchant till the product promises). Only a no-merchant server honors a caller `to`.
  const forceMerchant = (caller) => merchant || String(caller || '').toLowerCase();
  // Bound the lookback window by how long THIS charge has been open (~2s Base blocks + skew buffer), so a
  // PRIOR/unrelated transfer to the merchant can't satisfy a freshly-created charge.
  const boundLookback = (createdAtMs, raw) => {
    let lb = Math.min(900, Math.max(1, Number(raw) || 900));
    if (createdAtMs > 0) { const ageSec = Math.max(0, (Date.now() - createdAtMs) / 1000); lb = Math.min(lb, Math.ceil(ageSec / 2) + 6); }
    return lb;
  };

  // SERVER-AUTHORITATIVE charge registry (in-memory, TTL). This closes the cross-charge false-PAID: a Transfer
  // is bound to a specific charge by a chargeId minted at POST /charge, and the freshness window uses the
  // SERVER's createdAtMs (never a forgeable client timestamp). `consumed` ensures one on-chain transfer
  // satisfies at most one charge (the two-register case). Single-instance; lost on restart (re-ring the sale).
  // NOT custodial — no funds/keys, correctness state only. deps.chargeStore lets tests inject a shared store.
  const CHARGE_TTL_MS = 30 * 60 * 1000;
  const store = deps.chargeStore || { pending: new Map(), consumed: new Map() };
  const { pending, consumed } = store;
  const sweep = () => { const now = Date.now();
    for (const [id, c] of pending) if (now - c.createdAtMs > CHARGE_TTL_MS) pending.delete(id);
    for (const [tx, c] of consumed) if (now - c.at > CHARGE_TTL_MS) consumed.delete(tx);
  };
  // resolve a charge from its chargeId; returns the server-stored record or null (unknown/expired).
  const lookupCharge = (chargeId) => (chargeId && pending.get(String(chargeId))) || null;
  // txHashes already applied to a DIFFERENT charge — passed to findPayment so each charge finds its OWN
  // unconsumed transfer (avoids a false-negative when two same-amount charges race).
  const excludeForOthers = (chargeId) => { const s = new Set(); for (const [tx, c] of consumed) if (c.chargeId !== chargeId) s.add(tx); return s; };
  // verify a resolved charge against the chain, with the consumed-tx guard. Shared by /status and /receipt.
  const verifyCharge = async (rec, chargeId, rawLookback) => {
    const lookback = boundLookback(rec.createdAtMs, rawLookback);
    const fact = await find({ to: rec.to, minMicro: rec.amountMicro, lookbackBlocks: lookback, excludeTxHashes: excludeForOthers(chargeId) });
    const charge = { to: rec.to, amountMicro: rec.amountMicro, amountUsd: T.microToUsd(rec.amountMicro), token: T.USDC_BASE, chainId: 8453 };
    const verdict = T.verifyPayment(charge, fact);
    if (verdict.paid && fact && fact.txHash) {
      const key = String(fact.txHash).toLowerCase();
      const owner = consumed.get(key);
      // race backstop: if another charge claimed this exact tx between the find and here, do NOT double-count.
      if (owner && owner.chargeId !== chargeId) return { charge, verdict: { paid: false, reason: 'the matching transfer was already applied to another charge' }, fact: null };
      consumed.set(key, { chargeId, at: Date.now() });
    }
    return { charge, verdict, fact: fact || null };
  };

  // Start background scan for USDC transfer log filter (BIII router)
  if (process.env.BIII_ROUTER_ENABLED === 'true') {
    startBackgroundScan({ rpcUrl: process.env.BASE_RPC_URL || DEFAULT_RPC });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/health') {
      /* ⚠️ TROIS ETATS, JAMAIS FONDUS. `notStarted` (ce processus n'a pas de collecteur — le cas d'un
       * test ou d'un serveur lance a la main) n'est PAS `inactive` (le collecteur existe et attend
       * `RADAR_TICK_MINUTES`), qui n'est pas `running`. Et `running` sans `lastTickAt` veut dire ARME
       * mais JAMAIS TOURNE: un collecteur qui plante a chaque tick resterait « actif » sans cette
       * distinction, et c'est exactement la faute que ce champ existe pour empecher. */
      const e = typeof radarEtat === 'function' ? radarEtat() : null;
      const collector = !e
        ? { state: 'notStarted', note: 'this process started no collector — say nothing about the base' }
        : {
          state: e.actif ? (e.lastTickAt ? 'running' : 'armed') : 'inactive',
          reason: e.raison || null,
          everyMinutes: e.minutes ?? null,
          ticks: e.ticks,
          lastTickAt: e.lastTickAt,
          lastTickOk: e.lastTickOk,
          lastTickAgeMinutes: e.lastTickAgeMinutes == null ? null : Math.round(e.lastTickAgeMinutes),
          lastTickReason: e.lastTickRaison || null,
          note: e.actif
            ? (e.lastTickAt
              ? 'armed AND has run — read lastTickAgeMinutes against everyMinutes to see a dead collector'
              : 'ARMED BUT NEVER RAN YET — not the same as running')
            : 'INACTIVE: set RADAR_TICK_MINUTES to collect without depending on a machine that sleeps',
        };
      /* ⚠️ QUEL ARBRE TOURNE ICI. Mesure du 2026-08-13: la copie deployee ne rendait pas `collector`, donc
       * elle etait ANTERIEURE au commit qui l a ajoute — et c est en remarquant un champ MANQUANT que je
       * l ai su, faute de tout marqueur. 78 appels externes etaient deja passes par cette version. Corriger
       * le depot ne corrige pas ce qui tourne, et sans marqueur personne ne peut voir l ecart.
       *
       * ⛔ La cle n est pas DEVINEE. Aucune variable de build n a ete verifiee sur cette plateforme, donc on
       * lit une LISTE et on NOMME celle qui a repondu: le champ dit d ou vient sa valeur, jamais seulement
       * la valeur. Et l absence a sa propre branche — un `marker: null` muet se lirait comme « a jour ». */
      const CLES_MARQUEUR = ['RAILWAY_GIT_COMMIT_SHA', 'RAILWAY_DEPLOYMENT_ID', 'BIII_COMMIT', 'SOURCE_COMMIT', 'GIT_COMMIT'];
      const cleMarqueur = CLES_MARQUEUR.find((k) => String(process.env[k] || '').trim());
      const deployment = cleMarqueur
        ? { marker: String(process.env[cleMarqueur]).trim().slice(0, 12), from: cleMarqueur }
        : { marker: null, from: null,
          note: 'no build marker in this environment — nothing here can tell you WHICH tree is running' };

      return json(res, 200, { ok: true, service: 'biii', merchantConfigured: /^0x[0-9a-f]{40}$/.test(merchant),
        collector,
        deployment,
        note: 'non-custodial: this server holds no key and moves no funds' });
    }

    /* Deliberately PUBLIC and deliberately unflattering. It reports what it cannot see (stdio callers never
     * reach this process, so the number is a FLOOR), keeps our own probes out of the total, and holds no
     * identifier — so there is nothing here worth hiding and nothing worth stealing. A metric that is only
     * shown when it looks good is marketing; this one exists to be checkable when it reads zero. */
    if (req.method === 'GET' && url.pathname === '/usage') {
      try { return json(res, 200, USAGE.report()); }
      catch (e) { return json(res, 200, { error: 'usage counter unavailable: ' + e.message, note: 'the absence of a count is not a count of zero' }); }
    }

    // Rate limit everything past /health (Railway's healthcheck must never be throttled). The paid /x402,
    // /status, /receipt and /radar routes make outbound Base-RPC calls — an uncapped caller could hammer
    // them and exhaust our RPC quota (a DoS of our own availability). 120/min/IP is generous for the
    // caisse; it only bites abuse. See lib/ratelimit.js.
    const rl = rateLimit(req);
    if (!rl.allowed) {
      res.writeHead(429, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'retry-after': String(rl.retryAfterSec) });
      return res.end(JSON.stringify({ error: 'rate limit exceeded — slow down', retryAfterSec: rl.retryAfterSec, limit: rl.limit }));
    }

    // POST /mcp — MCP over Streamable HTTP. Any MCP client (openhuman, Claude Desktop, a tool router)
    // points at this URL and gets BIII's tools with ZERO install — the same 15 tools + JSON-RPC dispatch
    // as bin/biii-mcp.js (stdio), reused verbatim. Stateless (no session id required); read-only + non-
    // custodial like every BIII surface. GET (server→client SSE) is not offered → 405.
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        return json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'GET/SSE not supported — POST JSON-RPC to /mcp' } });
      }
      if (req.method === 'POST') {
        const raw = await readRaw(req);
        let msg; try { msg = JSON.parse(raw || 'null'); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
        const batch = Array.isArray(msg);
        const out = [];
        for (const one of (batch ? msg : [msg])) {
          /* COUNT THE CALL. Twenty-nine tools were served with nothing counting one, so "has a stranger ever
           * used this" had no answer — and that is the question this project's own Key Learnings call the
           * make-or-break. Only the tool NAME reaches the counter: arguments carry merchant addresses, wallet
           * addresses, scanner file paths and whole deliverables, and a usage log holding those would be more
           * dangerous than anything this server defends against.
           *
           * Our own probes are marked and counted apart. Letting them inflate the number would be the exact
           * self-deception found in this codebase's other metrics tonight. */
          if (one && one.method === 'tools/call' && one.params && one.params.name) {
            try {
              USAGE.record(String(one.params.name), {
                internal: String(req.headers['x-ms-monitor'] || '') === '1',
                // An opaque per-caller hint, hashed with the day inside the counter and never retained.
                callerHint: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
              });
            } catch { /* a metrics failure never breaks a payment call */ }
          }
          const r = await mcpHandleRpc(one); if (r) out.push(r);
        }
        if (!out.length) { res.writeHead(202, { 'access-control-allow-origin': '*' }); return res.end(); }   // only notifications → no body
        return json(res, 200, batch ? out : out[0]);
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // static PWA (index.html / qrcode / manifest). Missing web/ falls through to /health-style 404.
    if (req.method === 'GET' && STATIC[url.pathname] !== undefined) {
      try {
        const file = STATIC[url.pathname];
        const body = fs.readFileSync(path.join(WEB_DIR, file));
        res.writeHead(200, { 'content-type': CT[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
        return res.end(body);
      } catch { return json(res, 200, { ok: true, service: 'biii', merchantConfigured: /^0x[0-9a-f]{40}$/.test(merchant), note: 'web/ not built; API is live' }); }
    }

    if (req.method === 'POST' && url.pathname === '/charge') {
      const b = await readBody(req);
      const to = forceMerchant(b.to);          // configured merchant wins — no caller redirect
      try {
        const charge = T.createCharge({ to, amountUsd: b.amountUsd, label: b.label, orderId: b.orderId, nowMs: Date.now() });
        sweep();
        const chargeId = crypto.randomBytes(12).toString('hex');   // the server-owned handle that binds this charge
        pending.set(chargeId, { to: charge.to, amountMicro: charge.amountMicro, createdAtMs: Date.now() });
        return json(res, 200, { charge, chargeId, paymentURI: T.paymentURI(charge) });
      // La categorie n'est plus qu'un REPLI: une erreur de validation arrive marquee `.caller` et se dit
      // elle-meme. Ce qui tombe ici est INATTENDU — le nommer « check amount/label » serait deviner.
      } catch (e) { return oops(res, 400, 'could not create the charge', e); }
    }

    /* POST /invoice — la MEME facture que `till_create_invoice` sert aux agents, pour un humain.
     *
     * ⛔ CE QUE CETTE ROUTE N'EST PAS: un stockage. Rien n'est retenu ici — la facture rendue EST
     * l'objet complet, et `/invoice-status` la RECONSTRUIT depuis ses champs pour juger. C'est le
     * meme choix que le jumeau MCP (`till_check_invoice` reconstruit aussi), et il porte une
     * consequence qu'il faut dire: tout champ non renvoye au controle est INVISIBLE pour le verdict.
     * D'ou le renvoi explicite de `rail` ci-dessous — sans lui, une facture reglee par carte
     * reviendrait « overdue, unpaid » a propos d'un client qui a paye.
     *
     * `forceMerchant` comme /charge: un marchand configure gagne sur le `to` de l'appelant, sinon
     * cette page publierait des factures encaissables par n'importe qui. */
    if (req.method === 'POST' && url.pathname === '/invoice') {
      const b = await readBody(req);
      const to = forceMerchant(b.to);
      try {
        const invoice = INV.createInvoice({ to, lineItems: b.lineItems, number: b.number, billTo: b.billTo,
          merchantName: b.merchantName, dueDateMs: b.dueDateMs, rail: b.rail,
          issueDateMs: Date.now(), nowMs: Date.now() });
        return json(res, 200, { invoice, paymentURI: INV.invoiceURI(invoice),
          bill: INV.renderInvoice(invoice, { lang: b.lang === 'fr' ? 'fr' : 'en' }),
          note: 'Non-custodial: the payer\'s OWN wallet executes this EIP-681. Only the chain says settled. ' + DISCLAIMER });
      } catch (e) { return oops(res, 400, 'could not create the invoice', e); }
    }

    /* GET /invoice-status — la facture a-t-elle ete reglee ON-CHAIN ?
     *
     * ⚖️ QUATRE ETATS, et le quatrieme est le point: `settled` / `overdue` / `issued` /
     * `not_observable`. Une facture qui se regle sur un rail que BIII ne LIT PAS (carte, SEPA,
     * especes) ne montrera JAMAIS de transfert sur Base — l'absence ne dit alors RIEN du client, et
     * l'appeler « impayee » serait une accusation tiree de notre propre cecite. Passer le MEME
     * `rail` qu'a la creation est donc load-bearing.
     *
     * ⛔ Pas de `chargeId` ici, contrairement a /status, et c'est assume: une facture est un
     * document que le client garde et paie plus tard (fenetre par defaut ~1 jour de blocs, contre
     * quelques minutes pour une caisse). Le verdict est donc plus faible que celui d'une caisse —
     * il dit « un transfert conforme existe », pas « CE paiement-la et lui seul ». La caisse reste
     * la route a utiliser quand la liaison stricte compte. */
    if (req.method === 'GET' && url.pathname === '/invoice-status') {
      const to = String(url.searchParams.get('to') || '').toLowerCase();
      const totalMicro = String(url.searchParams.get('totalMicro') || '');
      if (!/^0x[0-9a-f]{40}$/.test(to) || !/^[0-9]+$/.test(totalMicro) || totalMicro === '0') {
        return json(res, 400, { error: 'need `to` (0x Base address) and a positive `totalMicro` — the invoice is rebuilt from these, nothing is stored server-side.' });
      }
      const rail = url.searchParams.get('rail') || undefined;
      const dueRaw = url.searchParams.get('dueDateMs');
      /* `Number('')` vaut 0 et `Number('abc')` vaut NaN: une echeance illisible passee crue rendrait
       * une facture « overdue » ou « issued » selon le hasard de la comparaison. Absente OU illisible
       * ⇒ pas d'echeance du tout, ce qui ne peut que RETENIR le verdict `overdue`. */
      const dueNum = Number(dueRaw);
      const dueDateMs = (dueRaw && Number.isFinite(dueNum) && dueNum > 0) ? dueNum : null;

      /* La MEME reconstruction litterale que `till_check_invoice` (bin/biii-mcp.js) — pas
       * `createInvoice`, qui exige des lignes en USD alors qu'ici on ne connait que le total en
       * micro. Deux formes divergentes du meme document seraient jugees differemment par le meme
       * `invoiceStatus`: on copie donc la forme du jumeau, champ pour champ. */
      const invoice = { kind: 'biii-invoice', number: url.searchParams.get('number') || null, dueDateMs,
        rail: T.railOf(rail).rail,
        merchant: { name: url.searchParams.get('merchantName') || null, address: to },
        charge: { to, amountMicro: totalMicro, amountUsd: T.microToUsd(totalMicro), token: T.USDC_BASE, chainId: 8453 },
        lineItems: [], totalMicro, totalUsd: T.microToUsd(totalMicro) };

      /* LE RAIL SE LIT AVANT LA CHAINE, pour la meme raison que cote MCP: une facture reglee par
       * carte ou en especes n'apparaitra jamais sur Base, donc son verdict ne doit dependre d'AUCUN
       * noeud — une panne RPC ferait echouer une reponse connue d'avance. C'est le cas du commercant
       * hors ligne, et c'est le plus concret du produit. */
      const railInv = T.railOf(invoice.rail);
      if (railInv.named && !railInv.witnessable) {
        return json(res, 200, { status: INV.invoiceStatus(invoice, null, Date.now()), verdict: null, fact: null, receipt: null,
          note: 'No chain read was attempted: this invoice settles on a rail BIII cannot witness. Its payment state lives in the merchant\'s books — absence of a Base transfer says NOTHING about this customer. ' + DISCLAIMER });
      }
      try {
        /* `find`, PAS `findPayment`: la ligne 114 resout l'injection de test, et ecrire le module
         * directement ici la contournait — un test hermetique partait alors sur le VRAI RPC (constate
         * a l'ecriture de ces routes: `eth_getLogs HTTP 413` depuis la suite). Le helper canonique
         * existait a douze lignes; ne pas l'appeler est le motif n°1 de ce depot. */
        const fact = await find({ to, minMicro: totalMicro,
          lookbackBlocks: Number(url.searchParams.get('lookback')) || 43200 });
        const verdict = INV.verifyInvoice(invoice, fact);
        const status = INV.invoiceStatus(invoice, verdict, Date.now());
        return json(res, 200, { status, verdict, fact: fact || null,
          receipt: status.status === 'settled' ? INV.invoiceReceipt(invoice, fact) : null,
          note: 'Chain-only verdict, re-verifiable by anyone from the txHash. ' + DISCLAIMER });
      } catch (e) { return oops(res, 502, 'chain read failed', e); }
    }

    // GET /status?chargeId=… — has THIS charge been paid on-chain? A chargeId (from POST /charge) is REQUIRED:
    // the server owns the freshness window + the one-transfer-one-charge guard, so a prior/unrelated transfer
    // can never satisfy an unbound query (the cross-charge false-PAID). Unknown/expired chargeId ⇒ not paid.
    if (req.method === 'GET' && url.pathname === '/status') {
      const chargeId = url.searchParams.get('chargeId');
      const rec = lookupCharge(chargeId);
      if (!rec) return json(res, 200, { verdict: { paid: false, reason: 'unknown or expired chargeId — create the charge via POST /charge, then poll /status with its chargeId' }, fact: null });
      try {
        const { verdict, fact } = await verifyCharge(rec, chargeId, url.searchParams.get('lookback'));
        return json(res, 200, { verdict, fact });
      } catch (e) { return oops(res, 502, 'chain read failed', e); }
    }

    // GET /trust — the LOCAL safe-to-pay verdict as ONE fetch, for any web app (no MCP needed). Pure-local:
    // known-bad screen (decisive) + trust-core classifier (this node's judgment) + floor provenance. Fail-
    // closed: malformed address ⇒ 400 (no verdict for garbage); floor absent ⇒ "UNAVAILABLE", never "clean".
    if (req.method === 'GET' && url.pathname === '/trust') {
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return json(res, 400, { error: 'address must be a 0x Base address (40 hex) — no verdict for a malformed address.' });
      try {
        const resourceUrl = url.searchParams.get('resourceUrl') || undefined;
        const vet = vetLocal(address, { resourceUrl, knownBad, ...(trustCore !== undefined ? { tc: trustCore } : {}) });
        logCheck({ kind: 'trust', q: address, verdict: vet.screen.blocked ? 'blocked' : 'not-known-bad', flag: vet.screen.blocked });
        return json(res, 200, { vet, note: 'LOCAL verdict (this node\'s floor + classifier, no oracle). ' + DISCLAIMER });
      } catch (e) { return oops(res, 500, 'trust read failed', e); }   // fail-closed: an error is never a clean verdict
    }

    // GET /asset — is a TOKENIZED-ASSET contract the GENUINE issuer's, or an impersonator? One fetch, any
    // web page (a pre-trade authenticity check a user can re-verify). genuine / impersonation / unsafe /
    // unknown, fail-closed: a non-registry token reads 'unknown' (never a false 'genuine'); malformed → 400.
    if (req.method === 'GET' && url.pathname === '/asset') {
      const token = String(url.searchParams.get('token') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) return json(res, 400, { error: 'token must be a 0x contract address (40 hex) — no verdict for a malformed contract.' });
      try {
        /* ⛔ `registryComplete` VOYAGE AVEC LE REGISTRE — il etait CHARGE puis JETE ici. `loadAssetRegistry()`
         * rend `{entries, source, complete, incomplete}` et `assetReg.complete` est un TROIS-ETATS
         * (`true` | `false` | `null` inconnu). Sans lui, `lib/asset.js:124` fait `registryComplete === true`
         * sur `null` et ne peut JAMAIS rendre `confirmed: true`: le verdict reste couvert meme sur un
         * registre prouve complet. Le jumeau MCP le passe depuis toujours (`bin/biii-mcp.js:638`), donc
         * les deux routes REST — dont la PAYANTE — rendaient un verdict plus faible que le gratuit. */
        const verdict = assessAsset(
          { token, claimedIssuer: url.searchParams.get('claimedIssuer'), claimedSymbol: url.searchParams.get('claimedSymbol') },
          assetReg.entries ? { registry: assetReg.entries, registryComplete: assetReg.complete }
                           : { registryComplete: assetReg.complete });
        logCheck({ kind: 'asset', q: token, verdict: verdict.status, provenance: verdict.provenance || null, issuer: verdict.issuer || null,
          flag: verdict.status === 'impersonation' || verdict.status === 'unsafe' });
        return json(res, 200, { verdict, triangleReputation: assetVertex(verdict),
          registrySource: assetReg.entries ? `${assetReg.source} · ${assetReg.entries.length} contracts` : 'seed only',
          disclosure: 'ADVISORY, fail-closed: genuine = the contract matches a VERIFIED issuer address in the registry; impersonation/unknown never read as safe. Re-verify the contract on Basescan — a verdict is a pointer to the chain, not a badge to trust.',
          note: DISCLAIMER });
      } catch (e) { return oops(res, 500, 'asset read failed', e); }   // fail-closed: an error is never 'genuine'
    }

    // GET /openapi.json — AgentCash / x402 DISCOVERY: the machine-readable contract for BIII's PAID verdicts
    // (agentcash.dev/docs/discovery). Any x402/MPP agent can discover, price, and call the vet service.
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || '');
      /* buildOpenApi JETTE desormais sur un prix illisible plutot que de publier "NaN" ou un montant
       * negatif dans un document que des agents lisent pour decider quoi payer. On rend 503 « mal
       * configure » — notre faute, dite comme telle — au lieu d'un 500 avec une trace. */
      try {
        return json(res, 200, buildOpenApi({ origin, merchant, contactEmail: process.env.BIII_CONTACT_EMAIL }));
      } catch (e) {
        return json(res, 503, { error: 'discovery document unavailable: this node is misconfigured', detail: e.message });
      }
    }

    // POST /x402/vet-asset | /x402/vet-address | /x402/vet-meme — the PAID verdicts. BIII is the MERCHANT that RECEIVES USDC;
    // it signs nothing. Unpaid probe → a real 402 challenge (per the spec, BEFORE any body validation). Paid →
    // settle with BIII's OWN on-chain verifyTxHash (paid TO the merchant, ≥ price), then return the verdict.
    if (req.method === 'POST' && (url.pathname === '/x402/vet-asset' || url.pathname === '/x402/vet-address' || url.pathname === '/x402/vet-meme')) {
      const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || '');
      if (!/^0x[0-9a-f]{40}$/.test(merchant)) return json(res, 503, { error: 'merchant (payTo) not configured — this node cannot accept x402 payments' });
      /* LE PRIX EST RESOLU AVANT TOUT LE RESTE. `priceMicro` refuse desormais un prix illisible ou
       * negatif au lieu de rendre "NaN"/"-5000000". Le negatif comptait: settleOnce compare
       * `paidMicro < priceNeed`, et avec un besoin negatif ce test est faux pour TOUT paiement — une
       * coquille dans BIII_VET_PRICE_USD rendait l'endpoint payant gratuit. Un noeud qui ne sait pas
       * dire son prix ne doit ni facturer ni encaisser: 503, pas un defi bancal. */
      let need;
      try { need = priceMicro(process.env.BIII_VET_PRICE_USD || '0.25'); }
      catch (e) { return json(res, 503, { error: 'price not configured — this node cannot quote or settle', detail: e.message }); }
      const proofTx = String(req.headers['x-payment'] || url.searchParams.get('paymentTx') || '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(proofTx)) {                    // unpaid → 402 challenge (probe reaches here before any body check)
        const { headers, body } = challenge402({ origin, merchant, route: url.pathname });
        res.writeHead(402, headers); return res.end(JSON.stringify(body));
      }
      /* Vrai des que `settleOnce` a REUSSI: la transaction est alors consommee et non rejouable. */
      let misePayee = false;
      try {
        /* ⚠️ ON ENCAISSAIT AVANT DE VALIDER, ET LE PAIEMENT ETAIT PERDU.
         * `settleOnce` BRULE la transaction (« one payment = one verdict », 409 au rejeu), et le controle
         * d'adresse arrivait APRES. Prouve le 2026-07-28 sur un vrai serveur, meme transaction:
         *
         *   1) POST /x402/vet-address {address:'0x123'}      -> HTTP 400, adresse malformee
         *   2) POST /x402/vet-address {address: valide}      -> HTTP 409, « payment already redeemed »
         *
         * L'appelant a paye, s'est trompe d'un caractere, et a perdu sa mise sans recevoir de verdict —
         * sans pouvoir reessayer. Ce n'est pas une lecture manquee comme le reste de la journee, c'est un
         * ORDRE D'OPERATIONS: on ne consomme jamais un paiement pour une requete qu'on allait refuser.
         *
         * Le corps est donc lu et valide AVANT le reglement. Le defi 402 reste en amont (une sonde non
         * payante n'atteint toujours pas le corps), donc rien n'est ouvert au passage. */
        const b = await readBody(req);
        const adresseDemandee = String((b && b.address) || '').toLowerCase();
        if (url.pathname !== '/x402/vet-meme' && !/^0x[0-9a-f]{40}$/.test(adresseDemandee)) {
          return json(res, 400, { error: 'address must be a 0x Base address (40 hex)',
            note: 'REFUSED BEFORE SETTLEMENT — your payment was NOT consumed. Fix the address and retry '
              + 'with the same payment transaction.' });
        }
        if (url.pathname === '/x402/vet-meme' && !String((b && b.symbol) || '').trim() && !/^0x[0-9a-f]{40}$/.test(adresseDemandee)) {
          return json(res, 400, { error: 'vet-meme needs a symbol (and optionally an address)',
            note: 'REFUSED BEFORE SETTLEMENT — your payment was NOT consumed. Retry with the same payment transaction.' });
        }
        const proof = await (deps.verifyTxHash || verifyTxHash)({ txHash: proofTx });
        // one confirmed USDC payment TO the merchant, ≥ price, FRESH, redeems EXACTLY ONE verdict —
        // without this a single $0.002 tx (or any old qualifying transfer) replays into unlimited verdicts.
        const settled = settleOnce({ proof, merchant, needMicro: need });
        /* ⛔ A PARTIR D'ICI LA MISE EST BRULEE. Le `catch` de ce bloc annoncait « settlement read failed »
         * QUOI QU'IL ARRIVE — donc une panne SURVENUE APRES l'encaissement aurait envoye l'operateur
         * deboguer le reglement, qui avait pourtant reussi, et n'aurait rien dit a l'appelant du fait que
         * sa transaction est consommee et non rejouable. C'est la moitie manquante du correctif du
         * 2026-07-28: celui-ci garantit qu'un REFUS ne consomme pas la mise, celle-ci garantit qu'une
         * PANNE POSTERIEURE le DISE. Un message de garde est une hypothese, pas un diagnostic. */
        if (settled.ok) misePayee = true;
        if (!settled.ok) {
          const { headers, body } = challenge402({ origin, merchant, route: url.pathname });
          res.writeHead(settled.code, headers); return res.end(JSON.stringify({ ...body, error: settled.reason }));
        }
        // Le corps a ete lu et valide AVANT le reglement (voir plus haut): rien a relire ici.
        if (url.pathname === '/x402/vet-meme') {
          /* `Number(b.chainId)` — le meme defaut que dans bin/biii-mcp.js, corrige la-bas le 2026-07-27 et
           * rate ICI, sur la route PAYANTE. 'base' devenait NaN (donc aucun filtre, et un contrat Solana
           * certifie « genuine » a un client qui avait demande Base et paye pour la reponse); 8453 ne
           * correspondait a aucun slug DexScreener et ecartait tout. lib/meme.js accepte desormais les deux
           * formes et refuse ce qu'il ne sait pas traduire — on lui passe la valeur telle quelle. */
          /* ⛔ `siblingCount` A ETE RATE ICI EXACTEMENT COMME `chainId` PLUS HAUT, ET SUR LA MEME ROUTE
           * PAYANTE. Cable dans `bin/biii-mcp.js` le 2026-08-09 et pas ici, il rendait la retenue de
           * `observedRisk` INCONTOURNABLE pour un appelant qui PAIE, alors que la route MCP gratuite la
           * levait. Le palier payant delivrait donc STRICTEMENT MOINS que le gratuit — l'inverse exact
           * de ce qu'on facture. Le commentaire ci-dessus documentait deja ce motif; il s'est repete. */
          const result = await vetMeme({ symbol: b.symbol, chainId: b.chainId, address: b.address,
            siblingCount: typeof b.siblingCount === 'number' ? b.siblingCount : undefined,
            fetchImpl: deps.fetchImpl });
          logCheck({ kind: 'meme', q: b.symbol || b.address || '?', verdict: result.status, flag: result.status === 'impersonation' || result.status === 'ambiguous' });
          return json(res, 200, { ...result, paid: { txHash: proof.txHash }, note: 'paid vet-meme (x402). ' + DISCLAIMER });
        }
        const address = adresseDemandee;   // deja validee avant le reglement
        if (url.pathname === '/x402/vet-asset') {
          /* ⛔ MEME OUBLI QUE SUR `/asset`, ET ICI C'EST LA ROUTE PAYANTE. Sans `registryComplete`, un
           * client qui PAIE ne peut jamais obtenir un verdict `confirmed`, alors que la route MCP
           * GRATUITE le peut. Troisieme fois que le palier facture delivre moins que le gratuit dans ce
           * fichier — apres `chainId` (27/07) et `siblingCount` (09/08). */
          const verdict = assessAsset({ token: address, claimedIssuer: b.claimedIssuer, claimedSymbol: b.claimedSymbol },
            assetReg.entries ? { registry: assetReg.entries, registryComplete: assetReg.complete }
                             : { registryComplete: assetReg.complete });
          logCheck({ kind: 'asset', q: address, verdict: verdict.status, flag: verdict.status === 'impersonation' || verdict.status === 'unsafe' });
          return json(res, 200, { verdict, paid: { txHash: proof.txHash }, note: 'paid vet (x402). ' + DISCLAIMER });
        }
        const vet = vetLocal(address, { resourceUrl: b.resourceUrl, knownBad, ...(trustCore !== undefined ? { tc: trustCore } : {}) });
        logCheck({ kind: 'trust', q: address, verdict: vet.screen.blocked ? 'blocked' : 'not-known-bad', flag: vet.screen.blocked });
        return json(res, 200, { vet, paid: { txHash: proof.txHash }, note: 'paid vet (x402). ' + DISCLAIMER });
      } catch (e) {
        /* ⛔ DEUX PANNES OPPOSEES QUI RENDAIENT LE MEME MESSAGE. Avant reglement, la mise est INTACTE et
         * l'appelant peut rejouer la meme transaction; apres, elle est CONSOMMEE et il ne le peut plus.
         * Annoncer « settlement read failed » dans les deux cas affirmait une cause non verifiee et
         * taisait la seule chose que l'appelant doit savoir: ou est passe son argent. */
        return misePayee
          ? oops(res, 502, 'PAYMENT CONSUMED, verdict failed after settlement — your transaction is spent '
              + 'and cannot be replayed. This is NOT a settlement problem: the payment went through and the '
              + 'verdict computation failed afterwards.', e)
          : oops(res, 502, 'settlement read failed — your payment was NOT consumed; retry with the same '
              + 'transaction', e);
      }
    }

    // GET /receipt?chargeId=…&name=… — a receipt is minted ONLY for a server-known charge that the chain
    // verified as paid. A chargeId is REQUIRED (same anti-false-PAID binding as /status): no invented charge
    // can be dressed up as a chain-anchored receipt.
    if (req.method === 'GET' && url.pathname === '/receipt') {
      const chargeId = url.searchParams.get('chargeId');
      const rec = lookupCharge(chargeId);
      if (!rec) return json(res, 404, { error: 'unknown or expired chargeId — a receipt is only minted for a paid, server-known charge' });
      try {
        const { charge, verdict } = await verifyCharge(rec, chargeId, url.searchParams.get('lookback'));
        if (!verdict.paid) return json(res, 404, { error: verdict.reason });
        return json(res, 200, { receipt: T.receipt(charge, verdict, { merchantName: url.searchParams.get('name') }) });
      } catch (e) { return oops(res, 502, 'chain read failed', e); }
    }

    // GET /radar — the trust-radar brief: what this node can authenticate (issuer-verified coverage by chain
    // + issuer, floor size/freshness) AND the rolling history of the checks it has served (recent flags first).
    // The "brief" and its history live HERE — no Telegram, no external delivery. Read-only, public data.
    if (req.method === 'GET' && url.pathname === '/radar') {
      const byChain = {}, byIssuer = {};
      for (const e of issuerVerified) { byChain[e.chainId] = (byChain[e.chainId] || 0) + 1; byIssuer[e.issuer] = (byIssuer[e.issuer] || 0) + 1; }
      const floor = screenMeta(knownBad);
      return json(res, 200, { radar: {
        coverage: { issuerVerified: issuerSource.read ? issuerVerified.length : null,
          issuerListRead: issuerSource.read,
          issuerListNote: issuerSource.read ? undefined
            : issuerSource.why + ' — the coverage below is NOT zero, it is UNREAD, and this node may well '
              + 'authenticate issuers it cannot currently list',
          chains: issuerSource.read ? Object.keys(byChain).length : null, byChain, byIssuer,
          /* ⚠️ `addresses: floor.count ?? 0` + `stale: floor.stale === true` presentaient un plancher NON
           * LU comme « 0 adresses, non perime » — a jour et vide — sur une surface PUBLIQUE. `stale` est
           * desormais fail-closed dans screenMeta, et `available` est publie ici: sans lui, un lecteur ne
           * peut pas distinguer « 0 parce que la liste est vide » de « 0 parce qu'elle n'a pas ete lue ».
           * Un zero non explique est une affirmation. */
          floor: { available: floor.available === true, addresses: floor.available ? floor.count : null,
            asOf: floor.asOf || null, stale: floor.stale !== false,
            note: floor.available ? undefined
              : 'this node has NO known-bad list loaded — the count is not zero, it is unread, and nothing '
                + 'below was screened against a floor' } },
        served: radar.length,
        recentFlags: radar.filter((r) => r.flag).slice(-30).reverse(),   // impersonations + known-bad blocks, newest first
        recentChecks: radar.slice(-60).reverse(),
      }, note: 'BIII trust radar — the checks this node verified + the flags it raised (history lives on the server). ' + DISCLAIMER });
    }

    // GET /verify?txHash=0x… — the ACCOUNTING proof: retrieve a transaction by its hash and confirm, straight
    // from the chain, that it is a real confirmed USDC-on-Base payment (from/to/amount). For a merchant's books
    // (even off-crypto): given a receipt's txHash, prove the money really moved. Fail-closed: no verdict for a
    // malformed hash; not-found / reverted / no-USDC-log ⇒ paid:false (the chain, not our record, is the truth).
    if (req.method === 'GET' && url.pathname === '/verify') {
      const txHash = String(url.searchParams.get('txHash') || '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return json(res, 400, { error: 'txHash must be a 0x 32-byte hash — no verdict for a malformed hash.' });
      try {
        const proof = await (deps.verifyTxHash || verifyTxHash)({ txHash });
        return json(res, 200, { proof,
          note: proof.paid ? 'Confirmed on Base — re-verify at ' + proof.explorer + '. ' + DISCLAIMER
            : 'NOT a confirmed USDC payment (' + (proof.reason || 'unpaid') + '). ' + DISCLAIMER });
      } catch (e) { return oops(res, 502, 'chain read failed', e); }
    }

    // GET /parse-qr?text=… — P2P: validate a SCANNED QR into a payment target (Base USDC only, fail-closed).
    // The phone scans a QR (camera), sends the decoded text here, and gets back a safe recipient + amount —
    // so two people with the app pay each other directly, wallet-to-wallet.
    if (req.method === 'GET' && url.pathname === '/parse-qr') {
      const parsed = parsePaymentQR(url.searchParams.get('text') || '');
      return json(res, parsed.valid ? 200 : 422, { parsed, note: DISCLAIMER });
    }

    // GET /receive?address=0x…[&amountUsd=] — P2P: the EIP-681 a user SHOWS to receive USDC (with an amount
    // it prefills the payer's app; without, the payer enters it). Refuses a non-0x address.
    if (req.method === 'GET' && url.pathname === '/receive') {
      const address = String(url.searchParams.get('address') || '');
      try { return json(res, 200, { paymentURI: receiveURI({ address, amountUsd: url.searchParams.get('amountUsd') }), address: address.toLowerCase() }); }
      catch (e) { return oops(res, 400, 'could not build the receive URI — check address/amount', e); }
    }

    json(res, 404, { error: 'not found' });
  });
}

module.exports = { build };
if (require.main === module) {
  build().listen(PORT, () => console.log(`BIII server → http://127.0.0.1:${PORT} · merchant ${MERCHANT || '(set BIII_MERCHANT)'}`));

  /* The counter is useless if it only lives as long as one container. "Has anyone EVER called this" is the
   * question, and a redeploy answering "no" by amnesia is the wrong kind of honest.
   *
   * Flushed on a timer rather than per request — a payment endpoint should not do a synchronous disk write to
   * record that it was called. `unref` so this interval never holds the process open on its own. */
  const flushEvery = Number(process.env.BIII_USAGE_FLUSH_MS || 60000);
  if (flushEvery > 0) setInterval(() => USAGE.flush(), flushEvery).unref();

  /* LE RADAR TOURNE ICI PARCE QUE LA MACHINE QUI LE PORTAIT S'ETEINT. Mesure du 2026-08-09 sur
   * `data/token-radar/blackouts.json`: 68,9 % de couverture, 101,2 h aveugles sur 325,5 h, HUIT trous
   * dont les quatre derniers de 11 a 22 h. Le lanceur local le dit lui-meme — « Close them to stop ». Un tiers des
   * lancements n'etait jamais vu, et le `/mcp` de ce meme service servait le snapshot fige au dernier
   * deploiement, puisque `bin/biii-mcp.js` lit la base du radar.
   *
   * ⛔ INERTE SANS `RADAR_TICK_MINUTES`, et il DIT lequel des deux cas il est. Le module force le radar
   * dans un processus ENFANT avec un timeout: il partage ce conteneur avec l'endpoint payant, et un OOM
   * ou une boucle de sa part ne peut pas avoir le droit de couper l'encaissement. */
  /* Le retour etait JETE, donc `/health` ne pouvait rien en dire. Il porte l'etat vivant du collecteur;
   * on le publie au niveau processus pour que le handler y accede sans changer la signature de `build`. */
  globalThis.__biiiRadarEtat = RADAR.startRadarTicks().etat;

  // A container is stopped, not closed politely, so the last minute of counts is written on the way out.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { USAGE.flush(); } catch { /* nothing left to save it with */ } process.exit(0); });
  }
}
