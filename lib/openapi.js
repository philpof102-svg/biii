'use strict';
/**
 * openapi.js — AgentCash / x402 discovery for BIII's paid verdict endpoints.
 * ==========================================================================
 * To be listable on AgentCash (agentcash.dev/docs/discovery) a service publishes an OpenAPI 3.1 doc at
 * GET /openapi.json whose paid operations carry `x-payment-info` (price + protocols), and returns a real
 * 402 challenge at runtime. BIII's read-only verdicts are the ideal cheap-per-call service, and BIII is the
 * MERCHANT that RECEIVES the USDC — non-custodial, it signs nothing. Settlement reuses BIII's own on-chain
 * verifyTxHash: the caller pays, presents the txHash, BIII confirms it on Base, then returns the verdict.
 *
 * Pure + dependency-free (buildOpenApi/challenge402 are data; settle() is injected verifyTxHash).
 */
const T = require('./till');

const PRICE_USD = () => (process.env.BIII_VET_PRICE_USD || '0.03');             // decimal USD, per the spec (see PRICING.md: verdict corridor is $0.25; $0.03 is the receipt tier)
const priceMicro = (usd) => String(Math.round(Number(usd) * 1e6));             // USDC atomic (6dp) for x402 accepts[]

/** The OpenAPI 3.1 discovery document AgentCash reads at /openapi.json. */
function buildOpenApi({ origin, merchant, contactEmail, priceUsd } = {}) {
  const price = String(priceUsd || PRICE_USD());
  const pay = {
    price: { mode: 'fixed', currency: 'USD', amount: Number(price).toFixed(6) },
    protocols: [{ x402: {} }, { mpp: { method: 'exact', intent: 'vet', currency: 'USDC' } }],
  };
  const addrSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'a Base (EVM) contract or wallet address' };
  const verdictSchema = { type: 'object', properties: {
    status: { type: 'string', enum: ['genuine', 'impersonation', 'unsafe', 'unknown', 'blocked', 'clear'] },
    provenance: { type: 'string' }, reason: { type: 'string' }, disclosure: { type: 'string' },
  }, required: ['status'] };
  const op = (operationId, summary, props, required) => ({
    post: {
      operationId, summary, tags: ['Trust'], 'x-payment-info': pay,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } },
      responses: {
        200: { description: 'Verdict', content: { 'application/json': { schema: verdictSchema } } },
        402: { description: 'Payment Required' },
      },
    },
  });
  return {
    openapi: '3.1.0',
    info: {
      title: 'BIII — safe-to-pay & token-genuineness verdicts on Base',
      version: '0.1.0',
      description: 'Fail-closed, non-custodial trust verdicts: is a Base token the genuine issuer’s contract or a look-alike? is a wallet known-bad? Every verdict points back to on-chain data you can re-verify. BIII holds no key and moves no funds.',
      'x-guidance': 'BEFORE paying or acquiring a token/wallet on Base: POST /x402/vet-asset with {address, claimedIssuer?, claimedSymbol?} to check a token is the genuine issuer’s (not an impersonation), or POST /x402/vet-address with {address} for a safe-to-pay / known-bad screen. Fail-closed: unknown is never "safe". Pay per call in USDC on Base; the verdict is advisory and re-verifiable on-chain.',
      contact: { email: contactEmail || 'agentcash@biii.dev' },
    },
    'x-discovery': { ownershipProofs: [] },   // filled at deploy (origin ownership proof)
    servers: origin ? [{ url: origin }] : undefined,
    paths: {
      '/x402/vet-asset': op('vet_asset', 'Is this Base token the genuine issuer’s contract, or a look-alike?',
        { address: addrSchema, claimedIssuer: { type: 'string' }, claimedSymbol: { type: 'string' } }, ['address']),
      '/x402/vet-address': op('vet_address', 'Is this Base address safe to pay / known-bad (OFAC + scam floor)?',
        { address: addrSchema, resourceUrl: { type: 'string' } }, ['address']),
    },
  };
}

/** The 402 challenge body + headers (x402 `accepts` + MPP WWW-Authenticate). realm/payTo must be the PUBLIC origin/merchant. */
function challenge402({ origin, merchant, priceUsd } = {}) {
  const usd = String(priceUsd || PRICE_USD());
  const accepts = [{
    scheme: 'exact', network: 'base', asset: T.USDC_BASE, amount: priceMicro(usd),
    payTo: (merchant || '').toLowerCase(), maxTimeoutSeconds: 600,
    resource: origin ? origin + '/x402' : '/x402', description: 'BIII trust verdict (per call)',
  }];
  const headers = {
    'content-type': 'application/json',
    'www-authenticate': `MPP realm="${origin || 'biii'}", asset="USDC", amount="${usd}"`,
    'access-control-allow-origin': '*',
  };
  const body = { x402Version: 1, error: 'payment required', accepts };
  return { headers, body };
}

module.exports = { buildOpenApi, challenge402, priceMicro };
