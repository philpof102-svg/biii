'use strict';
// prepare-buy — non-custodial, vetted, capped buy intent. Offline. Run: node test/prepare-buy.test.js
const assert = require('node:assert');
const { prepareBuy } = require('../lib/prepare-buy');
const { loadFloor } = require('../lib/vet');
const { loadAssetRegistry } = require('../lib/asset-registry');

const floor = loadFloor();
const registry = loadAssetRegistry().entries || [];
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('BIII prepare-buy — non-custodial, vetted, capped (agent prepares, the operator wallet executes):');

const clean = '0x' + 'a1'.repeat(20);
const daapl = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';           // Dinari dAAPL (issuer-verified)
const knownBad = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';        // on the OFAC/known-bad floor

t('clean recipient + genuine token → ok: a capped EIP-681 intent, BIII signs nothing', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', maxUsd: '10', token: daapl, claimedIssuer: 'Dinari', registry, floor });
  assert.equal(r.ok, true);
  assert.match(r.intent.paymentURI, /^ethereum:.*@8453\/transfer\?address=.*uint256=5000000$/);
  assert.equal(r.intent.capUsd, 10);
  assert.equal(r.assetVerdict.status, 'genuine');
  assert.match(r.disclosure, /signs nothing/);
});

t('recipient is KNOWN-BAD → hard refuse, no intent offered', () => {
  const r = prepareBuy({ to: knownBad, amountUsd: '5', floor, registry });
  assert.equal(r.ok, false);
  assert.equal(r.recipientVerdict, 'known-bad');
  assert.ok(!r.intent, 'no intent is built for a known-bad recipient');
});

t('token is an IMPERSONATION (dAAPL claimed BlackRock) → hard refuse', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', token: daapl, claimedIssuer: 'BlackRock', registry, floor });
  assert.equal(r.ok, false);
  /* ⚠️ MEME CLE, DEUX FORMES — et ce fichier le prouvait tout seul: la ligne 24 lit
   * `r.assetVerdict.status` sur le chemin qui reussit, celle-ci lisait `r.assetVerdict` comme une
   * CHAINE sur le refus. Un appelant suivant la forme documentee par le succes recevait `undefined` au
   * moment precis ou il devait lire un verdict. Aucun commentaire ne tranchait: c'etait un accident, pas
   * un choix. Les deux branches rendent desormais le meme objet. */
  assert.equal(r.assetVerdict.status, 'impersonation');
  assert.equal(r.assetVerdict.safeToAcquire, false);
});

/* ── LA NUANCE DOIT ARRIVER JUSQU A L ACHETEUR ─────────────────────────────────────────────────────
 * `assessAsset` accusait d usurpation sur la seule correspondance d EMETTEUR (corrige le 2026-07-28),
 * donc un autre produit legitime du meme emetteur etait BLOQUE ici par une accusation fausse. Le
 * retrecissement le laisse passer — correctement — et ces cas sont ce qui empeche « passe » de se lire
 * comme « rien a signaler »: `safeToAcquire` reste false, et `issuerKnown` dit ou aller verifier. */

t('★ un produit inconnu d un emetteur CONNU passe, mais le DIT', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', token: '0x' + '99'.repeat(20),
    claimedIssuer: 'Dinari', claimedSymbol: 'INEXISTANT', registry, floor });
  assert.equal(r.ok, true, 'bloquer ici serait accuser sur notre propre incompletude');
  assert.equal(r.assetVerdict.status, 'unknown');
  assert.equal(r.assetVerdict.safeToAcquire, false, 'passer n est PAS une recommandation');
  assert.equal(r.assetVerdict.issuerKnown, true, 'c est la difference decidable');
});

t('★ un emetteur totalement inconnu est DISTINGUABLE du precedent', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', token: '0x' + '99'.repeat(20),
    claimedIssuer: 'JamaisVu', claimedSymbol: 'XYZ', registry, floor });
  assert.equal(r.ok, true);
  assert.equal(r.assetVerdict.status, 'unknown');
  assert.equal(r.assetVerdict.issuerKnown, false, 'sinon les deux « unknown » se confondent');
});

t('LES DEUX BORNES: la forme de `assetVerdict` est la MEME sur les deux branches', () => {
  const refuse = prepareBuy({ to: clean, amountUsd: '5', token: daapl, claimedIssuer: 'BlackRock', registry, floor });
  const passe = prepareBuy({ to: clean, amountUsd: '5', token: daapl, claimedIssuer: 'Dinari', registry, floor });
  assert.equal(refuse.ok, false); assert.equal(passe.ok, true);
  for (const k of ['status', 'provenance', 'safeToAcquire', 'issuerKnown', 'reason']) {
    assert.ok(k in refuse.assetVerdict, 'refus: clé manquante ' + k);
    assert.ok(k in passe.assetVerdict, 'succès: clé manquante ' + k);
  }
});

t('over the cap → refuse (never prepare a buy above the cap)', () => {
  assert.equal(prepareBuy({ to: clean, amountUsd: '50', maxUsd: '10', floor, registry }).ok, false);
});

t('malformed recipient / non-positive amount → refuse', () => {
  assert.equal(prepareBuy({ to: 'nope', amountUsd: '5', floor }).ok, false);
  assert.equal(prepareBuy({ to: clean, amountUsd: '0', floor }).ok, false);
});

/* ═══ « ON N'A PAS PU SCREENER » NE DOIT PAS SORTIR EN « PAS KNOWN-BAD » ═══
 *
 * `screenAddress` rend trois etats et nomme le troisieme dans sa propre raison — « no known-bad list
 * loaded — screening UNAVAILABLE, not a clean verdict ». `prepareBuy` ne lisait que `blocked`, donc une
 * liste absente donnait `blocked === false` et le chemin allait jusqu'a publier
 * `recipientVerdict: 'not-known-bad'`: une AFFIRMATION sur le destinataire fabriquee par notre propre
 * incapacite a regarder, sur la fonction qui construit une intention de paiement.
 *
 * C'est le miroir de « ne jamais accuser sur sa propre incompletude » — ici on ABSOUT, ce qui est pire
 * sur ce chemin. Le plancher se passe en parametre, donc le cas se reproduit sans aucun montage. */
t('★ plancher known-bad ABSENT → refuse, et ne prononce jamais « not-known-bad »', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', registry });      // aucun `floor` fourni
  assert.equal(r.ok, false, 'sans screen possible, on ne prepare pas un achat');
  assert.equal(r.recipientVerdict, 'unscreened', 'l etat doit etre NOMME, pas absent');
  assert.notEqual(r.recipientVerdict, 'not-known-bad', 'une absence de liste n absout personne');
  assert.match(r.reason || '', /UNAVAILABLE/i, 'la raison doit nommer le manque');
  assert.match(r.reason || '', /NOTHING WAS CONSUMED/i, 'un refus doit dire que la mise est intacte');
  assert.equal(r.intent, undefined, 'aucune intention de paiement ne doit etre construite');
});

/* Le cas OPPOSE, sans lequel le precedent passerait aussi sur un code qui refuserait TOUT: avec un
 * plancher charge, l affirmation est meritee — et elle porte desormais sa provenance, sinon un
 * « not-known-bad » ne peut etre ni date ni contredit par un lecteur. */
t('★ plancher charge → l affirmation est meritee ET auditable', () => {
  const r = prepareBuy({ to: clean, amountUsd: '5', floor, registry });
  assert.equal(r.ok, true);
  assert.equal(r.recipientVerdict, 'not-known-bad');
  assert.equal(r.recipientScreen && r.recipientScreen.available, true);
  assert.ok(r.recipientScreen && typeof r.recipientScreen.basis === 'string' && r.recipientScreen.basis.length > 0,
    'la base du verdict (source + date de la liste) doit voyager avec lui');
});

t('un destinataire KNOWN-BAD reste refuse — le nouveau garde n a pas remplace l ancien', () => {
  const r = prepareBuy({ to: knownBad, amountUsd: '5', floor, registry });
  assert.equal(r.ok, false);
  assert.equal(r.recipientVerdict, 'known-bad', 'et il se distingue de « unscreened »');
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
