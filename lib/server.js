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
const { loadAssetRegistry } = require('./asset-registry');   // issuer-verified (green) merged over aggregator (teal)
const { DISCLAIMER } = require('./disclaimer');
const { buildOpenApi, challenge402, priceMicro } = require('./openapi');   // AgentCash/x402 discovery + paid verdicts
const { settleOnce } = require('./x402-settle');   // single-use + freshness: one payment = one verdict (anti-replay)
const { rateLimit } = require('./ratelimit');   // per-IP cap so a caller can't hammer the RPC-calling routes into a DoS
const { handleRpc: mcpHandleRpc } = require('../bin/biii-mcp');   // the SAME MCP dispatch the stdio server uses, served over HTTP at /mcp
const { shouldRoute, startBackgroundScan } = require('./biii-router');   // BIII safe-to-pay router (USDC filter)

const PORT = Number(process.env.PORT) || 4700;
const MERCHANT = (process.env.BIII_MERCHANT || '').toLowerCase();

// Serve the merchant PWA SAME-ORIGIN so the phone app and its API share one URL (open the server URL
// on the phone → the till loads and polls itself; no hardcoded host, no cross-origin config).
const WEB_DIR = path.join(__dirname, '..', 'web');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/qrcode.min.js': 'qrcode.min.js', '/manifest.json': 'manifest.json',
  '/embed.js': 'embed.js', '/embed-demo.html': 'embed-demo.html', '/radar.html': 'radar.html', '/p2p.html': 'p2p.html', '/vet-meme.html': 'vet-meme.html',
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
const oops = (res, code, category, e) => {
  try { console.error('[biii]', category, '·', (e && (e.stack || e.message)) || e); } catch { /* logging must never throw */ }
  return json(res, code, { error: category });
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

  // TRUST RADAR — a rolling, in-memory log of the /asset + /trust checks this node served, so the server
  // itself keeps the "brief" history (no Telegram, no external delivery — the history lives here). Capped;
  // per-instance; addresses are public data. deps.radarStore injectable for tests.
  const RADAR_MAX = 300;
  const radar = deps.radarStore || [];
  const logCheck = (rec) => { radar.push({ t: Date.now(), ...rec }); if (radar.length > RADAR_MAX) radar.splice(0, radar.length - RADAR_MAX); };
  // issuer-verified coverage for the radar brief (which issuers/chains this node can authenticate).
  const issuerVerified = deps.issuerVerified || (() => { try { const p = path.join(__dirname, '..', 'data', 'issuer-verified.json'); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).entries || []; } catch {} return []; })();

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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'biii', merchantConfigured: /^0x[0-9a-f]{40}$/.test(merchant),
        note: 'non-custodial: this server holds no key and moves no funds' });
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
        for (const one of (batch ? msg : [msg])) { const r = await mcpHandleRpc(one); if (r) out.push(r); }
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
      } catch (e) { return oops(res, 400, 'could not create the charge — check amount/label', e); }
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
        const verdict = assessAsset(
          { token, claimedIssuer: url.searchParams.get('claimedIssuer'), claimedSymbol: url.searchParams.get('claimedSymbol') },
          assetReg.entries ? { registry: assetReg.entries } : {});
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
      return json(res, 200, buildOpenApi({ origin, merchant, contactEmail: process.env.BIII_CONTACT_EMAIL }));
    }

    // POST /x402/vet-asset | /x402/vet-address | /x402/vet-meme — the PAID verdicts. BIII is the MERCHANT that RECEIVES USDC;
    // it signs nothing. Unpaid probe → a real 402 challenge (per the spec, BEFORE any body validation). Paid →
    // settle with BIII's OWN on-chain verifyTxHash (paid TO the merchant, ≥ price), then return the verdict.
    if (req.method === 'POST' && (url.pathname === '/x402/vet-asset' || url.pathname === '/x402/vet-address' || url.pathname === '/x402/vet-meme')) {
      const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || '');
      if (!/^0x[0-9a-f]{40}$/.test(merchant)) return json(res, 503, { error: 'merchant (payTo) not configured — this node cannot accept x402 payments' });
      const proofTx = String(req.headers['x-payment'] || url.searchParams.get('paymentTx') || '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(proofTx)) {                    // unpaid → 402 challenge (probe reaches here before any body check)
        const { headers, body } = challenge402({ origin, merchant });
        res.writeHead(402, headers); return res.end(JSON.stringify(body));
      }
      try {
        const proof = await (deps.verifyTxHash || verifyTxHash)({ txHash: proofTx });
        const need = priceMicro(process.env.BIII_VET_PRICE_USD || '0.25');
        // one confirmed USDC payment TO the merchant, ≥ price, FRESH, redeems EXACTLY ONE verdict —
        // without this a single $0.002 tx (or any old qualifying transfer) replays into unlimited verdicts.
        const settled = settleOnce({ proof, merchant, needMicro: need });
        if (!settled.ok) {
          const { headers, body } = challenge402({ origin, merchant });
          res.writeHead(settled.code, headers); return res.end(JSON.stringify({ ...body, error: settled.reason }));
        }
        const b = await readBody(req);
        if (url.pathname === '/x402/vet-meme') {
          const result = await vetMeme({ symbol: b.symbol, chainId: b.chainId ? Number(b.chainId) : undefined, address: b.address, fetchImpl: deps.fetchImpl });
          logCheck({ kind: 'meme', q: b.symbol || b.address || '?', verdict: result.status, flag: result.status === 'impersonation' || result.status === 'ambiguous' });
          return json(res, 200, { ...result, paid: { txHash: proof.txHash }, note: 'paid vet-meme (x402). ' + DISCLAIMER });
        }
        const address = String(b.address || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return json(res, 400, { error: 'address must be a 0x Base address (40 hex)' });
        if (url.pathname === '/x402/vet-asset') {
          const verdict = assessAsset({ token: address, claimedIssuer: b.claimedIssuer, claimedSymbol: b.claimedSymbol }, assetReg.entries ? { registry: assetReg.entries } : {});
          logCheck({ kind: 'asset', q: address, verdict: verdict.status, flag: verdict.status === 'impersonation' || verdict.status === 'unsafe' });
          return json(res, 200, { verdict, paid: { txHash: proof.txHash }, note: 'paid vet (x402). ' + DISCLAIMER });
        }
        const vet = vetLocal(address, { resourceUrl: b.resourceUrl, knownBad, ...(trustCore !== undefined ? { tc: trustCore } : {}) });
        logCheck({ kind: 'trust', q: address, verdict: vet.screen.blocked ? 'blocked' : 'not-known-bad', flag: vet.screen.blocked });
        return json(res, 200, { vet, paid: { txHash: proof.txHash }, note: 'paid vet (x402). ' + DISCLAIMER });
      } catch (e) { return oops(res, 502, 'settlement read failed', e); }
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
        coverage: { issuerVerified: issuerVerified.length, chains: Object.keys(byChain).length, byChain, byIssuer,
          floor: { addresses: floor.count ?? 0, asOf: floor.asOf || null, stale: floor.stale === true } },
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
}
