#!/usr/bin/env node
'use strict';
/**
 * examples/agent-merchant.js — BIII quickstart : « agent-IA se fait payer »
 * ========================================================================
 * DÉMO : un agent IA (sans entité légale, sans banque, sans KYC) génère sa propre
 * paire de clés, crée une charge USDC sur Base, imprime l'intent EIP-681, simule
 * un paiement on-chain, vérifie le règlement et imprime le reçu.
 *
 * PRÉREQUIS : npm install viem (ou ajouter viem aux devDependencies)
 * LANCEMENT  : node examples/agent-merchant.js
 *
 * Ce script prouve la thèse BIII : un exclu des rails classiques (agent IA, petit
 * marchand sans KYC) peut se faire payer sur SON PROPRE wallet, avec un verdict
 * advisory + un reçu re-vérifiable.
 */

const T = require('../lib/till');
const L = require('../lib/ledger');
const { DISCLAIMER } = require('../lib/disclaimer');

// ─── 1. GÉNÉRATION DE LA CLÉ AGENT (viem) ────────────────────────────────────
// L'agent n'a QU'une paire de clés — pas d'entité, pas de banque, pas de KYC.
async function main() {
  console.log('=== BIII AGENT-MERCHANT DEMO ===\n');
  console.log('THÈSE : un agent IA sans identité légale peut se faire payer sur sa propre clé.\n');
  console.log('DISCLAIMER (honnétes limites) :');
  console.log(DISCLAIMER);
  console.log('\n' + '─'.repeat(70) + '\n');

  let agentAddress;
  try {
    // viem est optionnel — si absent, on utilise une clé de test (ne PAS utiliser en prod)
    const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    agentAddress = account.address;
    console.log('[1] Clé jetable générée (viem) :');
    console.log('    Agent address =', agentAddress);
    console.log('    (Ceci est la SEULE identité de l\'agent — pas d\'entité légale, pas de KYC)\n');
  } catch (err) {
    // Fallback : adresse de test (Base USDC faucet / test known address)
    agentAddress = '0x1234567890123456789012345678901234567890';
    console.log('[1] viem non disponible — utilisation d\'une adresse de démo :');
    console.log('    Agent address =', agentAddress);
    console.log('    (Installez viem pour générer une vraie clé : npm install viem)\n');
  }

  // ─── 2. CRÉATION DE LA CHARGE (createCharge + paymentURI) ──────────────────
  console.log('[2] Création de la charge (createCharge) :');
  const charge = T.createCharge({
    to: agentAddress,
    amountUsd: '4.50',
    label: 'Agent service — AI task completion',
    nowMs: Date.now(),
  });
  console.log('    Charge ID  :', charge.id);
  console.log('    Montant    :', charge.amountUsd, 'USDC');
  console.log('    Destinataire:', charge.to, '(le wallet PROPRE de l\'agent)');
  console.log('    Token      : USDC @ Base (chainId', charge.chainId + ')');
  console.log('    ⚠️  createCharge n\'appelle JAMAIS trust.js — règlement ≠ verdict\n');

  const uri = T.paymentURI(charge);
  console.log('[3] Intent EIP-681 (paymentURI) — à scanner par le payeur :');
  console.log('    ' + uri);
  console.log('    (Compatible MetaMask, Coinbase Wallet, Rainbow, Trust…)\n');
  console.log('    Le payeur paie directement sur le wallet de l\'agent — BIII ne tient aucune clé.\n');

  // ─── 3. SIMULATION DU PAIEMENT (fact chaîne fabriqué) ─────────────────────
  console.log('[4] Simulation du paiement on-chain (fact fabriqué pour la démo) :');
  // En production : lire le vrai transfert via findPayment (lib/chain.js) si BASE_RPC_URL est set
  const simulatedFact = {
    txHash: '0x' + 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890',
    chainId: 8453,
    token: T.USDC_BASE,
    to: agentAddress,
    valueMicro: charge.amountMicro,
    confirmations: 12,
    blockTime: Math.floor(Date.now() / 1000),
    from: '0x0987654321098765432109876543210987654321',
  };
  console.log('    txHash      :', simulatedFact.txHash.slice(0, 20) + '…');
  console.log('    Confirmations:', simulatedFact.confirmations, '(final)');
  console.log('    Montant reçu:', T.microToUsd(simulatedFact.valueMicro), 'USDC\n');

  // ─── 4. VÉRIFICATION (verifyPayment) ───────────────────────────────────────
  console.log('[5] Vérification field-for-field (verifyPayment) :');
  const verdict = T.verifyPayment(charge, simulatedFact);
  console.log('    paid       :', verdict.paid);
  console.log('    tier      :', verdict.tier || '—');
  console.log('    txHash    :', verdict.txHash ? verdict.txHash.slice(0, 20) + '…' : '—');
  console.log('    from      :', verdict.from ? verdict.from.slice(0, 10) + '…' : '—');
  if (verdict.overpaidMicro && BigInt(verdict.overpaidMicro) > 0n) {
    console.log('    pourboire :', T.microToUsd(verdict.overpaidMicro), 'USDC (l\'agent garde)');
  }
  console.log('');

  if (!verdict.paid) {
    console.error('❌ Paiement NON vérifié :', verdict.reason);
    process.exit(1);
  }

  // ─── 5. REÇU (receipt + renderReceipt) ────────────────────────────────────
  console.log('[6] Reçu chain-anchored (receipt + renderReceipt) :\n');
  const rec = T.receipt(charge, verdict, { merchantName: 'Agent IA #42' });
  const rendered = L.renderReceipt(rec, { number: 1 });
  console.log(rendered);
  console.log('\nLien basescan :', rec.explorer);
  console.log('(Re-vérifiable par quiconque sur https://basescan.org)\n');

  // ─── 6. RÉCAPITULATIF DE LA THÈSE ─────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('THÈSE BIII PROUVÉE :');
  console.log('  ✅ Agent SANS identité légale (clé fraîche) = payee valide');
  console.log('  ✅ Pas de compte à ouvrir, pas de KYC, pas de banque');
  console.log('  ✅ Le règlement (charge/paymentURI) est DÉCOUPLÉ du verdict (trust.js)');
  console.log('  ✅ BIII ne tient aucune clé, ne bouge aucun fonds');
  console.log('  ✅ Reçu ancré au txHash — re-vérifiable par tous');
  console.log('═'.repeat(70));
  console.log('\nPour un vrai paiement : configurez BASE_RPC_URL et utilisez findPayment()');
  console.log('pour lire le transfert on-chain réel au lieu du fact simulé.\n');
}

main().catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
