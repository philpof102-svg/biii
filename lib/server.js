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
 * CORS-open for reads so a static PWA on any origin can poll; loopback-safe otherwise.
 * Run: BIII_MERCHANT=0x… node lib/server.js   (PORT default 4700)
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./till');
const { findPayment } = require('./chain');
const { vetLocal, loadFloor } = require('./vet');
const { assessAsset, assetVertex } = require('./asset');
const { loadAssetRegistry } = require('./asset-registry');   // issuer-verified (green) merged over aggregator (teal)
const { DISCLAIMER } = require('./disclaimer');

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
      } catch (e) { return json(res, 400, { error: e.message }); }
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
      } catch (e) { return json(res, 502, { error: 'chain read failed: ' + e.message }); }
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
        return json(res, 200, { vet, note: 'LOCAL verdict (this node\'s floor + classifier, no oracle). ' + DISCLAIMER });
      } catch (e) { return json(res, 500, { error: 'trust read failed: ' + e.message }); }   // fail-closed: an error is never a clean verdict
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
        return json(res, 200, { verdict, triangleReputation: assetVertex(verdict),
          registrySource: assetReg.entries ? `${assetReg.source} · ${assetReg.entries.length} contracts` : 'seed only',
          disclosure: 'ADVISORY, fail-closed: genuine = the contract matches a VERIFIED issuer address in the registry; impersonation/unknown never read as safe. Re-verify the contract on Basescan — a verdict is a pointer to the chain, not a badge to trust.',
          note: DISCLAIMER });
      } catch (e) { return json(res, 500, { error: 'asset read failed: ' + e.message }); }   // fail-closed: an error is never 'genuine'
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
      } catch (e) { return json(res, 502, { error: 'chain read failed: ' + e.message }); }
    }

    json(res, 404, { error: 'not found' });
  });
}

module.exports = { build };
if (require.main === module) {
  build().listen(PORT, () => console.log(`BIII server → http://127.0.0.1:${PORT} · merchant ${MERCHANT || '(set BIII_MERCHANT)'}`));
}
