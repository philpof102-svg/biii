# BIII — x402 distribution (meet real buyers)

BIII is a **live production x402 service** on Base — discovery at
[`/openapi.json`](https://biii-production.up.railway.app/openapi.json), paid verdicts at
`POST /x402/vet-asset` and `/x402/vet-address` ($0.25 USDC, payTo the merchant wallet, non-custodial).
Getting it in front of paying agents = the "structure must meet the market" move.

## Where it's listed / can be listed

| Venue | What it is | Status |
| --- | --- | --- |
| **[awesome-agentic-commerce](https://github.com/Merit-Systems/awesome-agentic-commerce)** | Curated x402 ecosystem list (Ecosystem section) | ✅ **PR #502 open** |
| **[Onyx Bazaar](https://onyx-actions.onrender.com/bazaar)** | Free leaderboard of every paid x402 service, **indexed via Coinbase CDP discovery** (refresh 15 min) | ⏳ auto-lists once a real on-chain **settle** exists (see below) |
| **Coinbase Agent.market** | Coinbase's directory of x402 services (7 categories) | ⏳ CDP registration — Phil's gesture (CDP account) |
| **[gold-402](https://github.com/Haustorium12/gold-402)** | Curated x402 directory (24K Labs), verified badges; also sources from CDP Bazaar + Agentic.market | ⏳ submit / auto via CDP catalog after a settle |
| **[x402.org/ecosystem](https://www.x402.org/ecosystem)** | Official x402 ecosystem directory | ⏳ submit |
| **lawbor bazaar** (ours) | Our own agent bazaar (`lawbor_offer`) | ⏳ post an offer — Phil signs the envelope |

## Correction (2026-07-23): a settlement does NOT auto-index us

**First real settle DONE** — tx `0x4be3f98d…c80bd3`, $0.25 USDC on Base → merchant, redeemed an
`impersonation` verdict live; replay refused (`409`). The paid path is **proven end-to-end in prod.**

But an earlier assumption here was **wrong and is retracted**: a settlement does **not** make BIII
appear on the CDP-indexed venues automatically. Why — BIII's x402 verifies the payment **directly
on-chain** (`verifyTxHash` → Base RPC), by design **non-custodial, with no CDP facilitator in the loop**.
The CDP x402 discovery only surfaces settlements it **observes through the Coinbase facilitator**; ours
never touch it, so CDP has no record to index. (And Onyx Bazaar is a top-100-by-volume board — a
one-call service wouldn't show there regardless.) Verified: not listed on Onyx Bazaar after the settle.

**What actually gets us listed (explicit, honest):**
- **Curated lists that invite entries** — `awesome-agentic-commerce` (PR #502, already open). This is the
  real, no-hype channel.
- **The hosted MCP endpoint + the MCP registry** (`DISTRIBUTION-mcp.md`) — `/mcp` is live now; the npm
  `biii-mcp` is registry-ready (publish = one tag). The MCP registry is what agent hosts actually index.
- **Only if we want the CDP venues**: either register BIII's `/openapi.json` with the CDP discovery
  explicitly, or route settlements through the CDP facilitator — the latter trades away part of our
  facilitator-less, non-custodial posture, so it's a deliberate choice, not a freebie.

## Mesure du 2026-08-15 — ce qui est tranché, et ce qui reste

La ligne « soit enregistrer `/openapi.json`, soit passer par le facilitateur »
laissait croire à deux options. **Il n'y en a qu'une.** La spec bazaar est
explicite :

> *« Cataloging happens when a facilitator processes a `PaymentPayload` that
> includes the echoed `bazaar` extension. **A server-side declaration alone
> catalogs nothing** if no paying client echoes it. »*

Il n'existe pas de chemin « enregistrer son OpenAPI » : la chaîne est
**déclaration serveur → écho par le client → traitement par un facilitateur →
catalogue**. Vérifié empiriquement — le catalogue CDP
(`api.cdp.coinbase.com/platform/v2/x402/discovery/resources`, endpoint **public**,
sans clé) contient 1 200 ressources, et ni `biii-production` ni l'adresse
marchande n'y figurent.

### Le coût réel n'est pas celui qu'on croyait

Cette note disait que passer par le facilitateur « sacrifie une partie de la
posture non-custodial ». Les 2 119 entrées `accepts` du catalogue portent toutes
`extra: {name: "USD Coin", version: "2"}` — le domaine EIP-712 de l'USDC, donc
de l'EIP-3009 `transferWithAuthorization` : **le payeur signe, le facilitateur
diffuse, les fonds vont du payeur au `payTo` directement.** Le facilitateur ne
détient jamais rien.

Ce qu'on perd est donc *facilitator-less*, **pas** *non-custodial*. Deux
propriétés distinctes, et une seule est en jeu. À confirmer en lisant le code du
scheme `exact` avant de trancher, mais l'écart de coût est important.

### Deux défauts trouvés au passage, dont un qui dépasse le listing

1. **`extra` était absent du 402.** Sans le domaine EIP-712, un client x402
   standard **ne peut pas signer** — il ignore quel `domainSeparator` utiliser.
   Présent sur 1 659 des 1 665 entrées EVM du catalogue (99,6 %). Ce n'était pas
   un défaut de vitrine mais d'interopérabilité : BIII était impayable par tout
   client générique. **Corrigé** (additif, corps v1 inclus).
2. **`network: "base"`** au lieu du CAIP-2 `"eip155:8453"` : 7 entrées sur 2 119
   utilisent notre forme. **Corrigé dans la déclaration v2 seulement** — changer
   le corps v1 est une rupture de contrat, elle se décide à part.

### Fait

Le 402 porte désormais un en-tête `payment-required` (base64 d'un
`PaymentRequired` v2 : `resource` en objet, `accepts` en CAIP-2 avec `extra`,
`extensions.bazaar` avec `info.input`/`info.output`), **à côté** du corps v1
inchangé. Gabarit relevé sur Tavily, service réellement catalogué, pas déduit de
la doc. Vérifié sur le vrai serveur HTTP, les trois routes, en-tête de ~1,1 Ko.
16 cas dans `test/bazaar-declaration.test.js`, dont un qui garde le corps v1.

### Reste

Un règlement passant par un facilitateur, avec un client qui ré-émet
l'extension. C'est la seule étape qui engage des fonds et la posture : décision
d'exploitation, pas de code. Ensuite,
`GET /discovery/resources?payTo=0xa6cf…` doit renvoyer BIII, et agentic.market
indexe automatiquement — sa FAQ le dit : *« If your service/endpoints are indexed
on the Bazaar, you'll automatically show up on agentic.market »*, aucune
inscription.

### Ce que ça vaut, sans enjoliver

Marché mesuré le même jour : 50 services, 46 583 appels sur 30 jours, dont
**58 % pour Tavily seul** et 94 % pour les cinq premiers. Dans la queue, Arkham
fait 471 appels/mois, CoinMarketCap 105, et BlackSwan — le seul concurrent sur
le créneau risque — **3**. À 0,25 $ l'appel, un BIII performant comme Arkham
rapporterait ~118 $/mois. **Ce chantier achète une position, pas un revenu.**

## Anti-hype / posture
Every listing describes only what BIII does (fail-closed, non-custodial, re-verifiable on-chain). No
inflated numbers, no promo spam — only curated lists that invite service entries.
