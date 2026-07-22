'use strict';
/**
 * Shared tokenized-asset registry loader — one source, many mouths (server /asset + MCP till_vet_asset).
 * ================================================================================================
 * Two layers, merged by address with the stronger one winning:
 *   1. data/issuer-verified.json — COMMITTED, small, each entry sourced from an ISSUER-OFFICIAL / open
 *      authoritative source (a source string that provenanceOf() reads as 'issuer-official' → the green
 *      "issuer-verified" badge). This is the curated, spot-checkable trust set.
 *   2. data/rwa-registry.json — GENERATED (gitignored), aggregator-sourced (Coingecko, source
 *      "coingecko:*" → provenanceOf() 'aggregator' → the weaker teal "listed" badge).
 * issuer-verified wins by address, so an aggregator entry is UPGRADED to issuer-official once verified.
 * Absent files degrade safely: no registry ⇒ {entries:null} ⇒ assessAsset falls back to its seed
 * (a non-registry token reads 'unknown', never a false 'genuine'). Fail-closed by construction.
 */
const fs = require('node:fs'), path = require('node:path');
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(p) { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} return null; }

/** loadAssetRegistry({dir?}) → { entries: [...]|null, source: string|null }. dir injectable for tests. */
function loadAssetRegistry({ dir = DATA_DIR } = {}) {
  const issuer = readJson(path.join(dir, 'issuer-verified.json'));
  const agg = readJson(path.join(dir, 'rwa-registry.json'));
  const issuerEntries = Array.isArray(issuer && issuer.entries) ? issuer.entries : [];
  const aggEntries = Array.isArray(agg && agg.entries) ? agg.entries : [];
  if (!issuerEntries.length && !aggEntries.length) return { entries: null, source: null };

  // merge by address: aggregator first, then issuer-official OVERRIDES (verified wins).
  const byAddr = new Map();
  for (const e of aggEntries) { const k = String(e && e.address || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(k)) byAddr.set(k, e); }
  for (const e of issuerEntries) { const k = String(e && e.address || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(k)) byAddr.set(k, e); }
  const entries = [...byAddr.values()];

  // source is a clean PROVENANCE descriptor (no counts — the caller reports entries.length, which is the
  // deduped total, so a "620 (537 contracts)" mismatch can't happen).
  const parts = [];
  if (issuerEntries.length) parts.push('issuer-official');
  if (aggEntries.length) parts.push(agg.generatedFrom || 'aggregator');
  return { entries, source: parts.join(' + ') };
}

module.exports = { loadAssetRegistry };
