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
 * CORS-open for reads so a static PWA on any origin can poll; loopback-safe otherwise.
 * Run: BIII_MERCHANT=0x… node lib/server.js   (PORT default 4700)
 */
const http = require('node:http');
const T = require('./till');
const { findPayment } = require('./chain');

const PORT = Number(process.env.PORT) || 4700;
const MERCHANT = (process.env.BIII_MERCHANT || '').toLowerCase();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

/** Build the server. deps.findPayment / deps.merchant injectable for tests (no network). */
function build(deps = {}) {
  const find = deps.findPayment || findPayment;
  const merchant = (deps.merchant || MERCHANT || '').toLowerCase();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, { ok: true, service: 'biii', merchantConfigured: /^0x[0-9a-f]{40}$/.test(merchant),
        note: 'non-custodial: this server holds no key and moves no funds' });
    }

    if (req.method === 'POST' && url.pathname === '/charge') {
      const b = await readBody(req);
      const to = (b.to || merchant);
      try {
        const charge = T.createCharge({ to, amountUsd: b.amountUsd, label: b.label, orderId: b.orderId, nowMs: Date.now() });
        return json(res, 200, { charge, paymentURI: T.paymentURI(charge) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const to = (url.searchParams.get('to') || merchant).toLowerCase();
      const amountMicro = url.searchParams.get('amountMicro') || '0';
      if (!/^0x[0-9a-f]{40}$/.test(to)) return json(res, 400, { error: 'no merchant address' });
      try {
        const fact = await find({ to, minMicro: amountMicro, lookbackBlocks: Number(url.searchParams.get('lookback')) || 900 });
        const charge = { to, amountMicro, amountUsd: T.microToUsd(amountMicro), token: T.USDC_BASE, chainId: 8453 };
        return json(res, 200, { verdict: T.verifyPayment(charge, fact), fact: fact || null });
      } catch (e) { return json(res, 502, { error: 'chain read failed: ' + e.message }); }
    }

    if (req.method === 'GET' && url.pathname === '/receipt') {
      const to = (url.searchParams.get('to') || merchant).toLowerCase();
      try {
        const charge = T.createCharge({ to, amountUsd: url.searchParams.get('amountUsd'), label: url.searchParams.get('label'), nowMs: Date.now() });
        const fact = await find({ to, minMicro: charge.amountMicro, lookbackBlocks: Number(url.searchParams.get('lookback')) || 900 });
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
