# BIII Agent-Merchant Quickstart — « Ton agent se fait payer en 4 lignes »

## L'idée en une phrase

**Un agent IA (ou un petit marchand sans banque) reçoit un paiement USDC sur Base avec juste une paire de clés — aucune entité légale, aucun KYC, aucun compte à ouvrir.**

## Contraste explicite

| Rails classiques (Stripe, PayPal, banques) | BIII (ce que vous pouvez faire) |
|---|---|
| ❌ Il faut une entreprise enregistrée | ✅ **Juste une paire de clés Ethereum** |
| ❌ KYC / AML / vérification d'identité | ✅ **Aucune vérification d'identité** |
| ❌ Compte bancaire ou PSP obligatoire | ✅ **Le wallet de l'agent = destination finale** |
| ❌ Frais 1.5–3% + hold 7–14 jours | ✅ **Coût réseau Base (~$0.01) + verdict BIII** |
| ❌ Chargebacks possibles | ✅ **Règlement on-chain final, sans retour** |

## Ton agent se fait payer en 4 lignes

```javascript
// 1. Ton agent génère sa propre clé (pas d'entité, pas de banque)
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const account = privateKeyToAccount(generatePrivateKey());

// 2. Il crée une charge USDC sur Base (pour n'importe quel montant)
const charge = require('./lib/till').createCharge({
  to: account.address, amountUsd: '4.50', label: 'AI task'
});

// 3. Il donne l'intent EIP-681 au payeur (QR universel)
const uri = require('./lib/till').paymentURI(charge);
// → "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x...&uint256=4500000"

// 4. Une fois payé, il vérifie la chaîne et imprime le reçu
const verdict = require('./lib/till').verifyPayment(charge, fact);
const receipt = require('./lib/till').receipt(charge, verdict);
```

## Lancer l'exemple complet

```bash
# Installer viem (si ce n'est pas déjà fait)
npm install viem

# Lancer la démo agent-merchant
node examples/agent-merchant.js
```

La démo simule un paiement et imprime :
- L'intent EIP-681 valide (`USDC@8453/transfer?address=<agent>&uint256=<micro>`)
- Le verdict `paid=true` sur le fact simulé
- Le reçu avec `txHash` + lien BaseScan

## Ce que ça prouve

1. **L'exclu des rails** (agent IA, marchand sans KYC) peut se faire payer
2. **Règlement ≠ verdict** : `createCharge`/`paymentURI` n'appellent JAMAIS `trust.js`
3. **Non-custodial** : BIII ne tient aucune clé, ne bouge aucun fonds
4. **Reçu re-vérifiable** : ancré au `txHash`, consultable par tous sur BaseScan

## Pour aller plus loin

- **Intégration MCP** : utilisez `bin/biii-mcp.js` (stdio) pour appeler `till_create_charge` → `till_check_payment` → `till_receipt` depuis n'importe quel agent
- **Paiement réel** : configurez `BASE_RPC_URL` pour lire les vrais transferts USDC sur Base via `findPayment()`
- **Facturation Web2** : voir `lib/invoice.js` pour des factures avec numéro, lignes, échéance

## Garde-fous (honnétes limites)

- **Non-custodial** : BIII n'est pas une banque, un PSP, ou un transmetteur d'argent
- **Pas de KYC/AML** : c'est au marchand de respecter ses obligations fiscales/sanctions
- **Verdict advisory** : le trust triangle est une aide à la décision, pas un conseil juridique
- **Settlement final** : pas de chargeback, pas de réversion — la chaîne décide

Voir aussi : `PILOT.md`, `PRICING.md`, `lib/disclaimer.js`
