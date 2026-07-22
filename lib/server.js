'use strict';
/**
 * BIII server — the thin HTTP surface the merchant PWA (and any client) talks to.
 * ==============================================================================
 * Non-custodial by construction: the merchant address is configured by the operator
 * (BIII_MERCHANT), the server holds no key and moves no funds. It only: mints a charge +
 * EIP-681 URI, and reports what the CHAIN says about a charge (lib/chain + lib/till verify).
 *
 *   GET  /                      → health (merchant configured?, chain reachable is lazy)
 *   POST /charge {amountUsd,label} → { charge, paymentURI }        (create a payment request)
 *   GET  /status?to=&amountMicro=&lookback= → { verdict, fact }    (has the chain paid it?)
 *   GET  /receipt?to=&amountUsd=&name= → { receipt } | { error }   (verified receipt)
 *   GET  /trust?address=0x…[&resourceUrl=] → { vet }               (LOCAL safe-to-pay verdict — one fetch,
 *        no MCP: the known-bad screen + this node's trust-core classifier + floor provenance, fail-closed.
 *        Pure-local (no chain, no oracle call) so any web app can embed it as a pre-payment check.)
 *   GET  /asset?token=0x…[&claimedIssuer=&claimedSymbol=] → { verdict }  (is a TOKENIZED-ASSET contract the
 *        GENUINE issuer's or an impersonator? genuine/impersonation/unsafe/unknown, fail-closed — a pre-trade
 *        authenticity check any web page can embed and re-verify on-chain.)
 * CORS-open for reads so a static PWA on any origin can poll; loopback-safe otherwise.
 * Run: BIII_MERCHANT=0x… node lib/server.js   (PORT default 4700)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./till');
const { findPayment } = require('./chain');
const { vetLocal, loadFloor } = require('./vet');
const { assessAsset, assetVertex } = require('./asset');
const { DISCLAIMER } = require('./disclaimer');

// The verified-issuer registry (data/rwa-registry.json — built by scripts/biii-rwa-registry.js), loaded
// ONCE like the known-bad floor. Absent ⇒ assessAsset falls back to its seed; a stale/missing file can
// only UNDER-verify (a non-registry token reads 'unknown', never a false 'genuine'). Same file the MCP uses.
function loadAssetRegistry(file) {
  const p = file || path.join(__dirname, '..', 'data', 'rwa-registry.json');
  try { if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return { entries: j.entries, source: j.generatedFrom || 'file' }; } } catch {}
  return { entries: null, source: null };
}

const PORT = Number(process.env.PORT) || 4700;
const MERCHANT = (process.env.BIII_MERCHANT || '').toLowerCase();

// Serve the merchant PWA SAME-ORIGIN so the phone app and its API share one URL (open the server URL
// on the phone → the till loads and polls itself; no hardcoded host, no cross-origin config).
const WEB_DIR = path.join(__dirname, '..', 'web');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/qrcode.min.js': 'qrcode.min.js', '/manifest.json': 'manifest.json',
  '/embed.js': 'embed.js', '/embed-demo.html': 'embed-demo.html' };
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
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
  // When a merchant is configured, it is FIXED: a caller can't redirect a charge/verdict/receipt to another
  // address (the single-merchant till the product promises). Only a no-merchant server honors a caller `to`.
  const forceMerchant = (caller) => merchant || String(caller || '').toLowerCase();
  // Bound the lookback window by how long THIS charge has been open (~2s Base blocks + skew buffer), so a
  // PRIOR/unrelated transfer to the merchant can't satisfy a freshly-created charge (the false-PAID bug).
  const boundLookback = (createdAtMs, raw) => {
    let lb = Math.min(900, Math.max(1, Number(raw) || 900));
    if (createdAtMs > 0) { const ageSec = Math.max(0, (Date.now() - createdAtMs) / 1000); lb = Math.min(lb, Math.ceil(ageSec / 2) + 6); }
    return lb;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'biii', merchantConfigured: /^0x[0-9a-f]{40}$/.test(merchant),
        note: 'non-custodial: this server holds no key and moves no funds' });
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
        return json(res, 200, { charge, paymentURI: T.paymentURI(charge) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const to = forceMerchant(url.searchParams.get('to'));
      const amountMicro = url.searchParams.get('amountMicro');
      if (!/^0x[0-9a-f]{40}$/.test(to)) return json(res, 400, { error: 'no merchant address' });
      if (!/^\d+$/.test(String(amountMicro)) || BigInt(amountMicro) <= 0n) return json(res, 400, { error: 'amountMicro must be a positive integer' });
      try {
        const lookback = boundLookback(Number(url.searchParams.get('createdAtMs')) || 0, url.searchParams.get('lookback'));
        const fact = await find({ to, minMicro: amountMicro, lookbackBlocks: lookback });
        const charge = { to, amountMicro, amountUsd: T.microToUsd(amountMicro), token: T.USDC_BASE, chainId: 8453 };
        return json(res, 200, { verdict: T.verifyPayment(charge, fact), fact: fact || null });
      } catch (e) { return json(res, 502, { error: 'chain read failed: ' + e.message }); }
    }

    // GET /trust — the LOCAL safe-to-pay verdict as ONE fetch, for any web app (no MCP needed). Pure-local:
    // known-bad screen (decisive) + trust-core classifier (this node's judgment) + floor provenance. Fail-
    // closed: malformed address ⇒ 400 (no verdict for garbage); floor absent ⇒ "UNAVAILABLE", never "clean".
    if (req.method === 'GET' && url.pathname === '/trust') {
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return json(res, 400, { error: 'address must be a 0x Base address (40 hex) — no verdict for a malformed address.' });
      const resourceUrl = url.searchParams.get('resourceUrl') || undefined;
      const vet = vetLocal(address, { resourceUrl, knownBad, ...(trustCore !== undefined ? { tc: trustCore } : {}) });
      return json(res, 200, { vet, note: 'LOCAL verdict (this node\'s floor + classifier, no oracle). ' + DISCLAIMER });
    }

    // GET /asset — is a TOKENIZED-ASSET contract the GENUINE issuer's, or an impersonator? One fetch, any
    // web page (a pre-trade authenticity check a user can re-verify). genuine / impersonation / unsafe /
    // unknown, fail-closed: a non-registry token reads 'unknown' (never a false 'genuine'); malformed → 400.
    if (req.method === 'GET' && url.pathname === '/asset') {
      const token = String(url.searchParams.get('token') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) return json(res, 400, { error: 'token must be a 0x contract address (40 hex) — no verdict for a malformed contract.' });
      const verdict = assessAsset(
        { token, claimedIssuer: url.searchParams.get('claimedIssuer'), claimedSymbol: url.searchParams.get('claimedSymbol') },
        assetReg.entries ? { registry: assetReg.entries } : {});
      return json(res, 200, { verdict, triangleReputation: assetVertex(verdict),
        registrySource: assetReg.entries ? `${assetReg.source} · ${assetReg.entries.length} contracts` : 'seed only',
        disclosure: 'ADVISORY, fail-closed: genuine = the contract matches a VERIFIED issuer address in the registry; impersonation/unknown never read as safe. Re-verify the contract on Basescan — a verdict is a pointer to the chain, not a badge to trust.',
        note: DISCLAIMER });
    }

    if (req.method === 'GET' && url.pathname === '/receipt') {
      const to = forceMerchant(url.searchParams.get('to'));
      try {
        const charge = T.createCharge({ to, amountUsd: url.searchParams.get('amountUsd'), label: url.searchParams.get('label'), nowMs: Date.now() });
        const lookback = boundLookback(Number(url.searchParams.get('createdAtMs')) || 0, url.searchParams.get('lookback'));
        const fact = await find({ to, minMicro: charge.amountMicro, lookbackBlocks: lookback });
        const verdict = T.verifyPayment(charge, fact);
        if (!verdict.paid) return json(res, 404, { error: verdict.reason });
        return json(res, 200, { receipt: T.receipt(charge, verdict, { merchantName: url.searchParams.get('name') }) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    json(res, 404, { error: 'not found' });
  });
}

module.exports = { build };
if (require.main === module) {
  build().listen(PORT, () => console.log(`BIII server → http://127.0.0.1:${PORT} · merchant ${MERCHANT || '(set BIII_MERCHANT)'}`));
}
