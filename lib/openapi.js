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
        { symbol: { type: 'string', description: 'memecoin symbol, e.g. "TOSHI"' }, chainId: { type: ['string', 'number'], description: 'optional chain filter — the DexScreener slug ("base", "solana") or an EVM chain id (8453 = Base). A chain we cannot map returns NO candidates rather than silently searching every chain.' }, address: { type: 'string', description: 'optional specific contract address to judge' }, siblingCount: { type: 'number', description: 'optional: how many sibling wallets the launch funder has paid, if YOU have traced it. Supplying it lifts the withholding on `observedRisk`. Omit it and this node checks its own observation database; omit it AND the token is unknown here, and the rate stays WITHHELD rather than guessed.' } }, ['symbol']),
    },
  };
}

/* ═══ DECLARATION BAZAAR — ce qui rend BIII CATALOGABLE, et pourquoi ═══
 *
 * Mesure du 2026-08-15 sur le catalogue reel du facilitateur CDP
 * (`GET api.cdp.coinbase.com/platform/v2/x402/discovery/resources`, 1200
 * ressources, 2119 entrees `accepts`) — c'est ce catalogue qu'agentic.market
 * indexe, et BIII n'y figure PAS (ni son domaine, ni son adresse marchande).
 *
 * La spec bazaar est explicite sur la chaine : le serveur declare dans
 * `PaymentRequired` (HTTP : en-tete `PAYMENT-REQUIRED`), le client RE-EMET cette
 * declaration dans `PaymentPayload`, et c'est le FACILITATEUR qui catalogue en
 * traitant ce payload. « A server-side declaration alone catalogs nothing. »
 * Ce qui suit fait donc le premier maillon, pas toute la chaine : sans un
 * reglement passant par un facilitateur, BIII reste hors catalogue. C'est une
 * decision d'exploitation, pas de code.
 *
 * Le gabarit ci-dessous n'est pas deduit de la doc mais RELEVE sur un service
 * reellement catalogue (Tavily, 27 116 appels/mois) : son 402 porte un en-tete
 * `payment-required` qui est le base64 d'un JSON `{x402Version: 2, error,
 * resource, accepts, extensions}`, corps minimal a cote.
 *
 * DEUX ECARTS que la mesure a revele chez BIII, au-dela du catalogue :
 *   1. `extra: {name, version}` etait ABSENT. C'est le domaine EIP-712 de
 *      l'USDC ; sans lui un client x402 standard ne peut pas construire la
 *      signature EIP-3009 — il ne sait pas quel `domainSeparator` utiliser.
 *      Present sur 1659/1665 des entrees EVM du catalogue, soit 99,6 %.
 *      Ce n'est donc pas un ornement de listing : c'est un defaut
 *      d'interoperabilite qui rend BIII impayable par un client generique.
 *   2. `network: "base"` au lieu du CAIP-2 `"eip155:8453"` : 7 entrees sur
 *      2119 utilisent la forme de BIII. Corrige ICI, dans l'en-tete v2
 *      seulement — le corps v1 garde `"base"` tant qu'un client existant
 *      pourrait le lire en dur. Un changement de contrat se decide, il ne
 *      s'attrape pas au passage.
 */
const BAZAAR_ROUTES = {
  '/x402/vet-address': {
    description: 'Safe-to-pay screen for a Base address (OFAC + scam floor). Fail-closed: unknown is never "safe".',
    input: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    output: { status: 'clear', provenance: 'on-chain + published floor', reason: 'not on any known-bad list this node carries', disclosure: 'advisory only — re-verify on-chain' },
  },
  '/x402/vet-asset': {
    description: 'Is this Base token the genuine issuer\'s contract, or a look-alike?',
    input: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', claimedIssuer: 'Circle', claimedSymbol: 'USDC' },
    output: { status: 'genuine', provenance: 'issuer-verified registry', reason: 'address matches the issuer-verified entry', disclosure: 'advisory only — re-verify on-chain' },
  },
  '/x402/vet-meme': {
    description: 'Which contract is the REAL memecoin among look-alikes? Fail-closed verdict from live market data.',
    input: { symbol: 'TOSHI', chainId: 'base' },
    output: { status: 'genuine', provenance: 'live market data', reason: 'single dominant pair on the named chain', disclosure: 'advisory only — re-verify on-chain' },
  },
};

/**
 * La declaration v2 complete, telle qu'un facilitateur l'attend, encodee en
 * base64 pour l'en-tete `payment-required`. Route inconnue -> on retombe sur le
 * prefixe `/x402` plutot que de publier une route qui n'existe pas.
 *
 * Volontairement PAS de `$ref` ni de `$id` dans les schemas : la spec rejette
 * toute reference externe (`https://`, `file://`, relative) pour empecher
 * SSRF/LFI (CWE-918). Seuls les pointeurs internes `#/...` sont admis, et le
 * plus sur est de n'en mettre aucun.
 */
function bazaarHeaderValue({ origin, payTo, micro, route }) {
  const spec = BAZAAR_ROUTES[route] || BAZAAR_ROUTES['/x402/vet-address'];
  const chemin = BAZAAR_ROUTES[route] ? route : '/x402/vet-address';
  const declaration = {
    x402Version: 2,
    error: 'payment required',
    resource: {
      url: (origin || '') + chemin,          // URL ABSOLUE — une relative est rejetee au catalogage
      description: spec.description,
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',                // CAIP-2 : la forme que 100% du catalogue utilise
      amount: micro,                         // unites atomiques, en chaine
      asset: T.USDC_BASE,
      payTo,
      maxTimeoutSeconds: 600,
      extra: { name: 'USD Coin', version: '2' },   // domaine EIP-712 de l'USDC, requis pour signer
    }],
    extensions: {
      bazaar: {
        info: {
          input: { type: 'http', method: 'POST', bodyType: 'json', body: spec.input },
          output: { type: 'json', example: spec.output },
        },
      },
    },
  };
  return Buffer.from(JSON.stringify(declaration), 'utf8').toString('base64');
}

/** The 402 challenge body + headers (x402 `accepts` + MPP WWW-Authenticate). realm/payTo must be the PUBLIC origin/merchant. */
function challenge402({ origin, merchant, priceUsd, route } = {}) {
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
    /* `extra` est ADDITIF : un client v1 qui ne le connait pas l'ignore, et un
     * client standard en a BESOIN pour signer l'autorisation EIP-3009 (c'est le
     * domaine EIP-712 de l'USDC). Son absence rendait BIII impayable par tout
     * client generique — 99,6 % des entrees EVM du catalogue CDP le portent. */
    extra: { name: 'USD Coin', version: '2' },
    resource: origin ? origin + '/x402' : '/x402', description: 'BIII trust verdict (per call)',
  }];
  const headers = {
    'content-type': 'application/json',
    'www-authenticate': `MPP realm="${origin || 'biii'}", asset="USDC", amount="${usd}"`,
    /* La declaration v2 conforme, A COTE du corps v1 — pas a sa place. Un client
     * v1 lit le corps et ne voit aucun changement ; un client v2 ou un
     * facilitateur lit cet en-tete. Ajouter une version ne doit pas en retirer
     * une autre. */
    'payment-required': bazaarHeaderValue({ origin, payTo, micro, route }),
    'access-control-allow-origin': '*',
  };
  const body = { x402Version: 1, error: 'payment required', accepts };
  return { headers, body };
}

module.exports = { buildOpenApi, challenge402, priceMicro, bazaarHeaderValue, BAZAAR_ROUTES };
