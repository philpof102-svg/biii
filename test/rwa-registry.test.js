'use strict';
// BIII RWA registry ingest — joins RWA.xyz /v4/tokens ⋈ /v4/assets, fail-safe.
// Run: node test/rwa-registry.test.js
const assert = require('node:assert');
const { buildRegistry, fetchAll, toChainId, buildRegistryFromCoingecko,
  ingestFromCoingecko, ingestRegistry } = require('../scripts/biii-rwa-registry');
const { assessAsset } = require('../lib/asset');

/* ⚠️ CE HARNAIS NE SE COMPTAIT PAS LUI-MEME — mesure du 2026-07-29 sur la version commitee:
 *   « 7 passed · 0 failed », exit 0 ... pour un fichier qui contenait HUIT cas.
 * `tA` etait appele SANS `await`, et le `process.exit` final s'executait avant que la promesse ne se
 * resolve. Le seul cas couvrant fetchAll (pagination, en-tete Bearer, rejet sans cle) n'a donc jamais
 * tourne — ce qui explique pourquoi la troncature a `maxPages` a survecu jusqu'ici: son test etait mort,
 * et un test mort ressemble exactement a un test vert. Les promesses sont desormais COLLECTEES et
 * attendues, et le total est compare a un nombre attendu. */
let pass = 0, fail = 0;
const enCours = [];
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const tA = (n, fn) => { enCours.push((async () => {
  try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
})()); };

const BUIDL_ETH = '0x' + '11'.repeat(20);
const BUIDL_BASE = '0x' + '22'.repeat(20);
const USDY_BASE = '0x' + '33'.repeat(20);
const ORPHAN = '0x' + '44'.repeat(20);
// real v4 shapes: tokens carry the address+network+asset_id; assets carry name+issuer_name+ticker
const TOKENS = [
  { address: BUIDL_ETH, network_name: 'Ethereum', asset_id: 'a1', ticker: 'BUIDL' },
  { address: BUIDL_BASE, network_name: 'Base', asset_id: 'a1' },              // ticker falls back to the asset's
  { address: USDY_BASE, network_name: 'Base', asset_id: 'a2', ticker: 'USDY' },
  { address: 'NotAnEvmAddress', network_name: 'Solana', asset_id: 'a3' },     // dropped: bad addr + off-chain
  { address: '0xshort', network_name: 'Base', asset_id: 'a4' },               // dropped: malformed addr
  { address: ORPHAN, network_name: 'Base', asset_id: 'zz' },                  // dropped: no asset → no symbol
];
const ASSETS = [
  { id: 'a1', name: 'BlackRock USD Institutional Digital Liquidity', issuer_name: 'BlackRock', ticker: 'BUIDL' },
  { id: 'a2', name: 'Ondo US Dollar Yield', issuer_name: 'Ondo', ticker: 'USDY' },
];

console.log('BIII RWA registry ingest — tokens⋈assets join, validated, fail-safe:');

t('buildRegistry JOINS tokens→assets, mapping address · chain (network_name) · symbol · issuer', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [1, 8453, 42161] });
  assert.equal(entries.length, 3);
  const usdy = entries.find((e) => e.address === USDY_BASE);
  assert.equal(usdy.issuer, 'Ondo'); assert.equal(usdy.symbol, 'USDY'); assert.equal(usdy.chainId, 8453);
  const bxBase = entries.find((e) => e.address === BUIDL_BASE);
  assert.equal(bxBase.symbol, 'BUIDL');   // token had no ticker → fell back to the joined asset's
  assert.equal(bxBase.issuer, 'BlackRock'); assert.equal(bxBase.source, 'rwa.xyz');
});

t('FAIL-SAFE: off-chain (Solana), malformed-address, and unjoinable (no symbol) tokens are dropped', () => {
  const { entries, dropped } = buildRegistry(TOKENS, ASSETS, { chains: [1, 8453, 42161] });
  assert.ok(!entries.some((e) => e.address === '0xshort' || e.address === ORPHAN));
  assert.ok(dropped >= 3);
});

t('FAIL-SAFE: a schema mismatch yields an EMPTY registry — never a wrong address', () => {
  assert.equal(buildRegistry([{ foo: 'bar' }], []).entries.length, 0);
  assert.equal(buildRegistry(null, null).entries.length, 0);
  assert.equal(buildRegistry([{ address: BUIDL_ETH, network_name: 'Ethereum', asset_id: 'x' }], []).entries.length, 0); // no asset → no symbol → dropped
});

t('chain filter narrows to the wanted chains (Base-only)', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [8453] });
  assert.ok(entries.every((e) => e.chainId === 8453));
  assert.equal(entries.length, 2);   // BUIDL-base + USDY-base
});

t('toChainId maps network_name strings and ids, rejects off-chain/unknown', () => {
  assert.equal(toChainId('Base'), 8453);
  assert.equal(toChainId('Ethereum'), 1);
  assert.equal(toChainId('Ethereum Mainnet'), 1);
  assert.equal(toChainId('Arbitrum One'), 42161);
  assert.equal(toChainId(8453), 8453);
  assert.equal(toChainId('Solana'), null);
  assert.equal(toChainId('bogus'), null);
});

t('a built registry composes with assessAsset — genuine + impersonation', () => {
  const { entries } = buildRegistry(TOKENS, ASSETS, { chains: [8453] });
  const g = assessAsset({ token: USDY_BASE, claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(g.status, 'genuine'); assert.equal(g.issuer, 'Ondo');
  const imp = assessAsset({ token: '0x' + 'ff'.repeat(20), claimedSymbol: 'USDY' }, { registry: entries });
  assert.equal(imp.status, 'impersonation'); assert.equal(imp.genuineAddress, USDY_BASE);
});

t('buildRegistryFromCoingecko (FREE source): maps platforms→chainId exactly, joins issuer, drops off-chain', () => {
  const members = new Map([
    ['ondo-google', { issuer: 'Ondo', category: 'ondo-tokenized-assets' }],
    ['dinari-aapl', { issuer: 'Dinari', category: 'dinari' }],
  ]);
  const platformList = [
    { id: 'ondo-google', symbol: 'googlon', name: 'Google (Ondo)', platforms: { ethereum: BUIDL_ETH, solana: 'SoLaNaAddr', 'optimistic-ethereum': USDY_BASE } },
    { id: 'dinari-aapl', symbol: 'daapl', name: 'Apple dShare', platforms: { base: BUIDL_BASE } },
    { id: 'not-rwa', symbol: 'x', name: 'x', platforms: { ethereum: ORPHAN } },   // not in members → ignored
  ];
  const { entries } = buildRegistryFromCoingecko(members, platformList, { chains: [1, 8453, 42161, 10] });
  const eth = entries.find((e) => e.address === BUIDL_ETH);
  assert.equal(eth.chainId, 1); assert.equal(eth.issuer, 'Ondo'); assert.equal(eth.symbol, 'GOOGLON');  // uppercased
  const opt = entries.find((e) => e.address === USDY_BASE);
  assert.equal(opt.chainId, 10, 'optimistic-ethereum must map to 10, NOT 1 (no fuzzy-match)');
  assert.equal(entries.find((e) => e.address === BUIDL_BASE).chainId, 8453);  // base
  assert.ok(!entries.some((e) => e.address === ORPHAN), 'a coin not in the RWA categories is ignored');
  assert.ok(!entries.some((e) => String(e.address).includes('sol')), 'Solana platform dropped');
});

tA('fetchAll sends the Bearer key, uses the v4 query= param, paginates, returns the flattened array', async () => {
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization });
    const q = JSON.parse(decodeURIComponent((url.match(/query=([^&]+)/) || [])[1] || '{}'));
    const page = q.pagination && q.pagination.page;
    const full = { data: Array.from({ length: 100 }, (_, i) => ({ address: '0x' + String(i).padStart(40, '0') })) };
    const last = { data: [{ address: '0xlast' }] };
    return { ok: true, json: async () => (page === 1 ? full : last) };
  };
  const all = await fetchAll('tokens', { apiKey: 'KEY123', fetchImpl: fakeFetch });
  assert.equal(all.rows.length, 101);
  assert.equal(all.hitPageCap, false, 'a short page PROVES the source is exhausted');
  assert.equal(calls.length, 2, 'stopped after the short page');
  assert.match(calls[0].auth, /Bearer KEY123/);
  assert.match(calls[0].url, /\/v4\/tokens\?query=.*pagination/i, 'uses /v4/<endpoint> with the query= param');
  await assert.rejects(() => fetchAll('assets', { apiKey: '', fetchImpl: fakeFetch }), /API_KEY required/);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * UNE LECTURE QUI ECHOUE NE DOIT PAS RESSEMBLER A UNE LECTURE VIDE.
 * Les trois cas ci-dessous ont ete MESURES en defaut le 2026-07-29 avant correction; chacun porte donc
 * sa borne d'acceptation a cote de sa borne de refus, sinon « tout marquer incomplet » les satisferait.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const rep = (o) => ({ ok: true, status: 200, json: async () => o });
const COIN = { id: 'ondo-us-dollar-yield', symbol: 'ousg', name: 'Ondo Short-Term US Gov',
  platforms: { ethereum: '0x' + 'a'.repeat(40), base: '0x' + 'b'.repeat(40) } };
const CATS = { 'ondo-tokenized-assets': 'Ondo', 'tokenized-treasuries': null };
const reseau = ({ casse = false, nonTableau = false } = {}) => async (url) => {
  if (url.includes('/coins/list')) return rep([COIN]);
  if (url.includes('category=ondo-tokenized-assets')) {
    if (casse) throw new Error('ECONNRESET');
    if (nonTableau) return rep({ error: 'rate limited' });     // derive de schema, PAS une categorie vide
    return rep([COIN]);
  }
  return rep([]);                                              // les autres categories: vraiment vides
};

tA('★ une categorie qui ECHOUE est signalee — elle ne se confond plus avec une categorie vide', async () => {
  const sain = await ingestFromCoingecko({ fetchImpl: reseau(), categories: CATS });
  const casse = await ingestFromCoingecko({ fetchImpl: reseau({ casse: true }), categories: CATS });

  // BORNE D'ACCEPTATION — un ingest sain doit se declarer COMPLET, sinon le drapeau ne dit plus rien.
  assert.equal(sain.complete, true, 'un reseau sain doit produire un registre complet');
  assert.equal(sain.failed.length, 0);
  assert.ok(sain.entries.length > 0, 'et des entrees reelles');

  // BORNE DE REFUS — la panne doit etre PORTEE dehors, pas avalee.
  assert.equal(casse.complete, false, 'un ECONNRESET ne peut pas produire un registre "complet"');
  assert.equal(casse.failed.length, 1, 'la categorie tombee doit etre nommee');
  assert.equal(casse.failed[0].category, 'ondo-tokenized-assets');
  assert.match(casse.failed[0].error, /ECONNRESET/);
  // ce qui rendait le defaut invisible: entries/seen/dropped sont IDENTIQUES a une categorie vide.
  assert.equal(casse.entries.length, 0);
  assert.equal(casse.seen, 0);
  assert.equal(casse.dropped, 0);
});

tA('★ un corps qui n\'est pas un tableau est une DERIVE DE SCHEMA, pas une categorie vide', async () => {
  const r = await ingestFromCoingecko({ fetchImpl: reseau({ nonTableau: true }), categories: CATS });
  assert.equal(r.complete, false);
  assert.match(r.failed[0].error, /not an array/i);
});

tA('★ la pagination au plafond se distingue d\'une source epuisee', async () => {
  const pleine = (n) => Array.from({ length: n }, (_, i) => ({ address: '0x' + String(i).padStart(40, '0'),
    network_name: 'base', ticker: 'T' + i, asset_id: 'a' + i }));
  const jamaisFini = async () => rep({ data: pleine(100) });
  const cap = await fetchAll('tokens', { apiKey: 'k', fetchImpl: jamaisFini, perPage: 100, maxPages: 3 });
  assert.equal(cap.rows.length, 300);
  assert.equal(cap.hitPageCap, true, 'arret au plafond: la source n\'est PAS prouvee epuisee');
  assert.equal(cap.pages, 3);

  // BORNE D'ACCEPTATION deja couverte plus haut (hitPageCap === false sur page courte), et ingestRegistry
  // doit propager le plafond jusqu'au drapeau publie.
  const ing = await ingestRegistry({ apiKey: 'k', fetchImpl: jamaisFini, perPage: 100, maxPages: 2 });
  assert.equal(ing.complete, false, 'un ingest tronque ne peut pas se declarer complet');
  assert.ok(ing.truncated.some((t) => t.endpoint === 'tokens'));
});

/* Et le maillon qui donne son poids a tout ce qui precede: ce que le registre ampute fait au VRAI
 * contrat. Sans ce cas, les drapeaux ci-dessus ne seraient que de la comptabilite. */
t('★ un contrat AUTHENTIQUE absent d\'un registre incomplet n\'est plus ACCUSE de fraude', () => {
  const ETH = '0x' + 'a'.repeat(40), BASE = '0x' + 'b'.repeat(40);
  const complet = [{ issuer: 'Ondo', symbol: 'OUSG', chainId: 1, address: ETH, source: 'coingecko:ondo' },
                   { issuer: 'Ondo', symbol: 'OUSG', chainId: 8453, address: BASE, source: 'coingecko:ondo' }];
  const ampute = [complet[0]];                        // la ligne Base a saute pendant l'ingest
  const demande = { token: BASE, claimedSymbol: 'OUSG', claimedIssuer: 'Ondo' };

  // BORNE D'ACCEPTATION — registre complet: le vrai contrat reste genuine. Sans ce cas, « ne jamais
  // rien certifier » passerait le test.
  assert.equal(assessAsset(demande, { registry: complet, registryComplete: true }).status, 'genuine');

  // La prise qui compte reste vivante: une COLLISION DE SYMBOLE sur un registre reputé complet
  // s'affirme encore comme une usurpation etablie.
  const usurpateur = assessAsset({ token: '0x' + 'c'.repeat(40), claimedSymbol: 'OUSG', claimedIssuer: 'Ondo' },
    { registry: complet, registryComplete: true });
  assert.equal(usurpateur.status, 'impersonation');
  assert.equal(usurpateur.confirmed, true, 'registre complet => l\'accusation est etablie');
  assert.ok(!/not established as complete/i.test(usurpateur.reason), 'et elle ne s\'excuse pas');

  // BORNE DE REFUS — registre ampute: on REFUSE toujours (l'argent ne bouge pas) mais on n'AFFIRME plus.
  const v = assessAsset(demande, { registry: ampute, registryComplete: false });
  assert.equal(v.safeToAcquire, false, 'fail-closed: le refus est conserve');
  assert.equal(v.confirmed, false, 'mais il n\'est PAS presente comme une fraude etablie');
  assert.match(v.reason, /not established as complete/i, 'et la raison DIT pourquoi');

  // Le troisieme etat: completude INCONNUE ne vaut pas completude PROUVEE.
  assert.equal(assessAsset(demande, { registry: ampute }).confirmed, false,
    'par defaut (registryComplete absent) on n\'accuse pas non plus');
});

/* Le chien de garde n'a PAS de .unref() : un unref laisserait Node sortir proprement sur une promesse
 * qui ne se resout jamais — exactement la panne qu'il surveille. */
const CAS_ATTENDUS = 12;
const chien = setTimeout(() => {
  console.error(`\n✗ HARNAIS BLOQUE — ${pass + fail}/${CAS_ATTENDUS} cas termines. Une promesse ne s'est jamais resolue.`);
  process.exit(1);
}, 30000);

Promise.all(enCours).then(() => {
  clearTimeout(chien);
  const total = pass + fail;
  console.log(`\n${pass} passed · ${fail} failed`);
  if (total !== CAS_ATTENDUS) {
    console.error(`✗ ${total} cas comptes pour ${CAS_ATTENDUS} attendus — un cas ne s'est pas execute. `
      + `C'est une ERREUR, pas un detail: un cas absent est indiscernable d'un cas vert.`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
});
