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

const PRICE_USD = () => (process.env.BIII_VET_PRICE_USD || '0.25');             // decimal USD, per the spec (see PRICING.md: the verdict corridor per PRICING.md — receipt tier is $0.03)

/**
 * priceMicro — USD decimal -> USDC atomic (6dp) for x402 `accepts[]`.
 *
 * ═══ CE QUE `Math.round(Number(usd) * 1e6)` LAISSAIT PASSER, MESURE LE 2026-07-27 ═══
 *   'abc'        -> "NaN"        publie tel quel dans accepts[].amount ET dans x-payment-info
 *   '-5'         -> "-5000000"   un montant NEGATIF dans un defi de paiement
 *   '1e3'        -> "1000000000" 1000 $ l'appel, sur une simple notation exponentielle
 *   '0.0000005'  -> "1" cote accepts, "0.000000" cote x-payment-info: DEUX prix publies qui se
 *                  contredisent pour le meme appel
 *
 * Le negatif n'est pas cosmetique. `x402-settle.settleOnce` fait `BigInt(String(needMicro))`, et
 * `BigInt("-5000000")` est parfaitement valide: le test `paidMicro < priceNeed` devient alors faux pour
 * TOUT paiement, y compris un micro-USDC. Une coquille dans BIII_VET_PRICE_USD rendait l'endpoint payant
 * gratuit, en silence. ("NaN", lui, fait jeter BigInt et settleOnce echoue en 402 — fail-closed, mais en
 * accusant le paiement du client alors que la faute est dans NOTRE configuration.)
 *
 * `till.usdToMicro` fait deja ce travail et refuse les trois formes. Ce module l'importait deja pour
 * USDC_BASE et reimplementait la conversion a cote — la variante lache etant celle branchee sur l'argent.
 * On delegue desormais, et on JETTE plutot que de publier un prix qu'on ne sait pas lire: un prix illisible
 * est une erreur d'exploitation, pas une valeur.
 */
function priceMicro(usd) {
  try {
    return String(T.usdToMicro(String(usd)));
  } catch (e) {
    throw new Error('BIII_VET_PRICE_USD is not a payable amount (' + JSON.stringify(String(usd)) + '): '
      + e.message + ' — a price this node cannot read must never be published or settled against');
  }
}

/** The OpenAPI 3.1 discovery document AgentCash reads at /openapi.json. */
function buildOpenApi({ origin, merchant, contactEmail, priceUsd } = {}) {
  /* Les DEUX chiffres publies descendent du meme micro valide. Avant, `x-payment-info` passait par
   * `Number(price).toFixed(6)` et `accepts[].amount` par `Math.round(... * 1e6)`: sur un prix sous le
   * micro ils rendaient "0.000000" et "1", deux prix differents pour le meme appel dans deux documents
   * que le meme client lit. Une seule source, une seule verite. */
  const micro = priceMicro(priceUsd || PRICE_USD());
  const pay = {
    price: { mode: 'fixed', currency: 'USD', amount: T.microToUsd(micro), amountMicro: micro, asset: 'USDC' },
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
       'x-guidance': 'BEFORE paying or acquiring a token/wallet on Base: POST /x402/vet-asset with {address, claimedIssuer?, claimedSymbol?} to check a token is the genuine issuer’s (not an impersonation), POST /x402/vet-meme with {symbol, chainId?, address?} to find the REAL memecoin contract among 10+ look-alikes, or POST /x402/vet-address with {address} for a safe-to-pay / known-bad screen. Fail-closed: unknown is never "safe". Pay per call in USDC on Base; the verdict is advisory and re-verifiable on-chain.',
      contact: { email: contactEmail || 'agentcash@biii.dev' },
    },
    'x-discovery': { ownershipProofs: [] },   // filled at deploy (origin ownership proof)
    servers: origin ? [{ url: origin }] : undefined,
    paths: {
      '/x402/vet-asset': op('vet_asset', 'Is this Base token the genuine issuer\'s contract, or a look-alike?',
        { address: addrSchema, claimedIssuer: { type: 'string' }, claimedSymbol: { type: 'string' } }, ['address']),
      '/x402/vet-address': op('vet_address', 'Is this Base address safe to pay / known-bad (OFAC + scam floor)?',
        { address: addrSchema, resourceUrl: { type: 'string' } }, ['address']),
      '/x402/vet-meme': op('vet_meme', 'Which contract is the REAL memecoin among 10+ look-alikes? Fail-closed verdict from live market data.',
        /* `type: 'number'` avec l'exemple 8453 dirigeait vers la forme qui, avant le 2026-07-27, ECARTAIT
         * tous les candidats (DexScreener indexe par slug: 'base', 'solana'). Corrige dans le schema du
         * tool MCP le meme jour — et pas ici, ni dans la route payante: le document que lisent AgentCash
         * et les agents externes continuait a annoncer l'ancienne forme. Un correctif applique a un seul
         * site d'appel n'est pas applique. */
        { symbol: { type: 'string', description: 'memecoin symbol, e.g. "TOSHI"' }, chainId: { type: ['string', 'number'], description: 'optional chain filter — the DexScreener slug ("base", "solana") or an EVM chain id (8453 = Base). A chain we cannot map returns NO candidates rather than silently searching every chain.' }, address: { type: 'string', description: 'optional specific contract address to judge' } }, ['symbol']),
    },
  };
}

/** The 402 challenge body + headers (x402 `accepts` + MPP WWW-Authenticate). realm/payTo must be the PUBLIC origin/merchant. */
function challenge402({ origin, merchant, priceUsd } = {}) {
  const micro = priceMicro(priceUsd || PRICE_USD());     // jette sur un prix illisible, avant toute publication
  const usd = T.microToUsd(micro);                        // le meme chiffre, rendu en decimal — jamais recalculé
  /* PAS DE DEFI SANS DESTINATAIRE. `(merchant || '').toLowerCase()` publiait `payTo: ""` — une invitation
   * a payer sans personne a payer. La route /x402 garde deja le marchand en amont (503 si absent), donc
   * ce cas n'etait pas atteignable depuis le serveur; cette verification est la defense en profondeur, et
   * elle vaut pour tout autre appelant de cette fonction. Un defi de paiement mal forme ne doit pas
   * pouvoir EXISTER. */
  const payTo = String(merchant || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(payTo)) {
    throw new Error('challenge402 needs a valid merchant address to put in payTo — refusing to publish a '
      + 'payment challenge with no recipient (got ' + JSON.stringify(String(merchant || '')) + ')');
  }
  const accepts = [{
    scheme: 'exact', network: 'base', asset: T.USDC_BASE, amount: micro,
    payTo, maxTimeoutSeconds: 600,
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
