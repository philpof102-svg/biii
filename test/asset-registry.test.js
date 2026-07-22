'use strict';
// Shared asset-registry loader — committed issuer-verified (green) merged OVER generated aggregator (teal),
// issuer-official winning by address. Fixture dir, offline. Run: node test/asset-registry.test.js
const assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadAssetRegistry } = require('../lib/asset-registry');
const { assessAsset } = require('../lib/asset');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// a throwaway data dir with the two registry files
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-reg-'));
const write = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj));
const ADDR = '0x' + '1a'.repeat(20);
const OTHER = '0x' + '2b'.repeat(20);

console.log('BIII asset-registry loader — issuer-verified merged over aggregator:');

t('absent files ⇒ entries:null (assessAsset falls back to seed — never a false genuine)', () => {
  const r = loadAssetRegistry({ dir: path.join(DIR, 'nope') });
  assert.equal(r.entries, null);
});

t('aggregator only ⇒ its entries, source labeled aggregator', () => {
  write('rwa-registry.json', { generatedFrom: 'coingecko (free)', entries: [{ issuer: 'Ondo', symbol: 'OUSG', address: OTHER, source: 'coingecko:ondo' }] });
  const r = loadAssetRegistry({ dir: DIR });
  assert.equal(r.entries.length, 1);
  assert.match(r.source, /coingecko \(free\)/);
  assert.equal(assessAsset({ token: OTHER }, { registry: r.entries }).provenance, 'aggregator');
});

t('issuer-verified OVERRIDES the aggregator entry for the same address → provenance issuer-official (green)', () => {
  write('rwa-registry.json', { generatedFrom: 'coingecko (free)', entries: [{ issuer: 'Backed', symbol: 'AAPLx', address: ADDR, source: 'coingecko:apple-xstock' }] });
  write('issuer-verified.json', { entries: [{ issuer: 'Backed', symbol: 'AAPLx', name: 'Apple xStock', address: ADDR, source: 'https://backed.fi official tokenlist', verifiedAt: '2026-07-22' }] });
  const r = loadAssetRegistry({ dir: DIR });
  assert.equal(r.entries.length, 1, 'same address merges to ONE entry, not two');
  const v = assessAsset({ token: ADDR }, { registry: r.entries });
  assert.equal(v.status, 'genuine');
  assert.equal(v.provenance, 'issuer-official', 'the verified entry wins → the strong green');
  assert.match(r.source, /issuer-official/);
});

t('issuer-verified + a DISTINCT aggregator entry ⇒ both present, each keeps its own provenance', () => {
  write('rwa-registry.json', { generatedFrom: 'coingecko (free)', entries: [{ issuer: 'Ondo', symbol: 'OUSG', address: OTHER, source: 'coingecko:ondo' }] });
  write('issuer-verified.json', { entries: [{ issuer: 'Backed', symbol: 'AAPLx', address: ADDR, source: 'https://backed.fi official' }] });
  const r = loadAssetRegistry({ dir: DIR });
  assert.equal(r.entries.length, 2);
  assert.equal(assessAsset({ token: ADDR }, { registry: r.entries }).provenance, 'issuer-official');
  assert.equal(assessAsset({ token: OTHER }, { registry: r.entries }).provenance, 'aggregator');
});

t('issuer-verified ONLY (no aggregator file) ⇒ ships green with zero Coingecko dependency', () => {
  fs.rmSync(path.join(DIR, 'rwa-registry.json'));
  const r = loadAssetRegistry({ dir: DIR });
  assert.equal(r.entries.length, 1);
  assert.equal(assessAsset({ token: ADDR }, { registry: r.entries }).provenance, 'issuer-official');
});

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
