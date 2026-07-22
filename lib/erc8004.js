'use strict';
/**
 * BIII × ERC-8004 — the agent-reputation standard as a SEPARATE, re-verifiable lens.
 * ================================================================================================
 * ERC-8004 ("Trustless Agents", Base mainnet 2026) is the dominant agent-identity + reputation standard
 * (Identity / Reputation / Validation registries). Its ReputationRegistry exposes an ON-CHAIN read:
 *   getSummary(uint256 agentId, address[] clients, string tag1, string tag2)
 *       → (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
 * Unlike MainStreet (oracle-REPORTED), this signal is re-checkable on Base by anyone — so BIII treats it
 * as INTEROP, never a rival, exactly the strategy in COMPETITION.md ("a corner of the triangle can read
 * ERC-8004/Skyfire").
 *
 * THE CATCH (why it is advisory, never payable-deciding): feedback is CLIENT-submitted, so a raw
 * all-clients summary is SYBIL-FARMABLE — an agent can have its own sybil clients rate it 5/5. getSummary
 * accepts a `clients` filter, so the ONLY trustworthy ERC-8004 reputation is one filtered to clients you
 * already trust. This lens therefore: (1) stays SEPARATE, never merged into a single score; (2) is
 * ADVISORY — it can inform, it never lowers the fail-closed known-bad floor nor auto-clears a payable;
 * (3) carries the sybil caveat unless the caller attests a trusted-client filter; (4) ships a re-verify
 * pointer so the reader re-checks getSummary on Base — trust the chain, not this field.
 *
 * Pure/deterministic/offline. This file holds the JUDGMENT over a getSummary result; the live read (ABI
 * encoding of getSummary needs a keccak selector + a verified registry address) is a documented next step,
 * NOT claimed here — BIII applies the honest lens to a supplied summary and always points to re-verify.
 */

// Claimed-canonical ERC-8004 registries on Base (source: avisradar/oracle.js, "verified on Basescan").
// Treat as a DEFAULT to re-verify against your own deployment — not independently confirmed here.
const ERC_8004_BASE = {
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  chainId: 8453,
};

function reVerifyPointer(agentId, registry) {
  if (agentId == null) return null;
  return {
    registry: registry || ERC_8004_BASE.reputationRegistry,
    agentId: String(agentId),
    chain: 'Base(' + ERC_8004_BASE.chainId + ')',
    method: 'getSummary(uint256,address[],string,string)',
    note: 'call getSummary yourself and re-check — trust the chain, not this field',
  };
}

/**
 * erc8004Lens — turn a ReputationRegistry.getSummary result into an honest, SEPARATE, advisory lens.
 *   summary: { count, summaryValue, summaryValueDecimals } (the getSummary tuple) — or null/absent.
 *   opts.agentId: the ERC-8004 agentId (for the re-verify pointer).
 *   opts.trustedClientsOnly: caller attests the summary was filtered to clients THEY trust (drops the
 *     sybil caveat — a stronger, but still advisory, signal).
 *   opts.registry: override the registry address (else the claimed-canonical Base default).
 * Returns a lens object; never throws.
 */
function erc8004Lens(summary, { agentId = null, trustedClientsOnly = false, registry } = {}) {
  const reVerify = reVerifyPointer(agentId, registry);
  const id = agentId == null ? null : String(agentId);

  if (!summary || summary.count == null) {
    return { available: false, agentId: id,
      disclosure: 'ERC-8004 reputation not read (no summary supplied / agentId unresolved) — the absence of a rating is never trust.',
      reVerify };
  }

  const count = Math.max(0, Math.floor(Number(summary.count) || 0));
  const decimals = Math.max(0, Math.floor(Number(summary.summaryValueDecimals) || 0));
  const rawVal = summary.summaryValue == null ? null : Number(summary.summaryValue);
  const value = (rawVal == null || !Number.isFinite(rawVal)) ? null : rawVal / Math.pow(10, decimals);

  if (count === 0) {
    return { available: true, status: 'none', count: 0, value: null, agentId: id,
      disclosure: 'ERC-8004: no on-chain feedback for this agent yet — unverified, not proven safe. Absence is never trust.',
      reVerify };
  }

  return {
    available: true, status: 'reported', count, value, decimals, agentId: id,
    // advisory ALWAYS: this lens informs, it never lowers the known-bad floor nor auto-clears a payable.
    advisory: true,
    sybilCaveat: !trustedClientsOnly,
    disclosure: 'ERC-8004 on-chain feedback: ' + count + ' rating(s)'
      + (value != null ? ', summary value ' + value : '') + '. '
      + (trustedClientsOnly
          ? 'Filtered to clients you trust — a stronger signal, still advisory (never overrides the known-bad floor).'
          : 'From ALL clients — feedback is client-submitted and SYBIL-FARMABLE (an agent can have its own sybils rate it), so ADVISORY only, never proof; filter to trusted clients for a real signal.')
      + ' Re-verify on Base with getSummary.',
    reVerify,
  };
}

module.exports = { erc8004Lens, reVerifyPointer, ERC_8004_BASE };
